/**
 * Canonical key for comparing hotel names across suppliers:
 * trims, collapses internal whitespace and lower-cases, so
 * "ITC Maurya", " itc  maurya " and "ITC MAURYA" are the same hotel.
 */
export function hotelKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Canonical city key (same rules as hotel names). */
export function cityKey(city: string): string {
  return hotelKey(city);
}
