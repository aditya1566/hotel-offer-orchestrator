import { z } from 'zod';

/**
 * Central, validated configuration. Every value can be overridden through an
 * environment variable; defaults are tuned for `docker compose up` and local dev.
 * The process fails fast at startup if anything is malformed.
 */
const boolFromEnv = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: boolFromEnv.default(false),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().default('hoo:'),
  /** How long a complete (both suppliers answered) snapshot stays fresh. */
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  /** Shorter TTL for partial snapshots (a supplier failed) so we retry it soon. */
  PARTIAL_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(10),

  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TEMPORAL_TASK_QUEUE: z.string().default('hotel-offers'),
  /** Upper bound for a whole workflow run, as seen by the API. */
  WORKFLOW_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),

  SUPPLIER_A_URL: z.string().url().default('http://localhost:3000/supplierA/hotels'),
  SUPPLIER_B_URL: z.string().url().default('http://localhost:3000/supplierB/hotels'),
  /** Per-attempt HTTP timeout when calling a supplier. */
  SUPPLIER_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  /** Timeout used by /health when probing suppliers. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),

  /** Enables /admin/suppliers/* used to simulate outages (Postman, demos). */
  ENABLE_SUPPLIER_SIMULATION: boolFromEnv.default(true),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

let cached: AppConfig | undefined;

/** Lazily loaded singleton for entrypoints; tests should call loadConfig() directly. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
