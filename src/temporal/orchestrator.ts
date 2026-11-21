import {
  Client,
  Connection,
  WorkflowFailedError,
  defaultGrpcRetryOptions,
  makeGrpcRetryInterceptor,
} from '@temporalio/client';
import { ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import { cityKey } from '../domain/normalize';
import { ALL_SUPPLIERS_UNAVAILABLE, type HotelOffersWorkflowResult, type SupplierOutcome } from '../domain/types';
import type { hotelOffersWorkflow } from './workflows';

export interface OrchestratorRun {
  workflowId: string;
  runId: string;
  result: HotelOffersWorkflowResult;
}

/** Abstraction used by the API so the service can be tested without Temporal. */
export interface HotelOffersOrchestrator {
  run(city: string, requestId?: string): Promise<OrchestratorRun>;
  /** Throws if the Temporal frontend is not serving. */
  checkHealth(): Promise<void>;
}

/** Thrown when the workflow ends because every supplier failed. */
export class AllSuppliersUnavailableError extends Error {
  constructor(
    message: string,
    readonly suppliers: SupplierOutcome[],
    readonly workflowId: string,
  ) {
    super(message);
    this.name = 'AllSuppliersUnavailableError';
  }
}

export class WorkflowTimedOutError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow ${workflowId} timed out`);
    this.name = 'WorkflowTimedOutError';
  }
}

export interface TemporalOrchestratorOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  workflowTimeoutMs: number;
}

export class TemporalHotelOffersOrchestrator implements HotelOffersOrchestrator {
  private readonly connection: Connection;
  private readonly client: Client;

  constructor(private readonly options: TemporalOrchestratorOptions) {
    // Lazy: the API can boot (and report health) before Temporal is reachable.
    // Fewer gRPC retries than the SDK default (10) so an outage surfaces as a 503 in seconds.
    this.connection = Connection.lazy({
      address: options.address,
      connectTimeout: '3s',
      interceptors: [
        makeGrpcRetryInterceptor(
          defaultGrpcRetryOptions({
            maxAttempts: 3,
            maxIntervalMs: () => 1_000,
          }),
        ),
      ],
    });
    this.client = new Client({
      connection: this.connection,
      namespace: options.namespace,
    });
  }

  /**
   * One workflow id per city + USE_EXISTING conflict policy = request coalescing:
   * concurrent requests for the same city join the in-flight run instead of
   * hammering the suppliers. Completed ids can be reused (new run each time).
   */
  async run(city: string, requestId?: string): Promise<OrchestratorRun> {
    const workflowId = `hotel-offers-${encodeURIComponent(cityKey(city))}`;
    const handle = await this.client.workflow.start<typeof hotelOffersWorkflow>('hotelOffersWorkflow', {
      taskQueue: this.options.taskQueue,
      workflowId,
      args: [{ city: cityKey(city), requestId }],
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      workflowExecutionTimeout: this.options.workflowTimeoutMs,
      memo: requestId ? { requestId } : undefined,
    });

    try {
      const result = await handle.result();
      return { workflowId, runId: handle.firstExecutionRunId, result };
    } catch (err) {
      throw translateWorkflowError(err, workflowId);
    }
  }

  async checkHealth(): Promise<void> {
    await this.connection.ensureConnected();
    const { status } = await this.connection.healthService.check({});
    // grpc.health.v1.HealthCheckResponse.ServingStatus.SERVING === 1
    if (status !== 1) throw new Error(`Temporal frontend is not serving (status ${String(status)})`);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

function translateWorkflowError(err: unknown, workflowId: string): unknown {
  if (!(err instanceof WorkflowFailedError)) return err;
  const cause = err.cause;
  if (cause instanceof ApplicationFailure && cause.type === ALL_SUPPLIERS_UNAVAILABLE) {
    const suppliers = (cause.details?.[0] as SupplierOutcome[] | undefined) ?? [];
    return new AllSuppliersUnavailableError(cause.message, suppliers, workflowId);
  }
  if (cause instanceof TimeoutFailure) return new WorkflowTimedOutError(workflowId);
  return err;
}
