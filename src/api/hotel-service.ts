import type { Logger } from 'pino';
import { cityKey } from '../domain/normalize';
import type { HotelOffer, SupplierOutcome } from '../domain/types';
import type { CachedHotels, HotelCache, PriceRange } from '../redis/hotel-cache';
import type { HotelOffersOrchestrator } from '../temporal/orchestrator';

export interface GetHotelsParams {
  city: string;
  minPrice?: number;
  maxPrice?: number;
  /** Bypass the cached snapshot and force a new workflow run. */
  refresh?: boolean;
  requestId?: string;
}

export interface GetHotelsResult {
  hotels: HotelOffer[];
  cache: 'HIT' | 'MISS';
  /** Where the price filter ran: 'redis' normally, 'memory' only if Redis was unavailable. */
  filteredBy: 'redis' | 'memory' | 'none';
  workflowId?: string;
  partial: boolean;
  suppliers: SupplierOutcome[];
  fetchedAt: string;
}

/**
 * Read path:
 *   1. If a fresh snapshot for the city exists in Redis, filter it in Redis and return (cache HIT).
 *   2. Otherwise run the Temporal workflow (calls suppliers, dedupes, saves to Redis), then
 *      apply the price filter in Redis against the snapshot it just wrote (cache MISS).
 *   3. If Redis is unavailable the API keeps working: the workflow result is returned and any
 *      price filter is applied in memory (reported via the X-Price-Filter header).
 */
export class HotelService {
  constructor(
    private readonly cache: HotelCache,
    private readonly orchestrator: HotelOffersOrchestrator,
    private readonly logger: Logger,
  ) {}

  async getHotels(params: GetHotelsParams): Promise<GetHotelsResult> {
    const city = cityKey(params.city);
    const range: PriceRange | undefined =
      params.minPrice !== undefined || params.maxPrice !== undefined
        ? { minPrice: params.minPrice, maxPrice: params.maxPrice }
        : undefined;
    const filteredByRedis = range ? 'redis' : 'none';

    if (!params.refresh) {
      const cached = await this.tryQueryCache(city, range);
      if (cached) {
        return {
          hotels: cached.hotels,
          cache: 'HIT',
          filteredBy: filteredByRedis,
          workflowId: cached.meta.workflowId,
          partial: cached.meta.partial,
          suppliers: cached.meta.suppliers,
          fetchedAt: cached.meta.fetchedAt,
        };
      }
    }

    const { workflowId, result } = await this.orchestrator.run(city, params.requestId);
    const base = {
      cache: 'MISS' as const,
      workflowId,
      partial: result.partial,
      suppliers: result.suppliers,
      fetchedAt: result.fetchedAt,
    };

    if (!range) return { ...base, hotels: result.hotels, filteredBy: 'none' };

    const filtered = result.cached ? await this.tryQueryCache(city, range) : null;
    if (filtered) return { ...base, hotels: filtered.hotels, filteredBy: 'redis' };

    this.logger.warn({ city, workflowId }, 'Snapshot not available in Redis; applying price filter in memory');
    return {
      ...base,
      hotels: filterByPrice(result.hotels, range),
      filteredBy: 'memory',
    };
  }

  private async tryQueryCache(city: string, range?: PriceRange): Promise<CachedHotels | null> {
    try {
      return await this.cache.query(city, range);
    } catch (err) {
      this.logger.warn({ city, err: (err as Error).message }, 'Redis query failed; treating as cache miss');
      return null;
    }
  }
}

export function filterByPrice(hotels: HotelOffer[], { minPrice, maxPrice }: PriceRange): HotelOffer[] {
  return hotels.filter(
    (h) => (minPrice === undefined || h.price >= minPrice) && (maxPrice === undefined || h.price <= maxPrice),
  );
}
