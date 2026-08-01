/**
 * Client-slice rate limiting (execution-spec.md story 16). Wraps an injected
 * broker/data client so every method call first takes a token from the
 * limiter — one wrap at construction instead of an `acquire()` sprinkled in
 * front of every call site, so a new client method cannot forget to pace
 * itself.
 *
 * Only for all-async client slices (every injected broker client here is):
 * the proxy makes each method's result awaitable behind the limiter.
 */
import type { RateLimiter } from './token-bucket.js';

export function rateLimited<T extends object>(client: T, limiter: RateLimiter): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]): Promise<unknown> => {
        await limiter.acquire();
        return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
