import type Redis from 'ioredis';
import { cityKey, hotelKey } from '../domain/normalize';
import type { HotelOffer, SupplierOutcome } from '../domain/types';

/**
 * Redis data model (one snapshot per city, all keys share a {hash tag} so the
 * scripts also work on Redis Cluster):
 *
 *   <prefix>hotels:{delhi}:prices  ZSET   member = normalised hotel name, score = price
 *   <prefix>hotels:{delhi}:offers  HASH   field  = normalised hotel name, value = offer JSON
 *   <prefix>hotels:{delhi}:meta    STRING snapshot metadata JSON (also the "snapshot exists" marker,
 *                                         needed because an empty city has no ZSET)
 *
 * Writes replace the whole snapshot atomically (Lua), and price filtering is done
 * inside Redis with ZRANGE ... BYSCORE + HMGET in a single atomic Lua call, so a
 * reader never sees a half-written snapshot.
 */

export interface SnapshotMeta {
  city: string;
  fetchedAt: string;
  workflowId?: string;
  partial: boolean;
  suppliers: SupplierOutcome[];
  count: number;
}

export interface PriceRange {
  minPrice?: number;
  maxPrice?: number;
}

export interface CachedHotels {
  meta: SnapshotMeta;
  hotels: HotelOffer[];
}

export interface HotelCache {
  save(
    city: string,
    hotels: HotelOffer[],
    meta: Omit<SnapshotMeta, 'city' | 'count'>,
    ttlSeconds: number,
  ): Promise<number>;
  /** Returns the snapshot filtered by price (inclusive), or null if there is no fresh snapshot. */
  query(city: string, range?: PriceRange): Promise<CachedHotels | null>;
  invalidateAll(): Promise<number>;
  ping(): Promise<number>;
}

// KEYS: prices, offers, meta  ARGV: ttl, metaJson, [score, member, json]...
const SAVE_SNAPSHOT_LUA = `
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
local ttl = tonumber(ARGV[1])
local n = 0
for i = 3, #ARGV, 3 do
  redis.call('ZADD', KEYS[1], ARGV[i], ARGV[i + 1])
  redis.call('HSET', KEYS[2], ARGV[i + 1], ARGV[i + 2])
  n = n + 1
end
if n > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
end
redis.call('SET', KEYS[3], ARGV[2], 'EX', ttl)
return n
`;

// KEYS: prices, offers, meta  ARGV: min, max  -> nil | { metaJson, offerJson... } ordered by price
const QUERY_BY_PRICE_LUA = `
local meta = redis.call('GET', KEYS[3])
if not meta then return false end
local ids = redis.call('ZRANGE', KEYS[1], ARGV[1], ARGV[2], 'BYSCORE')
local out = { meta }
for i = 1, #ids, 500 do
  local chunk = {}
  for j = i, math.min(i + 499, #ids) do chunk[#chunk + 1] = ids[j] end
  local values = redis.call('HMGET', KEYS[2], unpack(chunk))
  for k = 1, #values do
    if values[k] then out[#out + 1] = values[k] end
  end
end
return out
`;

type ScriptedRedis = Redis & {
  hooSaveSnapshot(k1: string, k2: string, k3: string, ...args: (string | number)[]): Promise<number>;
  hooQueryByPrice(k1: string, k2: string, k3: string, min: string, max: string): Promise<string[] | null>;
};

export class RedisHotelCache implements HotelCache {
  private readonly redis: ScriptedRedis;

  constructor(
    redis: Redis,
    private readonly prefix = 'hoo:',
  ) {
    if (!('hooSaveSnapshot' in redis)) {
      redis.defineCommand('hooSaveSnapshot', {
        numberOfKeys: 3,
        lua: SAVE_SNAPSHOT_LUA,
      });
      redis.defineCommand('hooQueryByPrice', {
        numberOfKeys: 3,
        lua: QUERY_BY_PRICE_LUA,
      });
    }
    this.redis = redis as ScriptedRedis;
  }

  keys(city: string): [prices: string, offers: string, meta: string] {
    const base = `${this.prefix}hotels:{${encodeURIComponent(cityKey(city))}}`;
    return [`${base}:prices`, `${base}:offers`, `${base}:meta`];
  }

  async save(
    city: string,
    hotels: HotelOffer[],
    meta: Omit<SnapshotMeta, 'city' | 'count'>,
    ttlSeconds: number,
  ): Promise<number> {
    const fullMeta: SnapshotMeta = {
      city: cityKey(city),
      count: hotels.length,
      ...meta,
    };
    const args: (string | number)[] = [ttlSeconds, JSON.stringify(fullMeta)];
    for (const h of hotels) args.push(h.price, hotelKey(h.name), JSON.stringify(h));
    return this.redis.hooSaveSnapshot(...this.keys(city), ...args);
  }

  async query(city: string, range: PriceRange = {}): Promise<CachedHotels | null> {
    const min = range.minPrice === undefined ? '-inf' : String(range.minPrice);
    const max = range.maxPrice === undefined ? '+inf' : String(range.maxPrice);
    const reply = await this.redis.hooQueryByPrice(...this.keys(city), min, max);
    if (!reply || reply.length === 0) return null;
    const [metaJson, ...offers] = reply;
    return {
      meta: JSON.parse(metaJson as string) as SnapshotMeta,
      hotels: offers.map((o) => JSON.parse(o) as HotelOffer),
    };
  }

  /** Deletes every cached snapshot (used when supplier simulation settings change). */
  async invalidateAll(): Promise<number> {
    let deleted = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}hotels:*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) deleted += await this.redis.unlink(...keys);
    } while (cursor !== '0');
    return deleted;
  }

  /** Round-trip latency in ms. */
  async ping(): Promise<number> {
    const started = performance.now();
    await this.redis.ping();
    return Math.round(performance.now() - started);
  }
}
