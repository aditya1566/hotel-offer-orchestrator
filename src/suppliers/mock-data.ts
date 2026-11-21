import type { SupplierHotel, SupplierId } from '../domain/types';

/**
 * Static catalogue for the two mock suppliers.
 *
 * Delhi is the showcase city and deliberately covers every comparison case:
 *  - overlap where B is cheaper .......... Holtin (B 5340 < A 6000), Taj Palace (B 11800 < A 12500)
 *  - overlap where A is cheaper .......... Radison (A 5900 < B 6100)
 *  - exact price tie ..................... The Leela (11000 both; higher commission wins -> B)
 *  - same hotel, different spelling ...... "ITC Maurya" (A 9800) vs " itc  maurya " (B 10200)
 *  - only in A ........................... Lemon Tree Premier
 *  - only in B ........................... Bloomrooms, The Oberoi
 * Mumbai has a smaller overlap; Bangalore is served by Supplier A only.
 * Any other city (e.g. "goa") returns an empty list from both suppliers.
 */
export const SUPPLIER_CATALOGUE: Record<SupplierId, SupplierHotel[]> = {
  A: [
    // delhi
    {
      hotelId: 'a1',
      name: 'Holtin',
      price: 6000,
      city: 'delhi',
      commissionPct: 10,
    },
    {
      hotelId: 'a2',
      name: 'Radison',
      price: 5900,
      city: 'delhi',
      commissionPct: 13,
    },
    {
      hotelId: 'a3',
      name: 'Taj Palace',
      price: 12500,
      city: 'delhi',
      commissionPct: 15,
    },
    {
      hotelId: 'a4',
      name: 'The Leela',
      price: 11000,
      city: 'delhi',
      commissionPct: 12,
    },
    {
      hotelId: 'a5',
      name: 'ITC Maurya',
      price: 9800,
      city: 'delhi',
      commissionPct: 14,
    },
    {
      hotelId: 'a6',
      name: 'Lemon Tree Premier',
      price: 3200,
      city: 'delhi',
      commissionPct: 8,
    },
    {
      hotelId: 'a7',
      name: 'Hyatt Regency',
      price: 8700,
      city: 'delhi',
      commissionPct: 11,
    },
    // mumbai
    {
      hotelId: 'a8',
      name: 'Trident',
      price: 9100,
      city: 'mumbai',
      commissionPct: 12,
    },
    {
      hotelId: 'a9',
      name: 'Holtin',
      price: 7400,
      city: 'mumbai',
      commissionPct: 10,
    },
    {
      hotelId: 'a10',
      name: 'Sea Princess',
      price: 6800,
      city: 'mumbai',
      commissionPct: 9,
    },
    // bangalore (Supplier A only)
    {
      hotelId: 'a11',
      name: 'The Oberoi',
      price: 10400,
      city: 'bangalore',
      commissionPct: 15,
    },
    {
      hotelId: 'a12',
      name: 'Radison',
      price: 6300,
      city: 'bangalore',
      commissionPct: 13,
    },
  ],
  B: [
    // delhi
    {
      hotelId: 'b1',
      name: 'Holtin',
      price: 5340,
      city: 'delhi',
      commissionPct: 20,
    },
    {
      hotelId: 'b2',
      name: 'Radison',
      price: 6100,
      city: 'delhi',
      commissionPct: 18,
    },
    {
      hotelId: 'b3',
      name: 'Taj Palace',
      price: 11800,
      city: 'delhi',
      commissionPct: 10,
    },
    {
      hotelId: 'b4',
      name: 'The Leela',
      price: 11000,
      city: 'delhi',
      commissionPct: 16,
    },
    {
      hotelId: 'b5',
      name: ' itc  maurya ',
      price: 10200,
      city: 'delhi',
      commissionPct: 9,
    },
    {
      hotelId: 'b6',
      name: 'Bloomrooms',
      price: 2100,
      city: 'delhi',
      commissionPct: 5,
    },
    {
      hotelId: 'b7',
      name: 'The Oberoi',
      price: 15000,
      city: 'delhi',
      commissionPct: 17,
    },
    // mumbai
    {
      hotelId: 'b8',
      name: 'Trident',
      price: 8800,
      city: 'mumbai',
      commissionPct: 11,
    },
    {
      hotelId: 'b9',
      name: 'Holtin',
      price: 7900,
      city: 'mumbai',
      commissionPct: 16,
    },
    {
      hotelId: 'b10',
      name: 'Taj Mahal Palace',
      price: 18500,
      city: 'mumbai',
      commissionPct: 18,
    },
  ],
};
