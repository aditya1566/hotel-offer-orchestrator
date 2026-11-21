import { Router } from 'express';
import type { HotelService } from '../hotel-service';
import { parseHotelsQuery } from '../validation';

/**
 * GET /api/hotels?city=delhi[&minPrice=..&maxPrice=..][&refresh=true]
 *
 * The body is exactly the array described in the assignment. Diagnostics are
 * exposed as response headers so the contract stays clean:
 *   X-Cache            HIT | MISS (MISS = a Temporal workflow ran for this request)
 *   X-Workflow-Id      Temporal workflow id that produced the data
 *   X-Price-Filter     redis | memory | none
 *   X-Partial-Result   true when a supplier failed and results come from the other one
 *   X-Supplier-Status  e.g. "Supplier A=ok; Supplier B=failed"
 *   X-Data-Fetched-At  when the suppliers were queried
 */
export function createHotelsRouter(service: HotelService): Router {
  const router = Router();

  router.get('/api/hotels', async (req, res) => {
    const query = parseHotelsQuery(req.query);
    const result = await service.getHotels({
      ...query,
      requestId: String(req.id),
    });

    res.set({
      'Cache-Control': 'no-store',
      'X-Cache': result.cache,
      'X-Price-Filter': result.filteredBy,
      'X-Partial-Result': String(result.partial),
      'X-Supplier-Status': result.suppliers.map((s) => `${s.supplier}=${s.status}`).join('; '),
      'X-Data-Fetched-At': result.fetchedAt,
      ...(result.workflowId ? { 'X-Workflow-Id': result.workflowId } : {}),
    });
    req.log.info(
      {
        city: query.city,
        minPrice: query.minPrice,
        maxPrice: query.maxPrice,
        cache: result.cache,
        workflowId: result.workflowId,
        partial: result.partial,
        count: result.hotels.length,
      },
      'Hotels served',
    );
    res.json(result.hotels);
  });

  return router;
}
