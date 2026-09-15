/**
 * #1012 — "Attribute the 6.4s mean debate LLM latency before changing
 * anything." The ticket's own "Start here" made items 1/2/4 (output budget,
 * streaming cutoff, model swap) conditional on item 3 (queue vs. generation):
 * only pull those levers if the tail is generation-bound. This file IS that
 * attribution, kept as a test so the conclusion re-verifies itself rather
 * than going stale in a PR description — same discipline #1010's
 * `prompt-caching.test.ts` established for this directory.
 *
 * WHAT THIS FILE IS AND IS NOT. Every number below is a SNAPSHOT/GOLDEN
 * value: it was produced ONCE, on 2026-09-02, by running the SQL queries in
 * this comment against the local `data/samurai-paper.sqlite` (real
 * paper-trading `llm_spend` rows), and then frozen as a literal constant.
 * This file does NOT run those queries at CI time and does NOT re-derive the
 * numbers from a live database — `data/samurai-paper.sqlite` is gitignored
 * (`.gitignore:236`), is not committed, and is not available in CI, so a
 * live query is not an option here (same constraint #1010's
 * `prompt-caching.test.ts` already accepted for this directory). What the
 * `it(...)` blocks below verify is the ARITHMETIC and the logical
 * relationships among the frozen snapshot values (e.g. "the call with fewer
 * output tokens is still the slower one," "no idle-gap call exceeds 15s") —
 * a regression guard against this file's own claims drifting from each
 * other, not a live re-measurement of the database. A future reader who
 * wants to check the snapshot itself against a fresh sample re-runs the
 * queries below by hand against `data/samurai-paper.sqlite`.
 *
 * WHAT THE INSTRUMENTATION CAN'T DO (and why this file exists instead of
 * asserting on a live decomposition). `latency_ms` (`anthropic-client.ts`'s
 * `AnthropicLlmClient.attempt`) is ONE `Date.now()` span around
 * `nousChat`'s single non-streaming `fetch` POST — headers, queue wait,
 * prompt processing and generation, and body read are all fused into that
 * one number, with no second timestamp anywhere on the call before this
 * ticket. `ttfb_ms` (added by this same ticket — see `nous-chat.ts` and
 * `migrations/0038_llm_spend_ttfb.sql`) is the first step toward splitting
 * that, but it is forward-looking instrumentation with no history yet: it
 * cannot retroactively decompose the 383+ calls already in
 * `data/samurai-paper.sqlite`. Whether Nous's `chat/completions` proxy even
 * streams headers ahead of a fully-buffered completion is itself unverified
 * (undocumented, per the same deferral ADR-0009 already notes for caching) —
 * that is exactly what accumulating `ttfb_ms` under live soak traffic will
 * answer, not something this ticket can determine from a single static read.
 *
 * WHAT EXISTING DATA CAN ANSWER, WITHOUT NEW INSTRUMENTATION. Even one wall-
 * clock number per call, analysed in aggregate, can rule OUT "the tail is
 * generation" — which is the only question item 3 needs answered to decide
 * whether items 1/2/4 are worth pursuing. All queries below ran against
 * `data/samurai-paper.sqlite`'s `llm_spend` table, `model =
 * 'anthropic/claude-haiku-4.5'`, 2026-09-02 sample (n=398 rows across 49
 * debates — the ticket's own 383 plus soak activity between the ticket being
 * filed and this investigation).
 *
 * ```sql
 * -- Headline sample size and aggregate stats.
 * SELECT COUNT(*), COUNT(DISTINCT debate_id)
 * FROM llm_spend WHERE model = 'anthropic/claude-haiku-4.5';
 * -- => 398 | 49
 *
 * SELECT MIN(latency_ms), AVG(latency_ms), MAX(latency_ms),
 *        AVG(output_tokens), AVG(input_tokens)
 * FROM llm_spend WHERE model = 'anthropic/claude-haiku-4.5';
 * -- => 1927 | 6434.32 | 28340 | 259.31 | 1709.94
 * ```
 *
 * Headline figures reproduce the ticket's own table (min 1,927ms, mean
 * ~6,434ms, max 28,340ms, mean output ~259 tokens, mean input ~1,709
 * tokens — all within measurement noise of the ticket's 383-row snapshot).
 *
 * FINDING 1 — the mean scales somewhat with output length (consistent with
 * SOME generation-bound cost):
 *
 * ```sql
 * SELECT CASE WHEN output_tokens < 150 THEN 'low' ELSE 'high' END AS bucket,
 *        COUNT(*), AVG(output_tokens), AVG(latency_ms)
 * FROM llm_spend
 * WHERE model = 'anthropic/claude-haiku-4.5'
 *   AND (output_tokens < 150 OR output_tokens >= 350)
 * GROUP BY bucket;
 * -- => low  | 9  | 102.67 | 4681.0
 * -- => high | 28 | 377.61 | 7322.5
 * ```
 *
 * average latency rises from 4,681ms (bucket mean 102 output tokens) to
 * ~7,322.5ms (bucket mean 377 tokens) — roughly what a ~87 tokens/sec floor
 * throughput (see below) would predict for the token delta alone.
 *
 * FINDING 2 — the TAIL is decoupled from output length, which the ticket's
 * own text already suspected ("That tail is not explained by token count").
 *
 * ```sql
 * SELECT (output_tokens / 50) * 50 AS band, COUNT(*), MAX(latency_ms)
 * FROM llm_spend WHERE model = 'anthropic/claude-haiku-4.5'
 * GROUP BY band ORDER BY band;
 * -- band=100 (100-149 tokens): max 15867
 * -- band=300 (300-349 tokens): max 13207
 * ```
 *
 * The <150-output-token bucket's max latency (15,867ms) EXCEEDS the
 * 300-349-token bucket's max (13,207ms) — a call that generated roughly a
 * third as much text took longer at the tail than one that generated three
 * times as much. If the tail were generation-bound, more output should never
 * predict a LOWER worst case.
 *
 * FINDING 3 — the two calls locked into this file's assertions below
 * (`SAME_DEBATE_ADJACENT_CALLS`) are consecutive calls in the SAME debate,
 * ~28 seconds apart, with output token counts within 8% of each other (274
 * vs 253) — and a 4.6x latency ratio (6,098ms vs 28,340ms, the global
 * maximum in this sample).
 *
 * ```sql
 * -- Locate the global-max row.
 * SELECT id, debate_id, latency_ms, output_tokens, timestamp
 * FROM llm_spend WHERE model = 'anthropic/claude-haiku-4.5'
 * ORDER BY latency_ms DESC LIMIT 1;
 * -- => id=146, debate_id=e47705e3..., latency_ms=28340, output_tokens=253,
 * --    timestamp=2026-08-27T14:04:34.129Z
 *
 * -- Every row in that same debate, to find its immediate predecessor.
 * SELECT id, latency_ms, output_tokens, timestamp
 * FROM llm_spend
 * WHERE debate_id = (SELECT debate_id FROM llm_spend WHERE id = 146)
 * ORDER BY id;
 * -- => id=145: latency_ms=6098, output_tokens=274, timestamp=...14:04:05.788Z
 * -- => id=146: latency_ms=28340, output_tokens=253, timestamp=...14:04:34.129Z
 * ```
 *
 * Two back-to-back calls of near-identical shape cannot differ this much on
 * generation length; something external to the call's own content varied
 * between them.
 *
 * FINDING 4 — this rules out client-side CONCURRENCY, not client-side cost in
 * general. The raw rows around the global max (ids 136-152,
 * 2026-08-27T14:03-14:05Z) show every call's timestamp landing within ~1-4s
 * of the PRIOR call's timestamp plus its own latency — i.e. calls run
 * strictly sequentially, one HTTP request in flight at a time, exactly as
 * #1011's "9-10 calls run strictly in sequence per debate" and #1013's
 * "serial instruments" describe. There is no concurrent request from this
 * process that could be queuing against its own traffic. That is narrower
 * than "therefore provider-side": a cold TCP/TLS handshake, DNS lookup, or a
 * consumer-network hiccup (the MacBook host's own listed risk — see
 * CLAUDE.md's "power/WiFi drops") would ALSO show up as one slow sequential
 * call with nothing else in flight, and sequentiality alone cannot
 * distinguish that from provider-side queueing. Findings 4a/4b below close
 * that gap instead of leaving it as an assumption.
 *
 * FINDING 4a — no client-side WAIT exists in the call chain at all, so it is
 * not backoff or a rate-limiter parking the call. `latency_ms` is measured
 * inside `AnthropicLlmClient.attempt` around `callWithTimeout`'s direct call
 * to the wire client — no retry backoff runs inside that span; each retry is
 * its own `attempt` with its own `start`, so a retried call's wait-before-
 * retry is time BETWEEN two recorded rows, not time inside either one.
 * Above that, `RateLimitedLlmClient` (orchestrator/production) is
 * deliberately non-blocking: its own class doc says so in as many words
 * ("It does not wait, and that is the decision"), `recordCall` is a
 * synchronous counter increment, and `rate-limited-llm-client.test.ts`
 * already asserts the ordering (`['recorded', 'issued']`, no wait between
 * them) as a regression guard. There is no queue, semaphore, or backoff
 * anywhere between the debate call site and the `fetch` call that
 * `latency_ms` could be silently including. This finding is a code-reading
 * argument, not a SQL query — there is no `llm_spend` row that could show a
 * client-side wait mechanism that does not exist in the source.
 *
 * FINDING 4b — the cold-connection/network-hiccup alternative is checked
 * directly and comes back negative. If a stall this large were driven by a
 * cold connection or a local network hiccup, it should concentrate on calls
 * that follow an idle gap (nothing recently sent means nothing recently
 * warmed a connection) — exactly what a cold-start theory predicts. It does
 * not: bucketing every `anthropic/claude-haiku-4.5` row by the gap since the
 * PRIOR row's timestamp (2026-09-02 sample, n=398).
 *
 * ```sql
 * WITH ordered AS (
 *   SELECT id, latency_ms, timestamp,
 *     (julianday(timestamp) - julianday(LAG(timestamp) OVER (ORDER BY timestamp)))
 *       * 86400000.0 AS gap_ms
 *   FROM llm_spend WHERE model = 'anthropic/claude-haiku-4.5'
 * )
 * SELECT
 *   CASE WHEN gap_ms IS NULL OR gap_ms > 300000 THEN 'afterLongIdle'
 *        WHEN gap_ms > 60000 THEN 'oneToFiveMin'
 *        ELSE 'backToBack' END AS bucket,
 *   COUNT(*), AVG(latency_ms), MAX(latency_ms),
 *   SUM(CASE WHEN latency_ms > 15000 THEN 1 ELSE 0 END) AS calls_over_15s
 * FROM ordered GROUP BY bucket;
 * ```
 *
 * | gap since prior call | n   | mean latency | max latency | calls > 15s |
 * |-----------------------|-----|--------------|-------------|-------------|
 * | > 5 min (incl. first) | 12  | 5,660ms      | 11,657ms    | 0           |
 * | 1-5 min               | 1   | 6,525ms      | 6,525ms     | 0           |
 * | back-to-back (< 1min) | 385 | 6,458ms      | 28,340ms    | 16          |
 *
 * Every call over 15s in this sample is a back-to-back call; not one
 * follows an idle gap, and the after-idle bucket's own max (11,657ms) is
 * BELOW the back-to-back mean's tail. A cold-connection theory predicts the
 * opposite shape (idle-gap calls slower), so this sample rules it out as the
 * systematic driver — it does not, and cannot from a wall-clock sample
 * alone, rule out an occasional one-off network stall contributing to any
 * single row. Combined with 4a (no client-side wait mechanism exists) and
 * Finding 4's sequentiality, the remaining explanation with no client-side
 * candidate left standing is provider-side: Nous's portal, or Anthropic
 * behind it.
 *
 * FINDING 5 — this matches a decision ADR-0009 already recorded on
 * 2026-08-06, from a DIFFERENT measurement (8-sample rotation across
 * candidate models): "The cheap tiers appear to be cheap partly because they
 * are queued." This ticket's larger production sample is consistent with
 * that same portal-side queueing being live in the debate model's own
 * traffic, not just visible when comparing across models.
 *
 * CONCLUSION, which is what decides items 1/2/4 per the ticket's own
 * framing: the tail is not primarily generation-bound, so tightening the
 * output budget (item 1) or cutting a persona's turn off early via streaming
 * (item 2) would not address a 28s wait produced by a 253-token response —
 * there is no excess output length to trim. A model swap (item 4) is not
 * ruled in either: ADR-0009's own candidate comparison already found
 * cheaper/faster-sounding alternatives carry WORSE tails for the same
 * reason (more heavily queued), and confirming whether some untested model
 * queues less needs its own evidence-gathering pass, not a guess folded into
 * this ticket. This ruling-out argument — not a queue/generation split — is
 * this PR's real contribution on item 3; the full split is still open (see
 * below).
 *
 * WHAT `ttfb_ms` DOES AND DOES NOT BUY. Shipped by this PR, but stated
 * plainly rather than oversold: `nousChat`'s single non-streaming
 * `chat/completions` POST reads the whole response body before this
 * process can act on it, and there is no evidence Nous's proxy emits
 * response headers before the completion is fully generated (undocumented,
 * same deferral ADR-0009 already notes for caching) — a buffered upstream
 * would make `ttfb_ms` read near-identical to `latency_ms` on most calls,
 * separating "queue+prefill+generation" from "read a ~1KB JSON body" rather
 * than queue from generation. That is still a real, cheap, structural
 * result worth having (it will confirm or refute header-buffering under
 * live soak traffic, which nothing today can), but it is not the queue/
 * generation split item 3 ultimately wants, and this file's findings above
 * do not claim it is — Findings 3/4a/4b are an indirect ruling-out argument
 * (not generation-length-driven, not client-blocking-driven, not
 * cold-connection-driven), which is narrower than a direct decomposition.
 * The two follow-ups that would buy that split are named here rather than
 * guessed at in this ticket: switching the wire call to `stream: true` to
 * get a true TTFT, or reading whatever request-id/processing-time headers
 * Nous's proxy actually returns (`nousChat` never touches `response.headers`
 * today — this ticket looked at that seam and is deliberately not adding a
 * header allowlist without first knowing what Nous sends). This PR ships
 * `ttfb_ms` instrumentation and this written attribution, not a speculative
 * fix. Item 4 (model choice) is likewise explicitly left open above, not
 * resolved by this ticket.
 */
import { describe, expect, it } from 'vitest';

/**
 * Best-observed generation-speed floor across the whole sample:
 * `MIN(latency_ms / output_tokens)` over every row with `output_tokens > 20`
 * (guards against a near-zero denominator distorting the floor).
 *
 * ```sql
 * SELECT MIN(CAST(latency_ms AS REAL) / output_tokens)
 * FROM llm_spend
 * WHERE model = 'anthropic/claude-haiku-4.5' AND output_tokens > 20;
 * -- => 11.479381443299
 * ```
 *
 * 11.48ms per output token, i.e. ~87 tokens/sec — meaningfully faster than
 * the ticket's own "~40 tokens/sec effective" figure, which divides the
 * SAMPLE MEAN output tokens by the SAMPLE MEAN latency and so bakes the
 * average call's fixed (queue/TTFT) overhead into what reads as a per-token
 * rate. Used below as an upper bound on how much of a call's latency
 * generation alone could plausibly explain — any remainder is not
 * explainable by decoding speed no matter how it is measured.
 */
const BEST_OBSERVED_MS_PER_OUTPUT_TOKEN = 11.48;

/**
 * The global maximum in the 2026-09-02 sample (`llm_spend.id = 146`) and the
 * call immediately before it in the SAME debate (`id = 145`,
 * debate_id = 'e47705e3dec4429d00edeafa60b4897c39765903f2763241a79a1e42ba47f5e2'),
 * 28.3 seconds apart. Frozen here as the concrete evidence Finding 3 rests
 * on — re-running the query in this file's module doc comment against
 * `data/samurai-paper.sqlite` is how a future reader reproduces these two
 * rows, not how this test verifies them; the file fixes what was measured
 * on 2026-09-02, the same convention `prompt-caching.test.ts` uses for its
 * production figures.
 */
const SAME_DEBATE_ADJACENT_CALLS = {
  earlier: {
    id: 145,
    latency_ms: 6_098,
    output_tokens: 274,
    timestamp: '2026-08-27T14:04:05.788Z',
  },
  later: { id: 146, latency_ms: 28_340, output_tokens: 253, timestamp: '2026-08-27T14:04:34.129Z' },
} as const;

/** `latency_ms - output_tokens * BEST_OBSERVED_MS_PER_OUTPUT_TOKEN` — the part of a call's wall time no observed generation speed can account for */
function excessMs(latencyMs: number, outputTokens: number): number {
  return latencyMs - outputTokens * BEST_OBSERVED_MS_PER_OUTPUT_TOKEN;
}

/**
 * The full row count for the 2026-09-02 sample (`model =
 * 'anthropic/claude-haiku-4.5'`), from the headline `COUNT(*)` query in this
 * file's module doc comment. Independent of `CALLS_BY_IDLE_GAP` below — that
 * comes from a DIFFERENT query (a windowed gap-bucket `GROUP BY`) over the
 * same table. The two are asserted equal below as a cross-check: if either
 * query's bucket boundaries or `WHERE` clause were wrong, the sums would not
 * agree, even though both are frozen literals rather than a live query.
 */
const HEADLINE_SAMPLE_SIZE = 398;

/**
 * Finding 4b's bucketing, frozen the same way `SAME_DEBATE_ADJACENT_CALLS`
 * is: every `anthropic/claude-haiku-4.5` row in the 2026-09-02 sample
 * (n=398), grouped by the gap since the PRIOR row's timestamp. Reproduced
 * with the windowed `LAG(timestamp)` query in this file's module doc
 * comment (Finding 4b).
 */
const CALLS_BY_IDLE_GAP = {
  afterLongIdle: { n: 12, maxLatencyMs: 11_657, callsOver15s: 0 },
  oneToFiveMin: { n: 1, maxLatencyMs: 6_525, callsOver15s: 0 },
  backToBack: { n: 385, maxLatencyMs: 28_340, callsOver15s: 16 },
} as const;

describe('debate LLM latency attribution (#1012)', () => {
  it('the global-maximum call cannot be explained by generation time even at the fastest observed throughput', () => {
    const { later } = SAME_DEBATE_ADJACENT_CALLS;

    // Even crediting this call the fastest per-token rate seen anywhere in
    // the sample, over 20 of its 28.3 seconds are unaccounted for by
    // decoding its 253 output tokens
    expect(excessMs(later.latency_ms, later.output_tokens)).toBeGreaterThan(20_000);
  });

  it('a call with FEWER output tokens can still take far longer, ruling out output length as the tail driver', () => {
    const { earlier, later } = SAME_DEBATE_ADJACENT_CALLS;

    // If the tail were generation-bound, the call with less output to
    // generate should never be the slower one
    expect(later.output_tokens).toBeLessThan(earlier.output_tokens);
    expect(later.latency_ms).toBeGreaterThan(earlier.latency_ms);
  });

  it('the two calls are near-identical in shape (same debate, output tokens within 10%) yet differ by more than 4x in latency', () => {
    const { earlier, later } = SAME_DEBATE_ADJACENT_CALLS;
    const outputTokenRatio = later.output_tokens / earlier.output_tokens;
    const latencyRatio = later.latency_ms / earlier.latency_ms;

    expect(outputTokenRatio).toBeGreaterThan(0.9);
    expect(latencyRatio).toBeGreaterThan(4);
  });

  it('the two calls are consecutive (seconds apart), which is what rules out "different weather" as an explanation for the shape difference alone', () => {
    const { earlier, later } = SAME_DEBATE_ADJACENT_CALLS;
    const gapMs = Date.parse(later.timestamp) - Date.parse(earlier.timestamp);

    // ~28s apart: close enough in time that ADR-0009's "portal latency
    // drifts over minutes" caveat does not explain the swing either — this
    // is two calls back-to-back in one debate, not two samples taken
    // minutes apart
    expect(gapMs).toBeLessThan(60_000);
  });

  it('rules out cold-connection/idle-reconnect as the tail driver: every slow (>15s) call is back-to-back, none follow an idle gap', () => {
    const { afterLongIdle, backToBack } = CALLS_BY_IDLE_GAP;

    // A cold-connection theory predicts the OPPOSITE shape — idle-gap calls
    // slower, from re-establishing a connection. Instead the idle-gap
    // bucket's own worst case sits below the back-to-back bucket's tail, and
    // contributes zero of the 16 calls over 15s
    expect(afterLongIdle.callsOver15s).toBe(0);
    expect(backToBack.callsOver15s).toBeGreaterThan(0);
    expect(afterLongIdle.maxLatencyMs).toBeLessThan(backToBack.maxLatencyMs);
  });

  it('the idle-gap buckets, a windowed LAG() query over the timeline, sum to the same row count the headline COUNT(*) query reports', () => {
    // Two structurally different queries against the same table (a flat
    // aggregate vs. a windowed self-join) landing on the same total is a
    // real cross-check, not a tautology: a boundary bug in the gap-bucket
    // CASE (an off-by-one on the 60s/300s cutoffs, or a bucket that silently
    // dropped the first row of a debate) would show up here as a mismatch,
    // even though both sides are frozen literals rather than a live query
    const { afterLongIdle, oneToFiveMin, backToBack } = CALLS_BY_IDLE_GAP;
    const bucketedTotal = afterLongIdle.n + oneToFiveMin.n + backToBack.n;

    expect(bucketedTotal).toBe(HEADLINE_SAMPLE_SIZE);
  });
});
