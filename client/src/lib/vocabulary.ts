/**
 * The page's words (issue #538). Every state that carries a colour also
 * carries a word, and this module is where those words are defined once —
 * "colour is never the sole carrier of a signal" (dashboard-spec.md, Design
 * system / Accessibility floor) is only enforceable if there is a single
 * table a reviewer can check rather than a string literal per component.
 *
 * Pure and React-free, like the rest of `lib/`. Every lookup is total over
 * its wire union, so a wire value that grows a member fails to compile here
 * rather than rendering blank somewhere on the screen.
 */

import type {
  CloseReason,
  PipelineCellState,
  PipelineLane,
  PipelineOutcome,
  PipelineStage,
} from '@contracts';
import type { SettledOutcome } from './ledger.ts';
import type { RoomId } from './room-layout.ts';

/** How a trace ended, in words — the text half of the chip's outcome ring. */
export const OUTCOME_WORD: Readonly<Record<PipelineOutcome, string>> = {
  go: 'go',
  no_go: 'no-go',
  stopped: 'stopped',
  quorum_skip: 'quorum skip',
  in_flight: 'in flight',
  idle: 'idle',
};

/** What happened at one stage, in words — the drawer's state column. */
export const CELL_STATE_WORD: Readonly<Record<PipelineCellState, string>> = {
  done: 'done',
  live: 'live',
  stopped: 'stopped',
  skipped: 'skipped',
  not_reached: 'not reached',
};

/**
 * The hanko seals (dashboard-spec.md, "Verdict ledger"): 可 go, 否 no_go,
 * 止 stopped, 略 quorum_skip. A seal is ornament with a job, so its meaning is
 * always rendered beside it as `OUTCOME_WORD` too — the glyph is never the
 * only carrier either.
 */
export const SEAL_GLYPH: Readonly<Record<SettledOutcome, string>> = {
  go: '可',
  no_go: '否',
  stopped: '止',
  quorum_skip: '略',
};

export interface RoomMeta {
  /** `01`–`06`, or `null` for the Lobby, which is not a pipeline stage. */
  number: string | null;
  name: string;
  /** Watermark kanji — decorative, `aria-hidden` at the render site. */
  kanji: string;
  /** One-line description of what the room does. */
  blurb: string;
}

/** Room numbers, names, kanji watermarks (待析議商危決行) and blurbs. */
export const ROOM_META: Readonly<Record<RoomId, RoomMeta>> = {
  lobby: { number: null, name: 'Lobby', kanji: '待', blurb: 'idle instruments' },
  analysts: { number: '01', name: 'Analysts', kanji: '析', blurb: 'quorum gate' },
  debate: { number: '02', name: 'Debate', kanji: '議', blurb: 'personas · rounds' },
  trader: { number: '03', name: 'Trader', kanji: '商', blurb: 'intent' },
  risk: { number: '04', name: 'Risk', kanji: '危', blurb: 'sizing · gates' },
  verdict: { number: '05', name: 'Verdict', kanji: '決', blurb: 'go / no-go' },
  execution: { number: '06', name: 'Execution', kanji: '行', blurb: 'fills' },
};

/** Stage names for the drawer's stage strip, which lists all six. */
export function stageName(stage: PipelineStage): string {
  return ROOM_META[stage].name;
}

export interface AssetGlyph {
  /** A short mark distinguishing crypto from stocks. Decoration. */
  glyph: string;
  /** The same distinction in words — what a screen reader announces. */
  word: string;
}

/**
 * The asset-class mark on a sigil chip. The glyph is decoration; `word` is the
 * part that carries the meaning, and both are rendered (the word visually
 * hidden on the chip, spoken in its accessible name).
 */
export function assetGlyph(assetClass: PipelineLane['asset_class']): AssetGlyph {
  return assetClass === 'crypto' ? { glyph: '₿', word: 'crypto' } : { glyph: '$', word: 'stocks' };
}

/** `buy`/`sell` as the position words an operator reads on the panel. */
export function sideWord(side: 'buy' | 'sell'): string {
  return side === 'buy' ? 'long' : 'short';
}

/**
 * Why a closed trade closed, in words (#940). Total over the wire's
 * `CloseReason` union (`contracts/snapshot.ts`) — a member added there and not
 * here fails to compile, matching every other table in this file.
 */
export const CLOSE_REASON_WORD: Readonly<Record<CloseReason, string>> = {
  stop: 'stop hit',
  target: 'target hit',
  exit: 'exit',
  flatten: 'flat-by-close',
  signal_decay: 'signal decay',
  direction_flip: 'direction flip',
};

/**
 * The six `ProviderState` values, as words. Typed as a plain record rather
 * than against the wire union so an unknown string from the wire can be
 * detected (`providerStateWord` returns `null`) instead of rendering
 * `undefined` — a provider tile that invents a status is worse than one that
 * says it does not recognise the one it was given.
 */
const PROVIDER_STATE_WORD: Readonly<Record<string, string>> = {
  ok: 'reachable',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  rate_limited: 'rate limited',
  error: 'error',
  not_configured: 'not configured',
};

/** The provider state as a word, or `null` when the wire sent something unknown. */
export function providerStateWord(state: string): string | null {
  return PROVIDER_STATE_WORD[state] ?? null;
}
