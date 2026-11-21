import { ApplicationFailure, Context, log } from '@temporalio/activity';
import { z } from 'zod';
import { cityKey } from '../domain/normalize';
import {
  INVALID_SUPPLIER_RESPONSE,
  SUPPLIER_CLIENT_ERROR,
  SUPPLIER_NAMES,
  type HotelOffer,
  type SupplierHotel,
  type SupplierId,
  type SupplierOffers,
  type SupplierOutcome,
} from '../domain/types';
import type { HotelCache } from '../redis/hotel-cache';

/** Shape every supplier record must satisfy; invalid records are dropped, not fatal. */
const supplierHotelSchema = z.object({
  hotelId: z.coerce.string().min(1),
  name: z.string().trim().min(1),
  price: z.number().finite().positive(),
  city: z.string().trim().min(1),
  commissionPct: z.number().finite().min(0).max(100),
});

export interface ActivityDeps {
  supplierUrls: Record<SupplierId, string>;
  supplierTimeoutMs: number;
  cache: HotelCache;
  cacheTtlSeconds: number;
  partialCacheTtlSeconds: number;
  fetchImpl?: typeof fetch;
}

export interface FetchSupplierHotelsInput {
  supplierId: SupplierId;
  city: string;
}

export interface SaveHotelOffersInput {
  city: string;
  hotels: HotelOffer[];
  suppliers: SupplierOutcome[];
  partial: boolean;
  workflowId: string;
  fetchedAt: string;
}

/**
 * Activities are created from injected dependencies so they can be unit-tested
 * and so the worker owns a single Redis connection.
 *
 * Error policy (drives Temporal's retry behaviour):
 *  - network errors, timeouts, 5xx, 408, 429  -> retryable ApplicationFailure
 *  - other 4xx, malformed payloads              -> non-retryable ApplicationFailure
 */
export function createActivities(deps: ActivityDeps) {
  const doFetch = deps.fetchImpl ?? fetch;

  async function fetchSupplierHotels({ supplierId, city }: FetchSupplierHotelsInput): Promise<SupplierOffers> {
    const supplier = SUPPLIER_NAMES[supplierId];
    const { attempt } = Context.current().info;
    const url = new URL(deps.supplierUrls[supplierId]);
    url.searchParams.set('city', city);
    const started = performance.now();
    const ctx = { supplier, city, attempt, url: url.toString() };

    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(deps.supplierTimeoutMs), Context.current().cancellationSignal]),
      });
    } catch (err) {
      const reason =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? `timed out after ${deps.supplierTimeoutMs}ms`
          : errorMessage(err);
      log.warn(`${supplier} unreachable`, { ...ctx, reason });
      throw ApplicationFailure.retryable(`${supplier} unreachable: ${reason}`, 'SupplierUnreachable');
    }

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      log.warn(`${supplier} responded with HTTP ${response.status}`, {
        ...ctx,
        status: response.status,
        retryable,
      });
      const message = `${supplier} responded with HTTP ${response.status}`;
      throw retryable
        ? ApplicationFailure.retryable(message, 'SupplierUnavailable')
        : ApplicationFailure.nonRetryable(message, SUPPLIER_CLIENT_ERROR);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      log.error(`${supplier} returned a non-JSON body`, ctx);
      throw ApplicationFailure.nonRetryable(`${supplier} returned a non-JSON body`, INVALID_SUPPLIER_RESPONSE);
    }
    if (!Array.isArray(body)) {
      log.error(`${supplier} returned an unexpected payload (expected an array)`, ctx);
      throw ApplicationFailure.nonRetryable(
        `${supplier} returned an unexpected payload (expected an array)`,
        INVALID_SUPPLIER_RESPONSE,
      );
    }

    const wantedCity = cityKey(city);
    const hotels: SupplierHotel[] = [];
    let dropped = 0;
    for (const item of body) {
      const parsed = supplierHotelSchema.safeParse(item);
      if (!parsed.success) {
        dropped += 1;
        continue;
      }
      // Defensive: a supplier might ignore the city filter.
      if (cityKey(parsed.data.city) === wantedCity) hotels.push(parsed.data);
    }
    if (dropped > 0)
      log.warn(`${supplier}: dropped ${dropped} invalid hotel record(s)`, {
        ...ctx,
        dropped,
      });

    log.info(`${supplier} returned ${hotels.length} hotel(s)`, {
      ...ctx,
      count: hotels.length,
      durationMs: Math.round(performance.now() - started),
    });
    return { supplierId, supplier, hotels };
  }

  async function saveHotelOffers(input: SaveHotelOffersInput): Promise<void> {
    const ttl = input.partial ? deps.partialCacheTtlSeconds : deps.cacheTtlSeconds;
    const started = performance.now();
    await deps.cache.save(
      input.city,
      input.hotels,
      {
        fetchedAt: input.fetchedAt,
        workflowId: input.workflowId,
        partial: input.partial,
        suppliers: input.suppliers,
      },
      ttl,
    );
    log.info('Saved de-duplicated hotel list to Redis', {
      city: input.city,
      count: input.hotels.length,
      ttlSeconds: ttl,
      partial: input.partial,
      durationMs: Math.round(performance.now() - started),
    });
  }

  return { fetchSupplierHotels, saveHotelOffers };
}

export type HotelOfferActivities = ReturnType<typeof createActivities>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
