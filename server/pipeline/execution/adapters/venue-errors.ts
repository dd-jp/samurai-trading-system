
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class VenueTimeoutError extends Error {
  readonly method: HttpMethod;

  constructor(message: string, method: HttpMethod) {
    super(message);
    this.name = new.target.name;
    this.method = method;
  }
}

export class VenueRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly method: HttpMethod;

  constructor(message: string, method: HttpMethod, retryAfterMs?: number) {
    super(message);
    this.name = new.target.name;
    this.method = method;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRetrySafeMethod(method: HttpMethod | undefined): boolean {
  return method === 'GET' || method === 'DELETE';
}
