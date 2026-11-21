import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { SupplierId } from '../domain/types';
import type { HotelCache } from '../redis/hotel-cache';
import { createMockSupplierRouter, createSupplierAdminRouter } from '../suppliers/router';
import type { SupplierSimulation } from '../suppliers/simulation';
import type { HotelOffersOrchestrator } from '../temporal/orchestrator';
import { errorHandler, notFoundHandler } from './errors';
import { HotelService } from './hotel-service';
import { createHealthRouter } from './routes/health';
import { createHotelsRouter } from './routes/hotels';

export interface AppDeps {
  logger: Logger;
  cache: HotelCache;
  orchestrator: HotelOffersOrchestrator;
  simulation: SupplierSimulation;
  supplierUrls: Record<SupplierId, string>;
  healthCheckTimeoutMs: number;
  enableSupplierSimulation: boolean;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health/live' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.get('/', (_req, res) => {
    res.json({
      service: 'hotel-offer-orchestrator',
      endpoints: [
        'GET /api/hotels?city=delhi',
        'GET /api/hotels?city=delhi&minPrice=3000&maxPrice=10000',
        'GET /supplierA/hotels?city=delhi',
        'GET /supplierB/hotels?city=delhi',
        'GET /health',
        ...(deps.enableSupplierSimulation
          ? ['GET /admin/suppliers', 'PUT /admin/suppliers/:supplierId', 'POST /admin/suppliers/reset']
          : []),
      ],
    });
  });

  const service = new HotelService(deps.cache, deps.orchestrator, deps.logger.child({ component: 'hotel-service' }));
  app.use(createHotelsRouter(service));
  app.use(createMockSupplierRouter(deps.simulation));
  app.use(
    createHealthRouter({
      supplierUrls: deps.supplierUrls,
      timeoutMs: deps.healthCheckTimeoutMs,
      cache: deps.cache,
      orchestrator: deps.orchestrator,
    }),
  );

  if (deps.enableSupplierSimulation) {
    app.use(
      createSupplierAdminRouter(deps.simulation, async () => {
        // New supplier behaviour should be visible immediately, so drop cached snapshots.
        try {
          const deleted = await deps.cache.invalidateAll();
          deps.logger.info({ deleted }, 'Supplier simulation changed; cache invalidated');
        } catch (err) {
          deps.logger.warn({ err: (err as Error).message }, 'Could not invalidate cache');
        }
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
