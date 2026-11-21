import { Router } from 'express';
import { SUPPLIER_IDS, SUPPLIER_NAMES, type SupplierId } from '../../domain/types';
import type { HotelCache } from '../../redis/hotel-cache';
import type { HotelOffersOrchestrator } from '../../temporal/orchestrator';

type CheckStatus = 'up' | 'down';

interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
  [extra: string]: unknown;
}

export interface HealthDeps {
  supplierUrls: Record<SupplierId, string>;
  timeoutMs: number;
  cache: HotelCache;
  orchestrator: HotelOffersOrchestrator;
  fetchImpl?: typeof fetch;
}

/**
 * GET /health       – full dependency report (both suppliers, Redis, Temporal)
 *   status "ok"       everything is up                                   -> 200
 *   status "degraded" partial service (one supplier or Redis down)       -> 200
 *   status "down"     cannot serve (Temporal down or both suppliers down) -> 503
 * GET /health/live  – liveness only (process is up), used by Docker.
 */
export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const startedAt = Date.now();
  const doFetch = deps.fetchImpl ?? fetch;

  async function timed(fn: () => Promise<Record<string, unknown> | void>): Promise<CheckResult> {
    const started = performance.now();
    try {
      const extra = await withTimeout(fn(), deps.timeoutMs);
      return {
        status: 'up',
        latencyMs: Math.round(performance.now() - started),
        ...(extra ?? {}),
      };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        error: (err as Error).message,
      };
    }
  }

  const checkSupplier = (id: SupplierId) =>
    timed(async () => {
      const res = await doFetch(deps.supplierUrls[id], {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error('Unexpected payload (expected an array of hotels)');
      return { httpStatus: res.status, hotelsAvailable: body.length };
    });

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health', async (_req, res) => {
    const [supplierResults, redis, temporal] = await Promise.all([
      Promise.all(SUPPLIER_IDS.map((id) => checkSupplier(id))),
      timed(async () => {
        await deps.cache.ping();
      }),
      timed(() => deps.orchestrator.checkHealth()),
    ]);

    const suppliers = Object.fromEntries(
      SUPPLIER_IDS.map((id, i) => [SUPPLIER_NAMES[id], { url: deps.supplierUrls[id], ...supplierResults[i]! }]),
    );
    const suppliersUp = supplierResults.filter((r) => r.status === 'up').length;

    let status: 'ok' | 'degraded' | 'down' = 'ok';
    if (temporal.status === 'down' || suppliersUp === 0) status = 'down';
    else if (suppliersUp < SUPPLIER_IDS.length || redis.status === 'down') status = 'degraded';

    res.status(status === 'down' ? 503 : 200).json({
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      suppliers,
      dependencies: { redis, temporal },
    });
  });

  return router;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
