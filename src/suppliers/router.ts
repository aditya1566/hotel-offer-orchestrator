import { Router, type Request, type Response } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import { cityKey } from '../domain/normalize';
import { SUPPLIER_NAMES, type SupplierId } from '../domain/types';
import { HttpError } from '../api/errors';
import { SUPPLIER_CATALOGUE } from './mock-data';
import { parseSupplierId, simulationUpdateSchema, type SupplierSimulation } from './simulation';

/** GET /supplierA/hotels and GET /supplierB/hotels — the two mock supplier APIs. */
export function createMockSupplierRouter(simulation: SupplierSimulation): Router {
  const router = Router();

  const handler = (supplierId: SupplierId) => async (req: Request, res: Response) => {
    const decision = simulation.next(supplierId);
    res.setHeader('X-Supplier', SUPPLIER_NAMES[supplierId]);

    if (decision.kind === 'unavailable') {
      res.status(503).json({
        error: { code: 'SUPPLIER_UNAVAILABLE', message: decision.reason },
      });
      return;
    }
    if (decision.kind === 'invalid') {
      res.status(200).json({ unexpected: 'payload', hotels: 'not-an-array' });
      return;
    }
    if (decision.delayMs > 0) await sleep(decision.delayMs);

    const city = typeof req.query.city === 'string' ? cityKey(req.query.city) : undefined;
    const hotels = SUPPLIER_CATALOGUE[supplierId].filter((h) => !city || cityKey(h.city) === city);
    res.json(hotels);
  };

  router.get('/supplierA/hotels', handler('A'));
  router.get('/supplierB/hotels', handler('B'));
  return router;
}

/**
 * Fault-injection endpoints for the mock suppliers (disabled with ENABLE_SUPPLIER_SIMULATION=false).
 * `onChange` lets the app invalidate cached snapshots so the next request sees the new behaviour.
 */
export function createSupplierAdminRouter(simulation: SupplierSimulation, onChange: () => Promise<void>): Router {
  const router = Router();

  router.get('/admin/suppliers', (_req, res) => {
    res.json(simulation.all());
  });

  router.put('/admin/suppliers/:supplierId', async (req, res) => {
    const id = parseSupplierId(String(req.params.supplierId));
    if (!id) throw new HttpError(404, 'UNKNOWN_SUPPLIER', `Unknown supplier "${req.params.supplierId}". Use A or B.`);

    const parsed = simulationUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Invalid simulation settings', parsed.error.issues);
    }
    const state = simulation.update(id, parsed.data);
    await onChange();
    res.json({ supplier: SUPPLIER_NAMES[id], ...state });
  });

  router.post('/admin/suppliers/reset', async (_req, res) => {
    simulation.reset();
    await onChange();
    res.json(simulation.all());
  });

  return router;
}
