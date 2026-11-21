import { z } from 'zod';
import { SUPPLIER_IDS, type SupplierId } from '../domain/types';

/**
 * In-memory fault injection for the mock suppliers, used to demonstrate how the
 * workflow behaves when a supplier is down, slow, flaky or returns garbage.
 *
 *  - up       normal behaviour
 *  - down     every request -> 503 Service Unavailable (retryable, then marked failed)
 *  - slow     responds after `delayMs` (set it above SUPPLIER_TIMEOUT_MS to force timeouts)
 *  - invalid  200 OK with a malformed body (non-retryable failure)
 *
 * `failNextRequests` makes the next N requests fail with 503 and then recover,
 * which shows Temporal's activity retries healing a transient outage.
 */
export const SUPPLIER_MODES = ['up', 'down', 'slow', 'invalid'] as const;
export type SupplierMode = (typeof SUPPLIER_MODES)[number];

export interface SupplierSimulationState {
  mode: SupplierMode;
  delayMs: number;
  failNextRequests: number;
}

export const simulationUpdateSchema = z
  .object({
    mode: z.enum(SUPPLIER_MODES).optional(),
    delayMs: z.number().int().min(0).max(60_000).optional(),
    failNextRequests: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one of mode, delayMs, failNextRequests',
  });

export type SimulationUpdate = z.infer<typeof simulationUpdateSchema>;

const DEFAULT_STATE: SupplierSimulationState = {
  mode: 'up',
  delayMs: 5_000,
  failNextRequests: 0,
};

export type SimulationDecision =
  { kind: 'ok'; delayMs: number } | { kind: 'unavailable'; reason: string } | { kind: 'invalid' };

export class SupplierSimulation {
  private readonly state = new Map<SupplierId, SupplierSimulationState>();

  constructor() {
    this.reset();
  }

  reset(): void {
    for (const id of SUPPLIER_IDS) this.state.set(id, { ...DEFAULT_STATE });
  }

  get(id: SupplierId): SupplierSimulationState {
    return { ...(this.state.get(id) ?? DEFAULT_STATE) };
  }

  all(): Record<SupplierId, SupplierSimulationState> {
    return Object.fromEntries(SUPPLIER_IDS.map((id) => [id, this.get(id)])) as Record<
      SupplierId,
      SupplierSimulationState
    >;
  }

  update(id: SupplierId, patch: SimulationUpdate): SupplierSimulationState {
    const next = { ...this.get(id), ...patch };
    this.state.set(id, next);
    return { ...next };
  }

  /** Decides how the next request to supplier `id` should behave (and consumes failNextRequests). */
  next(id: SupplierId): SimulationDecision {
    const s = this.state.get(id) ?? { ...DEFAULT_STATE };
    if (s.failNextRequests > 0) {
      s.failNextRequests -= 1;
      this.state.set(id, s);
      return {
        kind: 'unavailable',
        reason: `transient failure (${s.failNextRequests} more to go)`,
      };
    }
    switch (s.mode) {
      case 'down':
        return { kind: 'unavailable', reason: 'supplier is down' };
      case 'invalid':
        return { kind: 'invalid' };
      case 'slow':
        return { kind: 'ok', delayMs: s.delayMs };
      default:
        return { kind: 'ok', delayMs: 0 };
    }
  }
}

/** Accepts "A", "a", "supplierA", "supplier-a" ... and returns the canonical id. */
export function parseSupplierId(raw: string): SupplierId | undefined {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/^SUPPLIER[-_ ]?/, '');
  return (SUPPLIER_IDS as readonly string[]).includes(cleaned) ? (cleaned as SupplierId) : undefined;
}
