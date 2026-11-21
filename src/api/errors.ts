import { ServiceError } from '@temporalio/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AllSuppliersUnavailableError, WorkflowTimedOutError } from '../temporal/orchestrator';

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

/** Converts known domain / infrastructure errors to HttpErrors. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;

  if (err instanceof AllSuppliersUnavailableError) {
    return new HttpError(502, 'SUPPLIERS_UNAVAILABLE', 'No supplier could be reached. Please try again shortly.', {
      workflowId: err.workflowId,
      suppliers: err.suppliers,
    });
  }
  if (err instanceof WorkflowTimedOutError) {
    return new HttpError(504, 'ORCHESTRATION_TIMEOUT', 'Aggregating hotel offers took too long.', {
      workflowId: err.workflowId,
    });
  }
  if (err instanceof ServiceError || isTemporalTransportError(err)) {
    return new HttpError(503, 'ORCHESTRATOR_UNAVAILABLE', 'The workflow engine (Temporal) is unavailable.');
  }

  const bodyParserError = err as { type?: string; status?: number };
  if (bodyParserError?.type === 'entity.parse.failed') {
    return new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
  if (bodyParserError?.type === 'entity.too.large') {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  }

  return new HttpError(500, 'INTERNAL_ERROR', 'Something went wrong.');
}

function isTemporalTransportError(err: unknown): boolean {
  return err instanceof Error && /TransportError|ConnectionError/.test(err.name);
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const httpError = toHttpError(err);
  const log = req.log;
  if (httpError.status >= 500) {
    log?.error({ err, code: httpError.code }, httpError.message);
  } else {
    log?.info({ code: httpError.code, message: httpError.message }, 'Request rejected');
  }

  if (res.headersSent) return;
  const body: ErrorBody = {
    error: {
      code: httpError.code,
      message: httpError.message,
      ...(httpError.details !== undefined ? { details: httpError.details } : {}),
    },
    requestId: typeof req.id === 'string' ? req.id : undefined,
  };
  res.status(httpError.status).json(body);
};
