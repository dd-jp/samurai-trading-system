/**
 * The ambient tick `trace_id`, for log sites too deep to be handed one.
 *
 * ## Why ambient rather than a parameter
 *
 * `trace_id` is already threaded explicitly wherever a signature can carry it,
 * and that remains the preferred form — an explicit parameter is visible at
 * the call site and cannot be silently lost. This exists for the sites where
 * that is not available: `TokenBucket.logIfMaterialWait` sits in
 * `shared/http`, four layers below the pipeline, and `MarketDataService`'s
 * fetch telemetry says so in its own doc — *"`trace_id` (no
 * `MarketDataService` method accepts one)"*. Threading one to either would
 * mean adding a parameter to every `DataSource` implementation, live and
 * fixture alike, to carry a value used only for a log line.
 *
 * ## What it fixes
 *
 * Before this, those sites logged a constant category label in the `trace_id`
 * field — `'token-bucket'`, `'market-data'`. The field therefore held two
 * different kinds of thing, and the practical cost was that the log could
 * state both halves of a diagnosis and join neither: a 10s technical-analyst
 * timeout and multi-second Alpaca pacing in the same window, with no key
 * connecting them. `MarketDataService`'s own doc records that the technical
 * analyst issues 8 `getBars` windows per tick, so those fetches are inside
 * the tick that later reports the timeout.
 *
 * ## The fallback is the point
 *
 * `currentTraceId()` returns `undefined` outside a tick, and every call site
 * keeps its existing constant for that case. So this does not assert which
 * calls are in-tick — it answers that per call, at runtime, and the log then
 * records the truth either way. A scheduled market-intelligence refresh
 * (#1085 moved it off the analyst's critical path) genuinely has no tick and
 * correctly keeps `'market-data'`.
 *
 * Note that `TokenBucket`'s `background` lane is a PRIORITY, not a
 * provenance: `alpaca-http-client.ts` takes `acquireBackground()` for bar
 * fetches so "a bar burst can never park an order behind the refill", and
 * those fetches serve the analyst inside the tick. A `background` line is
 * therefore not evidence of running outside one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `trace_id` readable by `currentTraceId()`, including across
 * every `await` inside it.
 *
 * Nested calls shadow rather than merge: the innermost wins, which is what a
 * caller establishing a narrower scope means. Nothing nests today.
 */
export function runWithTraceId<T>(trace_id: string, fn: () => T): T {
  return storage.run(trace_id, fn);
}

/** The enclosing tick's `trace_id`, or `undefined` outside one. */
export function currentTraceId(): string | undefined {
  return storage.getStore();
}
