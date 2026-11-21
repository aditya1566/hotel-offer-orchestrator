/**
 * Domain types shared by the API, the Temporal workflow and activities.
 * This file (and everything in src/domain) must stay free of Node.js / I/O
 * imports because it is bundled into the deterministic workflow sandbox.
 */

export const SUPPLIER_IDS = ['A', 'B'] as const;
export type SupplierId = (typeof SUPPLIER_IDS)[number];

export const SUPPLIER_NAMES: Record<SupplierId, string> = {
  A: 'Supplier A',
  B: 'Supplier B',
};

/** Raw hotel record as returned by a supplier API. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** A supplier's list tagged with who it came from (activity output). */
export interface SupplierOffers {
  supplierId: SupplierId;
  supplier: string;
  hotels: SupplierHotel[];
}

/** The public response item (matches the assignment's response format). */
export interface HotelOffer {
  name: string;
  price: number;
  supplier: string;
  commissionPct: number;
}

export type SupplierOutcomeStatus = 'ok' | 'failed';

export interface SupplierOutcome {
  supplierId: SupplierId;
  supplier: string;
  status: SupplierOutcomeStatus;
  hotelCount: number;
  error?: string;
}

export interface HotelOffersWorkflowInput {
  city: string;
  requestId?: string;
}

export interface HotelOffersWorkflowResult {
  city: string;
  hotels: HotelOffer[];
  suppliers: SupplierOutcome[];
  /** True when at least one supplier failed and the list is built from the rest. */
  partial: boolean;
  /** True when the snapshot was persisted to Redis. */
  cached: boolean;
  fetchedAt: string;
}

/** Error type thrown by the workflow when no supplier could be reached. */
export const ALL_SUPPLIERS_UNAVAILABLE = 'AllSuppliersUnavailable';
/** Error type for supplier responses that can never succeed on retry. */
export const INVALID_SUPPLIER_RESPONSE = 'InvalidSupplierResponse';
export const SUPPLIER_CLIENT_ERROR = 'SupplierClientError';
