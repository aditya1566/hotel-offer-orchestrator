import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import { PinoTemporalLogger } from '../../src/temporal/temporal-logger';
import { INVALID_SUPPLIER_RESPONSE, SUPPLIER_CLIENT_ERROR } from '../../src/domain/types';
import { createActivities } from '../../src/temporal/activities';
import { InMemoryHotelCache, OK_SUPPLIERS, silentLogger } from '../helpers';

function setup(fetchImpl: typeof fetch, cache = new InMemoryHotelCache()) {
  const activities = createActivities({
    supplierUrls: {
      A: 'http://supplier-a.test/hotels',
      B: 'http://supplier-b.test/hotels',
    },
    supplierTimeoutMs: 200,
    cache,
    cacheTtlSeconds: 60,
    partialCacheTtlSeconds: 10,
    fetchImpl,
  });
  return {
    activities,
    env: new MockActivityEnvironment(undefined, {
      logger: new PinoTemporalLogger(silentLogger),
    }),
    cache,
  };
}

const json = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

async function failureOf(promise: Promise<unknown>): Promise<ApplicationFailure> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApplicationFailure);
  return err as ApplicationFailure;
}

describe('fetchSupplierHotels activity', () => {
  it('passes the city to the supplier and tags the result with the supplier name', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: URL) => {
      calledUrl = url.toString();
      return new Response(
        JSON.stringify([
          {
            hotelId: 'a1',
            name: 'Holtin',
            price: 6000,
            city: 'delhi',
            commissionPct: 10,
          },
        ]),
      );
    }) as unknown as typeof fetch;
    const { activities, env } = setup(fetchImpl);

    const result = await env.run(activities.fetchSupplierHotels, {
      supplierId: 'A',
      city: 'delhi',
    });
    expect(calledUrl).toBe('http://supplier-a.test/hotels?city=delhi');
    expect(result).toEqual({
      supplierId: 'A',
      supplier: 'Supplier A',
      hotels: [
        {
          hotelId: 'a1',
          name: 'Holtin',
          price: 6000,
          city: 'delhi',
          commissionPct: 10,
        },
      ],
    });
  });

  it('drops invalid records and hotels from other cities instead of failing', async () => {
    const { activities, env } = setup(
      json([
        {
          hotelId: 'b1',
          name: 'Good',
          price: 100,
          city: 'Delhi',
          commissionPct: 10,
        },
        {
          hotelId: 'b2',
          name: 'Negative',
          price: -5,
          city: 'delhi',
          commissionPct: 10,
        },
        {
          hotelId: 'b3',
          name: '',
          price: 100,
          city: 'delhi',
          commissionPct: 10,
        },
        {
          hotelId: 'b4',
          name: 'Elsewhere',
          price: 100,
          city: 'mumbai',
          commissionPct: 10,
        },
        'garbage',
      ]),
    );
    const result = await env.run(activities.fetchSupplierHotels, {
      supplierId: 'B',
      city: 'delhi',
    });
    expect(result.hotels.map((h) => h.name)).toEqual(['Good']);
  });

  it.each([500, 503, 429, 408])('HTTP %i is a retryable failure', async (status) => {
    const { activities, env } = setup(json({ error: 'x' }, status));
    const failure = await failureOf(
      env.run(activities.fetchSupplierHotels, {
        supplierId: 'A',
        city: 'delhi',
      }),
    );
    expect(failure.nonRetryable).toBe(false);
    expect(failure.message).toContain(`HTTP ${status}`);
  });

  it('other 4xx responses are non-retryable', async () => {
    const { activities, env } = setup(json({ error: 'x' }, 404));
    const failure = await failureOf(
      env.run(activities.fetchSupplierHotels, {
        supplierId: 'A',
        city: 'delhi',
      }),
    );
    expect(failure.nonRetryable).toBe(true);
    expect(failure.type).toBe(SUPPLIER_CLIENT_ERROR);
  });

  it('a payload that is not an array is non-retryable', async () => {
    const { activities, env } = setup(json({ hotels: 'nope' }));
    const failure = await failureOf(
      env.run(activities.fetchSupplierHotels, {
        supplierId: 'B',
        city: 'delhi',
      }),
    );
    expect(failure.nonRetryable).toBe(true);
    expect(failure.type).toBe(INVALID_SUPPLIER_RESPONSE);
  });

  it('network errors and timeouts are retryable', async () => {
    const hanging = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const { activities, env } = setup(hanging);
    const failure = await failureOf(
      env.run(activities.fetchSupplierHotels, {
        supplierId: 'A',
        city: 'delhi',
      }),
    );
    expect(failure.nonRetryable).toBe(false);
    expect(failure.message).toContain('timed out after 200ms');

    const refused = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    }) as typeof fetch;
    const second = setup(refused);
    const failure2 = await failureOf(
      second.env.run(second.activities.fetchSupplierHotels, {
        supplierId: 'A',
        city: 'delhi',
      }),
    );
    expect(failure2.message).toContain('ECONNREFUSED');
  });
});

describe('saveHotelOffers activity', () => {
  it('writes the snapshot with the right metadata', async () => {
    const { activities, env, cache } = setup(json([]));
    await env.run(activities.saveHotelOffers, {
      city: 'delhi',
      hotels: [
        {
          name: 'Holtin',
          price: 5340,
          supplier: 'Supplier B',
          commissionPct: 20,
        },
      ],
      suppliers: OK_SUPPLIERS,
      partial: false,
      workflowId: 'wf-1',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
    const snap = await cache.query('delhi');
    expect(snap?.meta).toMatchObject({
      city: 'delhi',
      count: 1,
      workflowId: 'wf-1',
      partial: false,
    });
    expect(snap?.hotels).toHaveLength(1);
  });
});
