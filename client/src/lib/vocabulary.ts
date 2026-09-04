/**
 * Every word the page uses for a wire enum, in one place.
 *
 * Rendering `no_go` as "no_go" leaks the store's spelling onto the operator's
 * screen; rendering it as a colour alone hides it from anyone who cannot see
 * the colour. Colour is never the sole signal on this page (dashboard-spec.md,
 * "Accessibility floor"), so every state has a word, and the word lives here so
 * a tab, a drawer and an accessible name cannot disagree about it.
 */
import type {
  CloseReason,
  EvaluatedConditionWire,
  PipelineCellState,
  PipelineOutcome,
  PipelineStage,
  RiskCriticRow,
} from '@contracts';
import type { SettledOutcome } from './ledger.ts';

export const OUTCOME_WORD: Readonly<Record<PipelineOutcome, string>> = {
  go: 'go',
  no_go: 'no-go',
  stopped: 'stopped',
  quorum_skip: 'quorum skip',
  in_flight: 'in flight',
  idle: 'idle',
};

const CELL_STATE_WORD: Readonly<Record<PipelineCellState, string>> = {
  done: 'done',
  live: 'live',
  stopped: 'stopped',
  skipped: 'skipped',
  not_reached: 'not reached',
};

/**
 * The word a lane-matrix cell shows. `not_reached` reads as "wait" while the
 * lane is still running — the stage is ahead of the tick — and as "not
 * reached" once it has settled, where nothing will ever reach it. An idle lane
 * has no trace at all, so every cell says so.
 */
export function cellStateWord(state: PipelineCellState, laneOutcome: PipelineOutcome): string {
  if (laneOutcome === 'idle') return 'idle';
  if (state === 'not_reached' && laneOutcome === 'in_flight') return 'wait';
  return CELL_STATE_WORD[state];
}

/** The hanko glyphs. 可 go · 否 no-go · 止 stopped · 略 quorum skip. */
export const SEAL_GLYPH: Readonly<Record<SettledOutcome, string>> = {
  go: '可',
  no_go: '否',
  stopped: '止',
  quorum_skip: '略',
};

const STAGE_NAME: Readonly<Record<PipelineStage, string>> = {
  analysts: 'Analysts',
  debate: 'Debate',
  trader: 'Trader',
  risk: 'Risk',
  verdict: 'Verdict',
  execution: 'Execution',
};

export function stageName(stage: PipelineStage): string {
  return STAGE_NAME[stage];
}

export function sideWord(side: 'buy' | 'sell'): string {
  return side === 'buy' ? 'long' : 'short';
}

export const CLOSE_REASON_WORD: Readonly<Record<CloseReason, string>> = {
  stop: 'stop hit',
  target: 'target hit',
  exit: 'exit',
  flatten: 'flattened',
  signal_decay: 'signal decay',
  direction_flip: 'direction flip',
};

/** What every surface says before the first successful poll. */
export const WAITING_FOR_FIRST_SNAPSHOT = 'waiting for the first snapshot';

export const CONDITION_STATE_WORD: Readonly<Record<EvaluatedConditionWire['state'], string>> = {
  breached: 'breached',
  not_breached: 'holds',
  unevaluable: 'unevaluable',
};

const CRITIC_VERDICT_WORD: Readonly<Record<NonNullable<RiskCriticRow['critic_verdict']>, string>> =
  {
    pass: 'pass',
    trim: 'trim',
    reject: 'reject',
    unavailable: 'unavailable',
  };

export function criticVerdictWord(verdict: RiskCriticRow['critic_verdict']): string {
  return verdict === null ? 'no verdict' : CRITIC_VERDICT_WORD[verdict];
}

const PROVIDER_STATE_WORD: Readonly<Record<string, string>> = {
  ok: 'ok',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  rate_limited: 'rate limited',
  error: 'error',
  not_configured: 'not configured',
};

/** `null` for a state word this client does not know — never a guess. */
export function providerStateWord(state: string): string | null {
  return PROVIDER_STATE_WORD[state] ?? null;
}
