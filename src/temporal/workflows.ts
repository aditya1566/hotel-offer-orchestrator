/**
 * Temporal workflow definitions. This module runs inside Temporal's deterministic
 * sandbox: no I/O, no Node.js APIs — only workflow APIs and pure domain code.
 */
import { ApplicationFailure, log, proxyActivities, workflowInfo } from '@temporalio/workflow';
import { selectBestOffers } from '../domain/select-best-offers';
import {
  ALL_SUPPLIERS_UNAVAILABLE,
  INVALID_SUPPLIER_RESPONSE,
  SUPPLIER_CLIENT_ERROR,
  SUPPLIER_IDS,
  SUPPLIER_NAMES,
  type HotelOffersWorkflowInput,
  type HotelOffersWorkflowResult,
  type SupplierOffers,
  type SupplierOutcome,
} from '../domain/types';
import type { HotelOfferActivities } from './activities';

/** Supplier calls: short per-attempt timeout, a few quick retries for transient failures. */
const { fetchSupplierHotels } = proxyActivities<HotelOfferActivities>({
  startToCloseTimeout: '5s',
  scheduleToCloseTimeout: '15s',
  retry: {
    initialInterval: '300ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    maximumAttempts: 3,
    nonRetryableErrorTypes: [INVALID_SUPPLIER_RESPONSE, SUPPLIER_CLIENT_ERROR],
  },
});

/** Cache write: best effort — a Redis hiccup must not fail the user's request. */
const { saveHotelOffers } = proxyActivities<HotelOfferActivities>({
  startToCloseTimeout: '3s',
  retry: { initialInterval: '200ms', maximumAttempts: 2 },
});

export async function hotelOffersWorkflow(input: HotelOffersWorkflowInput): Promise<HotelOffersWorkflowResult> {
  const { workflowId } = workflowInfo();
  const city = input.city;
  log.info('Aggregating hotel offers', { city, requestId: input.requestId });

  // 1. Fan out to both suppliers in parallel; one failing must not sink the other.
  const settled = await Promise.allSettled(SUPPLIER_IDS.map((supplierId) => fetchSupplierHotels({ supplierId, city })));

  const lists: SupplierOffers[] = [];
  const suppliers: SupplierOutcome[] = settled.map((result, i) => {
    const supplierId = SUPPLIER_IDS[i]!;
    const supplier = SUPPLIER_NAMES[supplierId];
    if (result.status === 'fulfilled') {
      lists.push(result.value);
      return {
        supplierId,
        supplier,
        status: 'ok',
        hotelCount: result.value.hotels.length,
      };
    }
    const error = describeFailure(result.reason);
    log.warn('Supplier failed after retries; continuing without it', {
      city,
      supplier,
      error,
    });
    return { supplierId, supplier, status: 'failed', hotelCount: 0, error };
  });

  if (lists.length === 0) {
    log.error('All suppliers failed', { city, suppliers });
    throw ApplicationFailure.create({
      type: ALL_SUPPLIERS_UNAVAILABLE,
      message: `All suppliers failed for city "${city}"`,
      nonRetryable: true,
      details: [suppliers],
    });
  }

  // 2. De-duplicate by hotel name and keep the cheapest offer for each hotel.
  const hotels = selectBestOffers(lists);
  const partial = lists.length < SUPPLIER_IDS.length;
  const fetchedAt = new Date().toISOString(); // deterministic: workflow time

  // 3. Persist the de-duplicated snapshot to Redis (enables price filtering in Redis).
  let cached = false;
  try {
    await saveHotelOffers({
      city,
      hotels,
      suppliers,
      partial,
      workflowId,
      fetchedAt,
    });
    cached = true;
  } catch (err) {
    log.warn('Could not save hotel list to Redis; returning result uncached', {
      city,
      error: describeFailure(err),
    });
  }

  log.info('Hotel offers aggregated', {
    city,
    hotels: hotels.length,
    partial,
    cached,
  });
  return { city, hotels, suppliers, partial, cached, fetchedAt };
}

/** Unwraps ActivityFailure -> ApplicationFailure/TimeoutFailure to a readable message. */
function describeFailure(err: unknown): string {
  let current: unknown = err;
  let message = 'unknown error';
  while (current instanceof Error) {
    message = current.message || message;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return message;
}
