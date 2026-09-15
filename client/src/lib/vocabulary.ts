/**
 * Every word the page uses for a wire enum, in one place.
 *
 * Rendering `no_go` as "no_go" leaks the store's spelling onto the operator's
 * screen; rendering it as a colour alone hides it from anyone who cannot see
 * the colour. Colour is never the sole signal on this page (dashboard-spec.md,
 * "Accessibility floor"), so every state has a word, and the word lives here so
 * a tab, a drawer and an accessible name cannot disagree about it.
 */
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

/** What every surface says before the first successful poll. */
export const WAITING_FOR_FIRST_SNAPSHOT = 'waiting for the first snapshot';

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

/**
 * `PnlHeadlineWire.rate_source`'s word (#1596) — a `Record`, not a string
 * transform, so a future second source is a compile error here until named.
 */
export const PNL_RATE_SOURCE_WORD: Readonly<Record<PnlRateSource, string>> = {
  static_sizing_rate: 'static sizing rate',
};

/**
 * dashboard-spec.md's "Absence is named per arm" sentences (#1597) — one
 * place so Glance, Live and Review cannot drift on the exact wording for a
 * figure the control arm structurally cannot have. The first two are quoted
 * verbatim in the spec's Arm selector section; `CONTROL_NO_CRITIC` and
 * `CONTROL_NO_ANALYSTS` follow the same "Control arm: … — not applicable"
 * shape for the two absences the spec names without spelling out the words.
 */
export const CONTROL_NO_DEBATE = 'Control arm: no LLM debate — not applicable';
export const CONTROL_NO_EQUITY = 'Control arm: simulated broker — no equity figure';
export const CONTROL_NO_TICK = 'Control arm: tick status is not persisted';
export const CONTROL_NO_CRITIC = 'Control arm: no LLM critic — not applicable';
export const CONTROL_NO_ANALYSTS = 'Control arm: no debate, no analyst weights — not applicable';
