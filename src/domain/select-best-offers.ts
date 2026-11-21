import { hotelKey } from './normalize';
import type { HotelOffer, SupplierOffers } from './types';

interface Candidate extends HotelOffer {
  key: string;
}

/**
 * Is `a` a better offer than `b`?
 *  1. lower price wins (the assignment's rule);
 *  2. on an exact price tie, the higher commission wins (better margin for us);
 *  3. still tied: alphabetical supplier name, so the result is deterministic.
 */
export function isBetterOffer(a: HotelOffer, b: HotelOffer): boolean {
  if (a.price !== b.price) return a.price < b.price;
  if (a.commissionPct !== b.commissionPct) return a.commissionPct > b.commissionPct;
  return a.supplier < b.supplier;
}

/** Locale-independent string comparison (keeps workflow code deterministic). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort order of the final list: cheapest first, then by normalised name.
 * (Matches Redis ZRANGE ordering: score, then member, where member = hotelKey.)
 */
export function compareOffers(a: HotelOffer, b: HotelOffer): number {
  return a.price - b.price || compareStrings(hotelKey(a.name), hotelKey(b.name));
}

/**
 * Deduplicates hotels by (normalised) name across any number of supplier lists
 * and keeps the best offer for each hotel. Hotels returned by a single supplier
 * are kept as-is. Pure and deterministic, so it is safe to run inside a
 * Temporal workflow.
 */
export function selectBestOffers(lists: readonly SupplierOffers[]): HotelOffer[] {
  const best = new Map<string, Candidate>();

  for (const list of lists) {
    for (const hotel of list.hotels) {
      const candidate: Candidate = {
        key: hotelKey(hotel.name),
        name: hotel.name.trim(),
        price: hotel.price,
        supplier: list.supplier,
        commissionPct: hotel.commissionPct,
      };
      const current = best.get(candidate.key);
      if (!current || isBetterOffer(candidate, current)) {
        best.set(candidate.key, candidate);
      }
    }
  }

  return [...best.values()]
    .map(({ name, price, supplier, commissionPct }) => ({
      name,
      price,
      supplier,
      commissionPct,
    }))
    .sort(compareOffers);
}
