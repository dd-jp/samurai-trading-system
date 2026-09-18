
import { classifyStatus, isServerErrorStatus, isTimeoutAbort } from '../../../shared/index.js';

export class PolygonBarsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolygonBarsTimeoutError';
  }
}

export class PolygonBarsRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolygonBarsRateLimitError';
  }
}

export class PolygonBarsProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PolygonBarsProviderError';
    this.status = status;
  }
}

export type PolygonBarsError =
  | PolygonBarsTimeoutError
  | PolygonBarsRateLimitError
  | PolygonBarsProviderError;

export function isRetryablePolygonBarsError(error: unknown): boolean {
  if (error instanceof PolygonBarsTimeoutError) return true;
  if (error instanceof PolygonBarsProviderError) return isServerErrorStatus(error.status);
  return false;
}

export function classifyPolygonBarsResponse(response: Response, context: string): PolygonBarsError {
  const message = `PolygonBarsClient: ${context} request failed with HTTP ${response.status}.`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new PolygonBarsRateLimitError(message);
    case 'timeout':
      return new PolygonBarsTimeoutError(message);
    default:
      return new PolygonBarsProviderError(message, response.status);
  }
}

export function classifyPolygonBarsNetworkError(error: unknown, context: string): PolygonBarsError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new PolygonBarsTimeoutError(
      `PolygonBarsClient: ${context} request timed out: ${message}`,
    );
  }
  return new PolygonBarsProviderError(`PolygonBarsClient: ${context} network error: ${message}`);
}
