import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { SupplierId } from '../../src/domain/types';
import { SupplierSimulation } from '../../src/suppliers/simulation';
import { AllSuppliersUnavailableError, WorkflowTimedOutError } from '../../src/temporal/orchestrator';
import { DELHI_FIXTURE, FakeOrchestrator, InMemoryHotelCache, silentLogger } from '../helpers';

describe('HTTP API', () => {
  const cache = new InMemoryHotelCache();
  const orchestrator = new FakeOrchestrator(cache, { delhi: DELHI_FIXTURE });
  const simulation = new SupplierSimulation();
  const supplierUrls: Record<SupplierId, string> = { A: '', B: '' };
  const app = createApp({
    logger: silentLogger,
    cache,
    orchestrator,
    simulation,
    supplierUrls,
    healthCheckTimeoutMs: 1_000,
    enableSupplierSimulation: true,
  });
  let server: Server;

  beforeAll(async () => {
    // /health calls the mock suppliers over real HTTP, so listen on an ephemeral port.
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    supplierUrls.A = `http://127.0.0.1:${port}/supplierA/hotels`;
    supplierUrls.B = `http://127.0.0.1:${port}/supplierB/hotels`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    cache.snapshots.clear();
    cache.failing = false;
    orchestrator.runs = [];
    orchestrator.nextError = undefined;
    orchestrator.healthy = true;
    simulation.reset();
  });

  describe('GET /api/hotels', () => {
    it('runs the workflow on a cache miss and returns the assignment response format', async () => {
      const res = await request(app).get('/api/hotels?city=delhi').expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-workflow-id']).toBe('hotel-offers-delhi');
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.body.map((h: { price: number }) => h.price)).toEqual([3200, 5340, 5900, 15000]);
      for (const h of res.body) expect(Object.keys(h).sort()).toEqual(['commissionPct', 'name', 'price', 'supplier']);
      expect(orchestrator.runs).toEqual(['delhi']);
    });

    it('serves the second request from Redis (cache HIT) without re-running the workflow', async () => {
      await request(app).get('/api/hotels?city=delhi').expect(200);
      const res = await request(app).get('/api/hotels?city=DELHI').expect(200);
      expect(res.headers['x-cache']).toBe('HIT');
      expect(orchestrator.runs).toHaveLength(1);
    });

    it('refresh=true forces a new workflow run', async () => {
      await request(app).get('/api/hotels?city=delhi').expect(200);
      const res = await request(app).get('/api/hotels?city=delhi&refresh=true').expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(orchestrator.runs).toHaveLength(2);
    });

    it('filters by price range in the cache (inclusive bounds)', async () => {
      const res = await request(app).get('/api/hotels?city=delhi&minPrice=5340&maxPrice=5900').expect(200);
      expect(res.headers['x-price-filter']).toBe('redis');
      expect(res.body.map((h: { name: string }) => h.name)).toEqual(['Holtin', 'Radison']);
    });

    it('falls back to in-memory filtering when Redis is down', async () => {
      cache.failing = true;
      const res = await request(app).get('/api/hotels?city=delhi&maxPrice=5340').expect(200);
      expect(res.headers['x-cache']).toBe('MISS');
      expect(res.headers['x-price-filter']).toBe('memory');
      expect(res.body.map((h: { name: string }) => h.name)).toEqual(['Lemon Tree Premier', 'Holtin']);
    });

    it('returns an empty array for a city without hotels', async () => {
      const res = await request(app).get('/api/hotels?city=goa').expect(200);
      expect(res.body).toEqual([]);
    });

    it('reports partial results in headers', async () => {
      const partialOrchestrator = new FakeOrchestrator(new InMemoryHotelCache(), { delhi: DELHI_FIXTURE }, [
        {
          supplierId: 'A',
          supplier: 'Supplier A',
          status: 'failed',
          hotelCount: 0,
          error: 'HTTP 503',
        },
        {
          supplierId: 'B',
          supplier: 'Supplier B',
          status: 'ok',
          hotelCount: 2,
        },
      ]);
      const partialApp = createApp({
        logger: silentLogger,
        cache: new InMemoryHotelCache(),
        orchestrator: partialOrchestrator,
        simulation,
        supplierUrls,
        healthCheckTimeoutMs: 1_000,
        enableSupplierSimulation: false,
      });
      const res = await request(partialApp).get('/api/hotels?city=delhi').expect(200);
      expect(res.headers['x-partial-result']).toBe('true');
      expect(res.headers['x-supplier-status']).toBe('Supplier A=failed; Supplier B=ok');
    });

    it.each([
      ['/api/hotels', 'city'],
      ['/api/hotels?city=delhi&minPrice=abc', 'minPrice'],
      ['/api/hotels?city=delhi&minPrice=900&maxPrice=100', 'less than or equal'],
    ])('400 for %s', async (url, messagePart) => {
      const res = await request(app).get(url).expect(400);
      expect(res.body.error.code).toBe('INVALID_QUERY');
      expect(res.body.error.message).toContain(messagePart);
      expect(res.body.requestId).toBeTruthy();
    });

    it('502 when every supplier failed', async () => {
      orchestrator.nextError = new AllSuppliersUnavailableError('All suppliers failed', [], 'hotel-offers-delhi');
      const res = await request(app).get('/api/hotels?city=delhi').expect(502);
      expect(res.body.error.code).toBe('SUPPLIERS_UNAVAILABLE');
    });

    it('504 when the workflow times out', async () => {
      orchestrator.nextError = new WorkflowTimedOutError('hotel-offers-delhi');
      const res = await request(app).get('/api/hotels?city=delhi').expect(504);
      expect(res.body.error.code).toBe('ORCHESTRATION_TIMEOUT');
    });

    it('500 with a generic message for unexpected errors (no internals leaked)', async () => {
      orchestrator.nextError = new Error('secret stack detail');
      const res = await request(app).get('/api/hotels?city=delhi').expect(500);
      expect(res.body.error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong.',
      });
    });

    it('propagates a caller-supplied X-Request-Id', async () => {
      const res = await request(app).get('/api/hotels?city=delhi').set('X-Request-Id', 'abc-123').expect(200);
      expect(res.headers['x-request-id']).toBe('abc-123');
    });
  });

  describe('mock suppliers', () => {
    it('serve static data filtered by city with overlapping hotel names', async () => {
      const a = await request(app).get('/supplierA/hotels?city=delhi').expect(200);
      const b = await request(app).get('/supplierB/hotels?city=Delhi').expect(200);
      expect(a.body[0]).toEqual({
        hotelId: 'a1',
        name: 'Holtin',
        price: 6000,
        city: 'delhi',
        commissionPct: 10,
      });
      const namesA = new Set(a.body.map((h: { name: string }) => h.name));
      expect(b.body.some((h: { name: string }) => namesA.has(h.name))).toBe(true);
    });

    it('can be switched down and back up through the admin API', async () => {
      await request(app).put('/admin/suppliers/A').send({ mode: 'down' }).expect(200);
      await request(app).get('/supplierA/hotels').expect(503);
      await request(app).post('/admin/suppliers/reset').expect(200);
      await request(app).get('/supplierA/hotels').expect(200);
    });

    it('invalidates cached snapshots when the simulation changes', async () => {
      await request(app).get('/api/hotels?city=delhi').expect(200);
      expect(cache.snapshots.size).toBe(1);
      await request(app).put('/admin/suppliers/supplierB').send({ failNextRequests: 1 }).expect(200);
      expect(cache.snapshots.size).toBe(0);
    });

    it('validates admin input', async () => {
      await request(app).put('/admin/suppliers/C').send({ mode: 'down' }).expect(404);
      await request(app).put('/admin/suppliers/A').send({ mode: 'sideways' }).expect(400);
      await request(app)
        .put('/admin/suppliers/A')
        .set('content-type', 'application/json')
        .send('{bad json')
        .expect(400);
    });
  });

  describe('GET /health', () => {
    it('is ok when both suppliers, Redis and Temporal are up', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.suppliers['Supplier A'].status).toBe('up');
      expect(res.body.suppliers['Supplier B'].status).toBe('up');
      expect(res.body.dependencies.redis.status).toBe('up');
      expect(res.body.dependencies.temporal.status).toBe('up');
    });

    it('is degraded (200) when one supplier is down', async () => {
      simulation.update('B', { mode: 'down' });
      const res = await request(app).get('/health').expect(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.suppliers['Supplier B']).toMatchObject({
        status: 'down',
        error: 'HTTP 503',
      });
    });

    it('is down (503) when both suppliers are down', async () => {
      simulation.update('A', { mode: 'down' });
      simulation.update('B', { mode: 'invalid' });
      const res = await request(app).get('/health').expect(503);
      expect(res.body.status).toBe('down');
      expect(res.body.suppliers['Supplier B'].error).toContain('Unexpected payload');
    });

    it('is down (503) when Temporal is unreachable', async () => {
      orchestrator.healthy = false;
      const res = await request(app).get('/health').expect(503);
      expect(res.body.dependencies.temporal.status).toBe('down');
    });

    it('liveness probe has no dependencies', async () => {
      orchestrator.healthy = false;
      cache.failing = true;
      await request(app).get('/health/live').expect(200, { status: 'ok' });
    });
  });

  it('404s unknown routes with the standard error body', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
