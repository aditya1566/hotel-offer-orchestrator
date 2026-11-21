import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { NativeConnection, Runtime, Worker, type WorkerOptions } from '@temporalio/worker';
import { getConfig } from '../config';
import { createLogger } from '../logger';
import { createRedisClient } from '../redis/client';
import { RedisHotelCache } from '../redis/hotel-cache';
import { createActivities } from './activities';
import { PinoTemporalLogger } from './temporal-logger';

const logger = createLogger('hotel-offers-worker');

async function connectWithRetry(address: string, attempts = 30): Promise<NativeConnection> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await NativeConnection.connect({ address });
    } catch (err) {
      if (attempt >= attempts) throw err;
      const delay = Math.min(500 * attempt, 5_000);
      logger.warn(
        { address, attempt, delayMs: delay, err: (err as Error).message },
        'Temporal not reachable yet, retrying',
      );
      await sleep(delay);
    }
  }
}

/** Use the pre-built workflow bundle in production, bundle on the fly in dev (tsx). */
function workflowSource(): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const bundlePath = path.resolve(__dirname, '../workflow-bundle.js');
  if (existsSync(bundlePath)) {
    logger.info({ bundlePath }, 'Using pre-built workflow bundle');
    return { workflowBundle: { codePath: bundlePath } };
  }
  return { workflowsPath: require.resolve('./workflows') };
}

async function main(): Promise<void> {
  const config = getConfig();
  Runtime.install({
    logger: new PinoTemporalLogger(logger.child({ component: 'temporal-sdk' })),
  });

  const redis = createRedisClient(config.REDIS_URL, logger);
  const cache = new RedisHotelCache(redis, config.REDIS_KEY_PREFIX);

  const activities = createActivities({
    supplierUrls: { A: config.SUPPLIER_A_URL, B: config.SUPPLIER_B_URL },
    supplierTimeoutMs: config.SUPPLIER_TIMEOUT_MS,
    cache,
    cacheTtlSeconds: config.CACHE_TTL_SECONDS,
    partialCacheTtlSeconds: config.PARTIAL_CACHE_TTL_SECONDS,
  });

  const connection = await connectWithRetry(config.TEMPORAL_ADDRESS);
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    activities,
    ...workflowSource(),
  });

  logger.info(
    {
      address: config.TEMPORAL_ADDRESS,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
    },
    'Worker started',
  );

  try {
    // Resolves after SIGINT/SIGTERM once in-flight tasks have drained.
    await worker.run();
  } finally {
    await connection.close();
    redis.disconnect();
    logger.info('Worker stopped');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker crashed');
  process.exit(1);
});
