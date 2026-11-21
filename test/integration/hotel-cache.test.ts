/**
 * Runs against a real Redis (REDIS_URL, default redis://localhost:6379).
 * Skipped automatically when Redis is not reachable.
 */
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HotelOffer } from '../../src/domain/types';
import { RedisHotelCache } from '../../src/redis/hotel-cache';
import { OK_SUPPLIERS } from '../helpers';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PREFIX = `test:${process.pid}:`;

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const HOTELS: HotelOffer[] = [
  { name: 'Bloomrooms', price: 2100, supplier: 'Supplier B', commissionPct: 5 },
  {
    name: 'Lemon Tree Premier',
    price: 3200,
    supplier: 'Supplier A',
    commissionPct: 8,
  },
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
  {
    name: 'The Oberoi',
    price: 15000,
    supplier: 'Supplier B',
    commissionPct: 17,
  },
];
const META = {
  fetchedAt: '2026-01-01T00:00:00.000Z',
  workflowId: 'wf-1',
  partial: false,
  suppliers: OK_SUPPLIERS,
};

describe('RedisHotelCache (real Redis)', () => {
  let available = false;
  let redis: Redis;
  let cache: RedisHotelCache;

  beforeAll(async () => {
    available = await redisAvailable();
    if (!available) return;
    redis = new Redis(REDIS_URL);
    cache = new RedisHotelCache(redis, PREFIX);
  });
  beforeEach(async (ctx) => {
    if (!available) return ctx.skip();
    await cache.invalidateAll();
  });
  afterAll(async () => {
    if (!available) return;
    await cache.invalidateAll();
    redis.disconnect();
  });

  it('stores the list as a price-scored sorted set + hash + meta, all with a TTL', async () => {
    await cache.save('Delhi', HOTELS, META, 60);
    const [prices, offers, meta] = cache.keys('delhi');
    expect(await redis.zrange(prices, 0, -1, 'WITHSCORES')).toEqual([
      'bloomrooms',
      '2100',
      'lemon tree premier',
      '3200',
      'holtin',
      '5340',
      'radison',
      '5900',
      'the oberoi',
      '15000',
    ]);
    expect(await redis.hlen(offers)).toBe(5);
    for (const key of [prices, offers, meta]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    }
  });

  it('returns null when there is no snapshot', async () => {
    expect(await cache.query('nowhere')).toBeNull();
  });

  it('returns the full list ordered by price when no range is given', async () => {
    await cache.save('delhi', HOTELS, META, 60);
    const result = await cache.query('DELHI');
    expect(result?.hotels).toEqual(HOTELS);
    expect(result?.meta).toMatchObject({
      city: 'delhi',
      count: 5,
      workflowId: 'wf-1',
    });
  });

  it('filters by price inside Redis with inclusive bounds', async () => {
    await cache.save('delhi', HOTELS, META, 60);
    const names = async (minPrice?: number, maxPrice?: number) =>
      (await cache.query('delhi', { minPrice, maxPrice }))?.hotels.map((h) => h.name);

    expect(await names(3200, 5900)).toEqual(['Lemon Tree Premier', 'Holtin', 'Radison']);
    expect(await names(5340, 5340)).toEqual(['Holtin']);
    expect(await names(10000)).toEqual(['The Oberoi']);
    expect(await names(undefined, 3000)).toEqual(['Bloomrooms']);
    expect(await names(100000)).toEqual([]);
  });

  it('distinguishes "empty city" (snapshot with zero hotels) from "no snapshot"', async () => {
    await cache.save('goa', [], META, 60);
    const result = await cache.query('goa');
    expect(result).not.toBeNull();
    expect(result?.hotels).toEqual([]);
    expect(result?.meta.count).toBe(0);
  });

  it('replaces the previous snapshot atomically (no stale hotels left behind)', async () => {
    await cache.save('delhi', HOTELS, META, 60);
    await cache.save('delhi', [HOTELS[2]!], { ...META, workflowId: 'wf-2', partial: true }, 10);
    const result = await cache.query('delhi');
    expect(result?.hotels.map((h) => h.name)).toEqual(['Holtin']);
    expect(result?.meta).toMatchObject({
      workflowId: 'wf-2',
      partial: true,
      count: 1,
    });
  });

  it('expires snapshots after the TTL', async () => {
    await cache.save('delhi', HOTELS, META, 1);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await cache.query('delhi')).toBeNull();
  });

  it('handles large lists (chunked HMGET inside the Lua script)', async () => {
    const many: HotelOffer[] = Array.from({ length: 2_500 }, (_, i) => ({
      name: `Hotel ${String(i).padStart(5, '0')}`,
      price: 1000 + i,
      supplier: i % 2 ? 'Supplier A' : 'Supplier B',
      commissionPct: 10,
    }));
    await cache.save('bigcity', many, META, 60);
    const result = await cache.query('bigcity', { minPrice: 1500 });
    expect(result?.hotels).toHaveLength(2_000);
    expect(result?.hotels[0]?.price).toBe(1500);
  });

  it('invalidateAll removes every snapshot under the prefix', async () => {
    await cache.save('delhi', HOTELS, META, 60);
    await cache.save('mumbai', HOTELS, META, 60);
    expect(await cache.invalidateAll()).toBe(6);
    expect(await cache.query('delhi')).toBeNull();
  });

  it('ping reports latency', async () => {
    expect(await cache.ping()).toBeGreaterThanOrEqual(0);
  });
});
