/**
 * Semantic disagreement detection (#32) — see docs/specs/debate-engine-spec.md
 * "Module: Disagreement Detection" and story 11 ("detect semantic conflicts
 * in analyst rationale... not just directional divergence"). Runs once per
 * debate, not per round (spec's "Cost Justification").
 *
 * Feeds `DebateResult.disagreement_summary`/`open_items`, wired in by
 * `debate-adapter.ts`; a pure function over `AnalystView[]`, same posture as
 * `analyst-contribution.ts`.
 */
import { type Logger, safeLog } from '../../shared/index.js';
import { hashPromptTemplate } from '../../shared/llm/prompt-template-hash.js';
import { classifyFailureCause } from './llm/failure-cause.js';
import { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './llm/json-response.js';
import type { LlmClient } from './llm/types.js';
import type { AnalystView, Direction } from './types.js';

/** One detected conflict: which analysts disagree and why, in free text */
export interface DisagreementConflict {
  analysts: string[];
  nature: string;
}

/**
 * `method` records which path produced the result — semantic (LLM succeeded)
 * or directional_fallback (LLM unavailable/malformed, or too few views to
 * bother calling it) — so callers/logs can distinguish a "no disagreement"
 * finding from "we couldn't check properly"
 */
export interface DisagreementAnalysis {
  summary: string;
  conflicts: DisagreementConflict[];
  method: 'semantic' | 'directional_fallback';
}

interface RawDisagreementResponse {
  summary: string;
  conflicts: Array<{ analysts: string[]; nature: string }>;
}

const PROMPT = [
  'You are analyzing market analyst views for disagreements. Given the',
  'analyst views below (each with a direction, confidence, and free-text',
  'key_points rationale), identify semantic conflicts in their reasoning —',
  'including cases where two analysts share the same direction but for',
  'contradictory reasons. Do not just compare directions.',
  '',
  'Respond with JSON only, matching this shape:',
  '{"summary": string, "conflicts": [{"analysts": string[], "nature": string}]}',
  // #361: the pinned model fenced this payload on every call, so the parse
  // below always threw and this detector silently degraded to
  // `directional_fallback` — reporting "we only compared directions" when a
  // real semantic assessment had in fact been produced
  BARE_JSON_INSTRUCTION,
  '',
  'If there are no conflicts, respond with an empty "conflicts" array and a',
  'summary noting agreement.',
].join('\n');
/** sha256 of `PROMPT` above (#1514) — this detector's whole prompt is static, so it hashes the constant directly rather than splitting a template out */
const PROMPT_TEMPLATE_HASH = hashPromptTemplate(PROMPT);

function isConflict(value: unknown): value is { analysts: string[]; nature: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.analysts) &&
    candidate.analysts.every((a) => typeof a === 'string') &&
    typeof candidate.nature === 'string'
  );
}

function parseDisagreementResponse(
  rawText: string,
): { valid: true; data: RawDisagreementResponse } | { valid: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFencedJson(rawText));
  } catch {
    return { valid: false, reason: 'response is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, reason: 'response is not a JSON object' };
  }
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.summary !== 'string') {
    return { valid: false, reason: 'missing or invalid "summary"' };
  }
  if (!Array.isArray(candidate.conflicts) || !candidate.conflicts.every(isConflict)) {
    return { valid: false, reason: 'missing or invalid "conflicts"' };
  }

  return {
    valid: true,
    data: { summary: candidate.summary, conflicts: candidate.conflicts },
  };
}

/**
 * Mechanical fallback: groups views by `direction` and flags a conflict per
 * group of directions once more than one distinct direction is present.
 * This is exactly the "simple directional comparison" the spec says
 * semantic detection must improve on — used only when the LLM path is
 * unavailable, or skipped entirely for <2 views (nothing to disagree about).
 */
function directionalFallback(views: AnalystView[]): DisagreementAnalysis {
  const byDirection = new Map<Direction, string[]>();
  for (const view of views) {
    const group = byDirection.get(view.direction) ?? [];
    group.push(view.analyst_id);
    byDirection.set(view.direction, group);
  }

  if (byDirection.size <= 1) {
    return {
      summary: 'No directional disagreement among analysts.',
      conflicts: [],
      method: 'directional_fallback',
    };
  }

  const directions = [...byDirection.keys()].sort();
  const conflicts: DisagreementConflict[] = directions.map((direction) => ({
    analysts: byDirection.get(direction) as string[],
    nature: `Directional disagreement: analysts hold a "${direction}" view.`,
  }));

  return {
    summary: `Analysts diverge directionally: ${directions.join(' vs ')}.`,
    conflicts,
    method: 'directional_fallback',
  };
}

/**
 * Detects semantic disagreements across `views` via `llmClient`. Never
 * throws — any LLM failure (timeout, rate limit, malformed response; the
 * injected client is responsible for its own retries, per `LlmClient`'s
 * contract) falls back to `directionalFallback` per the spec's "Handle LLM
 * errors gracefully" requirement.
 */
export async function detectDisagreements(
  views: AnalystView[],
  llmClient: LlmClient,
  /**
   * Cancels the semantic-detection call (#347). This is a billed LLM call
   * inside the debate, so the latency budget has to be able to reach it too.
   *
   * Note the interaction with this function's never-throws contract: a
   * cancelled call lands in the same `catch` as any other failure and returns
   * the directional fallback. That is correct — the caller is being torn down
   * and will discard the value — and it is why the round loop
   * (round-orchestrator.ts) checks the signal ITSELF rather than relying on
   * this function to propagate the cancellation.
   */
  signal?: AbortSignal,
  /**
   * Spend attribution (#326). This is the one call per debate that
   * debate-engine-spec.md deliberately bounds ("runs once per debate, not per
   * round, so the LLM cost is bounded") — leaving it unattributed would leave
   * a fixed, per-debate slice of the bill out of every per-decision cost
   * figure, understating exactly the number this ticket exists to produce.
   *
   * Optional and last, like `signal` before it: this function has callers in
   * the suite that pass two arguments and care about neither.
   */
  attribution?: { trace_id?: string | undefined; debate_id?: string | undefined },
  /**
   * Where the swallowed failure below is named (#1394). This function had no
   * logger at all: a refusal, a timeout and an unparseable answer all left one
   * trace — `method: 'directional_fallback'` on the result — which says the
   * check was downgraded but never why, and cannot be counted.
   *
   * Optional and last, like `signal` and `attribution` before it, for the same
   * reason: the suite's callers pass neither and lose nothing.
   */
  logger?: Logger,
): Promise<DisagreementAnalysis> {
  if (views.length < 2) {
    return directionalFallback(views);
  }

  try {
    const response = await llmClient.complete({
      prompt: PROMPT,
      context: {
        analyst_views: views,
        attribution: {
          trace_id: attribution?.trace_id,
          stage: 'debate',
          debate_id: attribution?.debate_id,
          prompt_template_hash: PROMPT_TEMPLATE_HASH,
        },
      },
      parseResponse: parseDisagreementResponse,
      signal,
    });

    return {
      summary: response.data.summary,
      conflicts: response.data.conflicts,
      method: 'semantic',
    };
  } catch (error) {
    // Logged, never rethrown — the never-throws contract above is unchanged
    // and the fallback is still returned. `warn`, not `debug`: this is a
    // billed call the debate paid for and did not get, and the result it
    // degrades to is the "simple directional comparison" semantic detection
    // exists to improve on
    if (logger !== undefined) {
      safeLog(logger, {
        trace_id: attribution?.trace_id ?? 'unattributed',
        stage: 'debate',
        event: 'debate_disagreement_llm_failed',
        level: 'warn',
        message:
          'semantic disagreement detection failed; this debate falls back to a directional ' +
          'comparison and reports method: directional_fallback',
        payload: {
          debate_id: attribution?.debate_id,
          failure_cause: classifyFailureCause(error),
          views: views.length,
        },
      });
    }
    return directionalFallback(views);
  }
}
