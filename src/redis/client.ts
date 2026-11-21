import Redis from 'ioredis';
import type { Logger } from 'pino';

/**
 * Redis client tuned for a cache that must never block a request for long:
 * commands time out after 1s and are not retried across reconnects, so a Redis
 * outage degrades the API quickly instead of hanging it.
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

  let wasReady = false;
  client.on('ready', () => {
    wasReady = true;
    logger.info({ url: redactUrl(url) }, 'Redis connected');
  });
  client.on('error', (err) => {
    // ioredis emits an error on every failed reconnect; keep it at warn to avoid noise.
    logger.warn({ err: err.message }, 'Redis error');
  });
  client.on('end', () => {
    if (wasReady) logger.warn('Redis connection closed');
  });
  return client;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'redis://<invalid>';
  }
}
