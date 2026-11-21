import { createApp } from './api/app';
import { getConfig } from './config';
import { createLogger } from './logger';
import { createRedisClient } from './redis/client';
import { RedisHotelCache } from './redis/hotel-cache';
import { SupplierSimulation } from './suppliers/simulation';
import { TemporalHotelOffersOrchestrator } from './temporal/orchestrator';

const logger = createLogger('hotel-offers-api');

async function main(): Promise<void> {
  const config = getConfig();

  const redis = createRedisClient(config.REDIS_URL, logger);
  const cache = new RedisHotelCache(redis, config.REDIS_KEY_PREFIX);
  const orchestrator = new TemporalHotelOffersOrchestrator({
    address: config.TEMPORAL_ADDRESS,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowTimeoutMs: config.WORKFLOW_TIMEOUT_MS,
  });

  const app = createApp({
    logger,
    cache,
    orchestrator,
    simulation: new SupplierSimulation(),
    supplierUrls: { A: config.SUPPLIER_A_URL, B: config.SUPPLIER_B_URL },
    healthCheckTimeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
    enableSupplierSimulation: config.ENABLE_SUPPLIER_SIMULATION,
  });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening');
  });
  // Workflow runs can take a few seconds when a supplier is retried.
  server.requestTimeout = config.WORKFLOW_TIMEOUT_MS + 5_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async () => {
      await Promise.allSettled([orchestrator.close(), redis.quit()]);
      clearTimeout(force);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
