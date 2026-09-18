import { type Logger, safeLog } from '../../shared/index.js';
import { hashPromptTemplate } from '../../shared/llm/index.js';
import { classifyFailureCause } from './llm/failure-cause.js';
import { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './llm/json-response.js';
import type { LlmClient } from './llm/types.js';
import type { AnalystView, Direction } from './types.js';

interface DisagreementConflict {
  analysts: string[];
  nature: string;
}

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
  BARE_JSON_INSTRUCTION,
  '',
  'If there are no conflicts, respond with an empty "conflicts" array and a',
  'summary noting agreement.',
].join('\n');
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

export async function detectDisagreements(
  views: AnalystView[],
  llmClient: LlmClient,
  signal?: AbortSignal,
  attribution?: { trace_id?: string | undefined; debate_id?: string | undefined },
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
