/**
 * Per-item sentiment scoring over SUPPLIED TEXT (#555, map #552).
 *
 * ## Why scoring is not optional
 *
 * #555 framed this as a choice and the analyst code closed it. The analysts are
 * deterministic — there is no LLM client anywhere in `server/pipeline/analysts/`
 * — and `fundamental-analyst.ts` reads exactly two scored fields:
 *
 * ```ts
 * const netSentiment = items.reduce((sum, i) => sum + i.sentiment, 0) / items.length;
 * const avg          = items.reduce((sum, i) => sum + i.confidence, 0) / items.length;
 * ```
 *
 * Both are required on `IntelligenceItem`. Ingesting unscored items with
 * `sentiment: 0` would leave `fundamental` **permanently neutral with a full
 * `.news` array** — and, worse, would remove the `NO_DATA_MARKER` that the
 * conviction score relies on to *exclude* a mute analyst from its evidence
 * average. The result would be #625's 0.5478 ceiling reinstated invisibly, on a
 * system that looked fixed.
 *
 * ## Why this is not the retrieval design that failed
 *
 * The model is asked to **classify text we already fetched**, never to recall
 * or retrieve anything. That is the whole decoupling: confabulation risk
 * collapses because every input token came from the archive, and
 * `retrievalEvidence` becomes archive-row provenance rather than a claim the
 * model makes about itself. ADR-0009 is untouched — this rides the existing
 * Nous client.
 *
 * ## Cost
 *
 * Metered as `stage: 'market_intelligence'` against the ADR-0008 cap. Headroom
 * is ample and larger than #555's ticket assumed: measured debate spend is
 * $0.878/day (#657), and post-#617 the debate leg projects to ~$0.31/day, ~9%
 * of the $50/14d cap. Items are scored in ONE batched call per refresh rather
 * than one call per item — the analyst needs a score per item, which is what
 * the response carries; it does not need a request per item.
 */

import {
  BARE_JSON_INSTRUCTION,
  classifyFailureCause,
  type LlmClient,
  LlmMalformedResponseError,
  type LlmRequest,
  unwrapFencedJson,
} from '../../../pipeline/debate-engine/index.js';
import { type Logger, logCaughtFailure } from '../../../shared/index.js';

/** What the model returns for one item. */
export interface ItemScore {
  /** Index into the batch as supplied — the join back to the item. */
  index: number;
  sentiment: 1 | 0 | -1;
  confidence: number;
  /**
   * True only for the synthesized fallback `scoreItems` builds when an
   * otherwise-valid response omitted this index (#1420). Absent — not
   * `false` — on every score the model actually produced, so a downstream
   * consumer can tell "the model read this and found nothing directional"
   * from "the model never answered for this one" by testing truthiness, the
   * same way `IntelligenceItem.scope` is absent rather than defaulted.
   */
  omitted?: boolean;
}

/** The text handed to the model. Deliberately minimal: headline plus entity. */
export interface ScorableItem {
  entity: string;
  headline: string;
  summary: string;
}

/**
 * Neutral at floor confidence — what an item scores when the model could not be
 * reached, answered unusably, or (for one item inside an otherwise-successful
 * batch) simply omitted an index from its response.
 *
 * Logged only on the BATCH path: when the whole call fails, `scoreItems` logs
 * the cause itself before returning this for every item (see
 * `ScoreItemsResult.degraded`). The PER-ITEM omission fallback (one index
 * missing from an otherwise-valid response, see the `byIndex.get` branch
 * below) logs nothing and leaves `degraded: false`, but the returned score
 * itself now carries `omitted: true` (#1420) — `MiIngestAgent.refresh` reads
 * that to withhold the item from `mi_items` rather than archive this value
 * as if it were a genuine neutral read.
 *
 * Either way the value is chosen so a scoring gap degrades toward "no
 * directional opinion" rather than toward a fabricated one: `sentiment: 0`
 * contributes nothing to `netSentiment`, so it cannot push an analyst into a
 * direction it has no evidence for.
 */
export const UNSCORED: Omit<ItemScore, 'index'> = { sentiment: 0, confidence: 0.05 };

const SYSTEM_INSTRUCTION =
  'You classify the market sentiment of financial news headlines that are SUPPLIED TO YOU. ' +
  'Do not use any knowledge beyond the supplied text. Do not recall or invent headlines. ' +
  'For each numbered item return its sentiment for the named entity: 1 = bullish, ' +
  '0 = neutral, -1 = bearish, and a confidence in [0,1] reflecting how clearly the ' +
  'supplied text supports that reading. A headline that is not about the entity, or ' +
  'carries no directional information, is 0 at low confidence. Respond as JSON: ' +
  '{"scores":[{"index":number,"sentiment":1|0|-1,"confidence":number}]}\n\n' +
  BARE_JSON_INSTRUCTION;

function isScore(value: unknown): value is ItemScore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ItemScore>;
  return (
    typeof candidate.index === 'number' &&
    (candidate.sentiment === 1 || candidate.sentiment === 0 || candidate.sentiment === -1) &&
    typeof candidate.confidence === 'number' &&
    Number.isFinite(candidate.confidence)
  );
}

/** Clamped to the same [0.05, 0.95] band the analysts use for their own reads. */
function clampConfidence(value: number): number {
  return Math.min(0.95, Math.max(0.05, value));
}

export interface ScoreItemsDeps {
  llmClient: LlmClient;
  trace_id?: string | undefined;
  /**
   * Required, not optional (#1392 review round 1): the defect this ticket
   * fixes was precisely that nobody logged a scoring failure, so a call site
   * that cannot supply a `Logger` must pass a no-op one explicitly rather
   * than silently opting back into the unlogged failure this function exists
   * to end. Every production caller already has one (`buildMiIngestAgent`,
   * production.ts).
   */
  logger: Logger;
}

/**
 * `scores` is one entry per supplied item, in input order, exactly as before.
 * `degraded` is the addition: true when the WHOLE batch fell back to
 * `UNSCORED` because the model could not be reached, answered unusably, or
 * because retries were exhausted — as opposed to a genuine unanimous-neutral
 * read the model actually produced. The caller (`MiIngestAgent`) uses this to
 * decide whether the batch is fit to archive at all; see its `refresh` doc.
 */
export interface ScoreItemsResult {
  scores: ItemScore[];
  degraded: boolean;
}

/**
 * Scores a batch, returning one score per supplied item **in input order**.
 *
 * Never throws, in either of two distinct failure shapes:
 *
 * - A batch that fails outright (transport error, exhausted retries, an
 *   unparseable or empty-after-validation response) comes back as `UNSCORED`
 *   for every item, `degraded: true`, and the cause is logged here before
 *   returning — distinguishable from a genuine unanimous-neutral news day
 *   (#1392), which is the whole point of this function.
 * - An item the model's response simply omitted an index for, inside an
 *   otherwise-valid batch, falls back to `UNSCORED` for that one item, tagged
 *   `omitted: true` (#1420), with the batch's `degraded` left at `false` (see
 *   `UNSCORED`'s own doc) — nothing is logged for it, but `MiIngestAgent
 *   .refresh` reads the marker to withhold that one item from `mi_items`
 *   rather than archive a fabricated neutral, so the article stays a scoring
 *   candidate for a later refresh instead of being permanently marked scored.
 *
 * Either way, a scoring gap must not take down the tick — the analysts
 * degrade to "no opinion", a state they already handle, rather than the
 * ingestion path throwing inside the refresh loop.
 */
export async function scoreItems(
  items: readonly ScorableItem[],
  deps: ScoreItemsDeps,
): Promise<ScoreItemsResult> {
  if (items.length === 0) return { scores: [], degraded: false };

  const fallback = items.map((_, index) => ({ index, ...UNSCORED }));

  const numbered = items
    .map((item, index) => `${index}. [${item.entity}] ${item.headline} ${item.summary}`.trim())
    .join('\n');

  const request: LlmRequest<{ scores: ItemScore[] }> = {
    prompt: `${SYSTEM_INSTRUCTION}\n\nItems:\n${numbered}`,
    context: {
      analyst_views: [],
      attribution: {
        ...(deps.trace_id === undefined ? {} : { trace_id: deps.trace_id }),
        stage: 'market_intelligence',
      },
    },
    parseResponse: (rawText: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(unwrapFencedJson(rawText));
      } catch {
        return { valid: false as const, reason: 'response was not valid JSON' };
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return { valid: false as const, reason: 'response JSON was not an object' };
      }
      const scores = (parsed as { scores?: unknown }).scores;
      if (!Array.isArray(scores)) {
        return { valid: false as const, reason: 'response had no scores array' };
      }
      const valid = scores.filter(isScore);
      // Items were sent (the `items.length === 0` case returned above), so a
      // response that survives validation with nothing left is a scoring
      // failure — the model answered with the wrong shape for every item —
      // not a legitimate "nothing to score" read.
      if (valid.length === 0) {
        return {
          valid: false as const,
          reason: 'no item in the scores array matched the expected shape',
        };
      }
      return { valid: true as const, data: { scores: valid } };
    },
  };

  let scores: ItemScore[];
  try {
    const response = await deps.llmClient.complete(request);
    scores = response.data.scores;
  } catch (error) {
    const trace_id = deps.trace_id ?? 'unattributed';
    const message =
      'market intelligence: item scoring failed; this batch degrades to UNSCORED ' +
      '(neutral, floor confidence) rather than a genuine neutral read';
    // Two literal branches, not a computed `event:`, so
    // `log-event-code.test.ts`'s spelling scan (a textual grep, not an
    // evaluator) sees both codes. WHICH failure it was is the payload's
    // `failure_cause`, not the code: the `else` code says "provider failure"
    // but reaches a refusal and a truncation too, and the field is what
    // separates them (#1394). It replaces `error_kind`, whose only two values
    // — `malformed_response` and `transport` — called every refusal a
    // transport fault.
    const failure_cause = classifyFailureCause(error);
    if (error instanceof LlmMalformedResponseError) {
      logCaughtFailure(
        deps.logger,
        {
          trace_id,
          stage: 'market_intelligence',
          level: 'warn',
          event: 'mi_scoring_malformed_response',
          message,
        },
        error,
        { items: items.length, failure_cause },
      );
    } else {
      logCaughtFailure(
        deps.logger,
        {
          trace_id,
          stage: 'market_intelligence',
          level: 'warn',
          event: 'mi_scoring_provider_failure',
          message,
        },
        error,
        { items: items.length, failure_cause },
      );
    }
    return { scores: fallback, degraded: true };
  }

  const byIndex = new Map(scores.map((score) => [score.index, score]));

  return {
    scores: items.map((_, index) => {
      const score = byIndex.get(index);
      if (score === undefined) return { index, ...UNSCORED, omitted: true };
      return {
        index,
        sentiment: score.sentiment,
        confidence: clampConfidence(score.confidence),
      };
    }),
    degraded: false,
  };
}
