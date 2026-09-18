import type { PipelineOutcome, PipelineStage, PnlRateSource } from '@contracts';
import type { SettledOutcome } from './ledger.ts';

export const OUTCOME_WORD: Readonly<Record<PipelineOutcome, string>> = {
  go: 'go',
  no_go: 'no-go',
  stopped: 'stopped',
  quorum_skip: 'quorum skip',
  in_flight: 'in flight',
  idle: 'idle',
};

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

export const WAITING_FOR_FIRST_SNAPSHOT = 'waiting for the first snapshot';

const PROVIDER_STATE_WORD: Readonly<Record<string, string>> = {
  ok: 'ok',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  rate_limited: 'rate limited',
  error: 'error',
  not_configured: 'not configured',
};

export function providerStateWord(state: string): string | null {
  return PROVIDER_STATE_WORD[state] ?? null;
}

export const PNL_RATE_SOURCE_WORD: Readonly<Record<PnlRateSource, string>> = {
  static_sizing_rate: 'static sizing rate',
};

export const CONTROL_NO_DEBATE = 'Control arm: no LLM debate — not applicable';
export const CONTROL_NO_EQUITY = 'Control arm: simulated broker — no equity figure';
export const CONTROL_NO_TICK = 'Control arm: tick status is not persisted';
export const CONTROL_NO_CRITIC = 'Control arm: no LLM critic — not applicable';
export const CONTROL_NO_ANALYSTS = 'Control arm: no debate, no analyst weights — not applicable';

export const PNL_OVERALL_CAVEAT =
  'All-time: net adds open unrealized to every closed trade; drawdown and trade count are closed trades only. The Review arm-comparison panel reports realized only, over a filtered window sampled on its own cadence, and can report a different figure for the same arm.';
