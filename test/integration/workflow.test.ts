/**
 * Runs the real workflow code on an ephemeral Temporal dev server with mocked
 * activities. The SDK downloads the dev server on first run; to use an existing
 * binary instead, set TEMPORAL_CLI_PATH=/path/to/temporal.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_SUPPLIERS_UNAVAILABLE,
  INVALID_SUPPLIER_RESPONSE,
  type HotelOffersWorkflowResult,
  type SupplierHotel,
  type SupplierId,
  type SupplierOffers,
} from '../../src/domain/types';
import type {
  FetchSupplierHotelsInput,
  HotelOfferActivities,
  SaveHotelOffersInput,
} from '../../src/temporal/activities';
import { AllSuppliersUnavailableError, TemporalHotelOffersOrchestrator } from '../../src/temporal/orchestrator';
import { PinoTemporalLogger } from '../../src/temporal/temporal-logger';
import { silentLogger } from '../helpers';

const WORKFLOWS_PATH = path.join(process.cwd(), 'src/temporal/workflows.ts');

const h = (name: string, price: number, commissionPct = 10): SupplierHotel => ({
  hotelId: `${name}-${price}`,
  name,
  price,
  city: 'delhi',
  commissionPct,
});

const CATALOGUE: Record<SupplierId, SupplierHotel[]> = {
  A: [h('Holtin', 6000, 10), h('Radison', 5900, 13), h('Only A', 1000)],
  B: [h('Holtin', 5340, 20), h('Radison', 6100, 18), h('Only B', 2000)],
};

type Behaviour = 'ok' | 'down' | 'invalid' | { failTimes: number };

function mockActivities(behaviour: Record<SupplierId, Behaviour>, opts: { saveFails?: boolean } = {}) {
  const calls: Record<SupplierId, number> = { A: 0, B: 0 };
  const saved: SaveHotelOffersInput[] = [];
  const activities: HotelOfferActivities = {
    async fetchSupplierHotels({ supplierId }: FetchSupplierHotelsInput): Promise<SupplierOffers> {
      calls[supplierId] += 1;
      const b = behaviour[supplierId];
      if (b === 'down') throw ApplicationFailure.retryable(`Supplier ${supplierId} responded with HTTP 503`);
      if (b === 'invalid') throw ApplicationFailure.nonRetryable('bad payload', INVALID_SUPPLIER_RESPONSE);
      if (typeof b === 'object' && calls[supplierId] <= b.failTimes) {
        throw ApplicationFailure.retryable('transient');
      }
      return {
        supplierId,
        supplier: `Supplier ${supplierId}`,
        hotels: CATALOGUE[supplierId],
      };
    },
    async saveHotelOffers(input: SaveHotelOffersInput): Promise<void> {
      if (opts.saveFails) throw new Error('Redis unavailable');
      saved.push(input);
    },
  };
  return { activities, calls, saved };
}

describe('hotelOffersWorkflow (Temporal dev server)', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    // Workflow/activity logs are expected noise here (failure scenarios); keep the output clean.
    Runtime.install({ logger: new PinoTemporalLogger(silentLogger) });
    const cli = process.env.TEMPORAL_CLI_PATH;
    env = await TestWorkflowEnvironment.createLocal({
      server: {
        // The dev server logs harmless "context canceled" errors on teardown; keep test output clean.
        log: { format: 'pretty', level: 'never' },
        ...(cli ? { executable: { type: 'existing-path' as const, path: cli } } : {}),
      },
    });
  });

  afterAll(async () => {
    await env?.teardown();
  });

  async function runWorkflow(activities: HotelOfferActivities): Promise<HotelOffersWorkflowResult> {
    const taskQueue = `test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });
    return worker.runUntil(
      env.client.workflow.execute('hotelOffersWorkflow', {
        taskQueue,
        workflowId: `wf-${randomUUID()}`,
        args: [{ city: 'delhi' }],
      }),
    );
  }

  it('calls both suppliers, keeps the cheapest offer per hotel and saves the snapshot', async () => {
    const { activities, calls, saved } = mockActivities({ A: 'ok', B: 'ok' });
    const result = await runWorkflow(activities);

    expect(calls).toEqual({ A: 1, B: 1 });
    expect(result.partial).toBe(false);
    expect(result.cached).toBe(true);
    expect(result.hotels).toEqual([
      {
        name: 'Only A',
        price: 1000,
        supplier: 'Supplier A',
        commissionPct: 10,
      },
      {
        name: 'Only B',
        price: 2000,
        supplier: 'Supplier B',
        commissionPct: 10,
      },
      {
        name: 'Holtin',
        price: 5340,
        supplier: 'Supplier B',
        commissionPct: 20,
      },
      {
        name: 'Radison',
        price: 5900,
        supplier: 'Supplier A',
        commissionPct: 13,
      },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      city: 'delhi',
      partial: false,
      hotels: result.hotels,
    });
  });

  it('retries transient supplier failures and still returns a complete result', async () => {
    const { activities, calls } = mockActivities({
      A: { failTimes: 2 },
      B: 'ok',
    });
    const result = await runWorkflow(activities);
    expect(calls.A).toBe(3);
    expect(result.partial).toBe(false);
    expect(result.hotels).toHaveLength(4);
  });

  it('returns a partial result when one supplier stays down', async () => {
    const { activities, calls, saved } = mockActivities({ A: 'down', B: 'ok' });
    const result = await runWorkflow(activities);

    expect(calls.A).toBe(3); // maximumAttempts
    expect(result.partial).toBe(true);
    expect(result.hotels.every((x) => x.supplier === 'Supplier B')).toBe(true);
    expect(result.suppliers).toEqual([
      expect.objectContaining({
        supplier: 'Supplier A',
        status: 'failed',
        error: expect.stringContaining('503'),
      }),
      expect.objectContaining({
        supplier: 'Supplier B',
        status: 'ok',
        hotelCount: 3,
      }),
    ]);
    expect(saved[0]?.partial).toBe(true);
  });

  it('does not retry non-retryable failures', async () => {
    const { activities, calls } = mockActivities({ A: 'ok', B: 'invalid' });
    const result = await runWorkflow(activities);
    expect(calls.B).toBe(1);
    expect(result.partial).toBe(true);
  });

  it('fails with AllSuppliersUnavailable when every supplier fails', async () => {
    const { activities } = mockActivities({ A: 'down', B: 'invalid' });
    const err = await runWorkflow(activities).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    const cause = (err as WorkflowFailedError).cause as ApplicationFailure;
    expect(cause.type).toBe(ALL_SUPPLIERS_UNAVAILABLE);
    expect(cause.nonRetryable).toBe(true);
  });

  it('still returns the list when saving to Redis fails (cached=false)', async () => {
    const { activities } = mockActivities({ A: 'ok', B: 'ok' }, { saveFails: true });
    const result = await runWorkflow(activities);
    expect(result.cached).toBe(false);
    expect(result.hotels).toHaveLength(4);
  });

  describe('TemporalHotelOffersOrchestrator (API-side client)', () => {
    async function withWorker<T>(
      activities: HotelOfferActivities,
      fn: (o: TemporalHotelOffersOrchestrator) => Promise<T>,
    ): Promise<T> {
      const taskQueue = `test-${randomUUID()}`;
      const orchestrator = new TemporalHotelOffersOrchestrator({
        address: env.address,
        namespace: 'default',
        taskQueue,
        workflowTimeoutMs: 15_000,
      });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: WORKFLOWS_PATH,
        activities,
      });
      try {
        return await worker.runUntil(fn(orchestrator));
      } finally {
        await orchestrator.close();
      }
    }

    it('coalesces concurrent requests for the same city into one workflow run', async () => {
      const { activities, calls } = mockActivities({ A: 'ok', B: 'ok' });
      const runs = await withWorker(activities, (o) => Promise.all([o.run('Delhi'), o.run('delhi'), o.run(' DELHI ')]));
      expect(new Set(runs.map((r) => r.workflowId))).toEqual(new Set(['hotel-offers-delhi']));
      expect(new Set(runs.map((r) => r.runId)).size).toBe(1);
      expect(calls).toEqual({ A: 1, B: 1 });
    });

    it('translates "all suppliers failed" into a typed error with supplier details', async () => {
      const { activities } = mockActivities({ A: 'invalid', B: 'invalid' });
      const err = await withWorker(activities, (o) => o.run('delhi').catch((e: unknown) => e));
      expect(err).toBeInstanceOf(AllSuppliersUnavailableError);
      expect((err as AllSuppliersUnavailableError).suppliers.map((s) => s.status)).toEqual(['failed', 'failed']);
    });

    it('reports Temporal health', async () => {
      const { activities } = mockActivities({ A: 'ok', B: 'ok' });
      await withWorker(activities, (o) => o.checkHealth());
    });
  });
});
