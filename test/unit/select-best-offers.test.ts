import { describe, expect, it } from 'vitest';
import { hotelKey } from '../../src/domain/normalize';
import { isBetterOffer, selectBestOffers } from '../../src/domain/select-best-offers';
import type { SupplierHotel, SupplierOffers } from '../../src/domain/types';
import { SUPPLIER_CATALOGUE } from '../../src/suppliers/mock-data';

const hotel = (name: string, price: number, commissionPct = 10, id = name): SupplierHotel => ({
  hotelId: id,
  name,
  price,
  city: 'delhi',
  commissionPct,
});
const listA = (...hotels: SupplierHotel[]): SupplierOffers => ({
  supplierId: 'A',
  supplier: 'Supplier A',
  hotels,
});
const listB = (...hotels: SupplierHotel[]): SupplierOffers => ({
  supplierId: 'B',
  supplier: 'Supplier B',
  hotels,
});

describe('selectBestOffers', () => {
  it('picks the cheaper supplier for hotels present in both lists', () => {
    const result = selectBestOffers([
      listA(hotel('Holtin', 6000, 10), hotel('Radison', 5900, 13)),
      listB(hotel('Holtin', 5340, 20), hotel('Radison', 6100, 18)),
    ]);
    expect(result).toEqual([
      {
        name: 'Holtin',
        price: 5340,
        supplier: 'Supplier B',
        commissionPct: 20,
      },
      {
        name: 'Radison',
        price: 5900,
        supplier: 'Supplier A',
        commissionPct: 13,
      },
    ]);
  });

  it('keeps hotels that only one supplier returns', () => {
    const result = selectBestOffers([listA(hotel('Only A', 100)), listB(hotel('Only B', 200))]);
    expect(result.map((h) => [h.name, h.supplier])).toEqual([
      ['Only A', 'Supplier A'],
      ['Only B', 'Supplier B'],
    ]);
  });

  it('treats names that differ only by case/whitespace as the same hotel', () => {
    const result = selectBestOffers([listA(hotel('ITC Maurya', 9800)), listB(hotel(' itc  maurya ', 10200))]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'ITC Maurya',
      price: 9800,
      supplier: 'Supplier A',
    });
  });

  it('breaks exact price ties by higher commission, then supplier name', () => {
    expect(
      selectBestOffers([listA(hotel('The Leela', 11000, 12)), listB(hotel('The Leela', 11000, 16))])[0],
    ).toMatchObject({ supplier: 'Supplier B', commissionPct: 16 });
    expect(selectBestOffers([listB(hotel('Twin', 100, 10)), listA(hotel('Twin', 100, 10))])[0]).toMatchObject({
      supplier: 'Supplier A',
    });
  });

  it('dedupes duplicates within a single supplier list too', () => {
    const result = selectBestOffers([listA(hotel('Dup', 300, 5, 'x1'), hotel('Dup', 250, 5, 'x2'))]);
    expect(result).toEqual([{ name: 'Dup', price: 250, supplier: 'Supplier A', commissionPct: 5 }]);
  });

  it('returns results sorted by price ascending', () => {
    const result = selectBestOffers([listA(hotel('C', 300), hotel('A', 100)), listB(hotel('B', 200))]);
    expect(result.map((h) => h.price)).toEqual([100, 200, 300]);
  });

  it('returns an empty list when there is nothing to compare', () => {
    expect(selectBestOffers([])).toEqual([]);
    expect(selectBestOffers([listA(), listB()])).toEqual([]);
  });

  it('is order-independent (same answer whichever supplier answers first)', () => {
    const a = listA(hotel('Holtin', 6000), hotel('X', 10, 1));
    const b = listB(hotel('Holtin', 5340), hotel('X', 10, 2));
    expect(selectBestOffers([a, b])).toEqual(selectBestOffers([b, a]));
  });

  it('on the real mock catalogue: every hotel appears once at the minimum price seen across suppliers', () => {
    const delhi = (id: 'A' | 'B') => SUPPLIER_CATALOGUE[id].filter((h) => h.city === 'delhi');
    const result = selectBestOffers([listA(...delhi('A')), listB(...delhi('B'))]);

    const all = [...delhi('A'), ...delhi('B')];
    const keys = new Set(all.map((h) => hotelKey(h.name)));
    expect(result).toHaveLength(keys.size);
    for (const offer of result) {
      const min = Math.min(...all.filter((h) => hotelKey(h.name) === hotelKey(offer.name)).map((h) => h.price));
      expect(offer.price).toBe(min);
    }
  });
});

describe('isBetterOffer', () => {
  it('prefers lower price over higher commission', () => {
    expect(
      isBetterOffer(
        { name: 'h', price: 99, supplier: 'Supplier B', commissionPct: 1 },
        { name: 'h', price: 100, supplier: 'Supplier A', commissionPct: 50 },
      ),
    ).toBe(true);
  });
});
