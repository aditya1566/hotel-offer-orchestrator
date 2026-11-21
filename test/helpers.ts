import pino from 'pino';
import { cityKey } from '../src/domain/normalize';
import { compareOffers } from '../src/domain/select-best-offers';
import type { HotelOffer, HotelOffersWorkflowResult, SupplierOutcome } from '../src/domain/types';
import type { CachedHotels, HotelCache, PriceRange, SnapshotMeta } from '../src/redis/hotel-cache';
import type { HotelOffersOrchestrator, OrchestratorRun } from '../src/temporal/orchestrator';

export const silentLogger = pino({ level: 'silent' });

export const OK_SUPPLIERS: SupplierOutcome[] = [
  { supplierId: 'A', supplier: 'Supplier A', status: 'ok', hotelCount: 2 },
  { supplierId: 'B', supplier: 'Supplier B', status: 'ok', hotelCount: 2 },
];

/** In-memory HotelCache with the same semantics as the Redis implementation. */
export class InMemoryHotelCache implements HotelCache {
  readonly snapshots = new Map<string, CachedHotels>();
  failing = false;
  saves = 0;

  async save(city: string, hotels: HotelOffer[], meta: Omit<SnapshotMeta, 'city' | 'count'>): Promise<number> {
    this.guard();
    this.saves += 1;
    this.snapshots.set(cityKey(city), {
      meta: { ...meta, city: cityKey(city), count: hotels.length },
      hotels: [...hotels].sort(compareOffers),
    });
    return hotels.length;
  }

  async query(city: string, range: PriceRange = {}): Promise<CachedHotels | null> {
    this.guard();
    const snap = this.snapshots.get(cityKey(city));
    if (!snap) return null;
    return {
      meta: snap.meta,
      hotels: snap.hotels.filter(
        (h) =>
          (range.minPrice === undefined || h.price >= range.minPrice) &&
          (range.maxPrice === undefined || h.price <= range.maxPrice),
      ),
    };
  }

  async invalidateAll(): Promise<number> {
    this.guard();
    const n = this.snapshots.size;
    this.snapshots.clear();
    return n;
  }

  async ping(): Promise<number> {
    this.guard();
    return 0;
  }

  private guard(): void {
    if (this.failing) throw new Error('Redis unavailable');
  }
}

/**
 * Orchestrator double: returns a canned result and (like the real workflow)
 * writes it to the cache unless told the cache write failed.
 */
export class FakeOrchestrator implements HotelOffersOrchestrator {
  runs: string[] = [];
  healthy = true;
  nextError: Error | undefined;

  constructor(
    private readonly cache: InMemoryHotelCache,
    public hotelsByCity: Record<string, HotelOffer[]> = {},
    public suppliers: SupplierOutcome[] = OK_SUPPLIERS,
  ) {}

  async run(city: string): Promise<OrchestratorRun> {
    this.runs.push(city);
    if (this.nextError) throw this.nextError;
    const hotels = [...(this.hotelsByCity[city] ?? [])].sort(compareOffers);
    const partial = this.suppliers.some((s) => s.status === 'failed');
    const fetchedAt = new Date().toISOString();
    const workflowId = `hotel-offers-${city}`;
    let cached = false;
    try {
      await this.cache.save(city, hotels, {
        fetchedAt,
        workflowId,
        partial,
        suppliers: this.suppliers,
      });
      cached = true;
    } catch {
      cached = false;
    }
    const result: HotelOffersWorkflowResult = {
      city,
      hotels,
      suppliers: this.suppliers,
      partial,
      cached,
      fetchedAt,
    };
    return { workflowId, runId: 'run-1', result };
  }

  async checkHealth(): Promise<void> {
    if (!this.healthy) throw new Error('Temporal unavailable');
  }
}

export const DELHI_FIXTURE: HotelOffer[] = [
  { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
  { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
  {
    name: 'Lemon Tree Premier',
    price: 3200,
    supplier: 'Supplier A',
    commissionPct: 8,
  },
  {
    name: 'The Oberoi',
    price: 15000,
    supplier: 'Supplier B',
    commissionPct: 17,
  },
];
