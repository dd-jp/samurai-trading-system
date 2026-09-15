/**
 * The 3-second `/api/snapshot` poll (issue #538; dashboard-spec.md
 * "hooks/useSnapshot.ts"). Owns two things and nothing else: the interval and
 * the staleness watchdog.
 *
 * Three properties this hook exists to guarantee, each of which is a way an
 * operator surface lies if it is missing:
 *
 *  1. **Staleness is measured against the clock, not against a failure
 *     counter.** A hung fetch never rejects, so a counter stays at zero while
 *     the data rots. The watchdog asks "how long since a successful poll",
 *     which is true of a hang, a rejection, and a 500 alike.
 *  2. **A stale poll keeps the last numbers.** They are marked stale by the
 *     rail, never blanked — a blank field reads as zero (spec, "Layout — the
 *     Rail").
 *  3. **Every poll is bounded in time.** A hung request (the server accepts
 *     the connection and never answers) is abandoned at the staleness horizon
 *     and its slot released, so the next tick retries. Without that, one hang
 *     wedges the in-flight guard forever: the watchdog still marks the page
 *     stale, but no retry is ever issued and only a manual reload recovers —
 *     the worst failure mode for an always-on surface, because the page looks
 *     like it is trying (#606 item 3).
 */

import {
  CONTRACT_VERSION,
  type DashboardSnapshot,
  type LlmSpendSummary,
  type MetricsSuiteWire,
  type ProfitFactorWire,
  type TradingArmWire,
  toProfitFactorWire,
} from '@contracts';
import { useEffect, useMemo, useRef, useState } from 'react';

/** The modes the server may send (`DashboardSnapshot['mode']`, #539). */
type ServerMode = DashboardSnapshot['mode'];

/**
 * The same list at runtime, for the boundary check below. `satisfies` rather
 * than a bare array so a value that is not a real server mode cannot be added
 * here by hand.
 */
export const RECOGNISED_MODES = [
  'paper',
  'live',
  'backtest',
] as const satisfies readonly ServerMode[];

/**
 * The client's view of the wire payload: the server's `DashboardSnapshot`
 * with `mode` widened to `| null` — and NARROWED at the fetch boundary by
 * `toWireSnapshot`, so every consumer downstream can trust it.
 *
 * Not a plain alias of `DashboardSnapshot` (PR #597 review). That version
 * asserted `mode` was always one of three literals while its own docblock
 * admitted an older server or a rewriting proxy may omit it — leaving
 * the rail's mode-pill literal check as the only thing standing between a
 * missing field and a mis-render, and the next consumer to read
 * `snapshot.mode` would have trusted the type and been wrong. A type that
 * lies is worse than one that is wide: `null` is the honest name for "the
 * server did not tell us", it is unrepresentable as a mode word, and the
 * compiler now forces every reader to handle it.
 */
export type WireSnapshot = Omit<DashboardSnapshot, 'mode' | 'llm_spend'> & {
  mode: ServerMode | null;
  /**
   * Widened to `| null` for the same reason `mode` is, and settled the same
   * way (#606 item 2). The rail's LLM cap bar takes `WireLlmSpendSummary |
   * null` and renders "meter not drawable" naming the reason — so the
   * consumer of this field already degrades honestly, and the boundary
   * rejecting the payload was the only thing standing between a missing
   * spend read and that rendering.
   *
   * The server cannot send `null` today: `DashboardSnapshot.llm_spend` is
   * non-nullable and a failed `getLlmSpend` throws out of `buildSnapshot`,
   * which the server answers as a 500 (`server.ts`) — a case the `!response.ok`
   * path below already survives. This is therefore a boundary POLICY fix, not
   * a live bug: an older server or a rewriting proxy is outside that guarantee,
   * and discarding positions, verdicts and the pipeline over one absent
   * summary would blank a live-money screen exactly as the `mode` docblock
   * below forbids.
   */
  llm_spend: WireLlmSpendSummary | null;
};

/**
 * `LlmSpendSummary` with its two cap fields widened to admit `undefined`,
 * meaning "this client could not read the wire value" — a third state
 * distinct from `null`'s "the field is present and says so"
 * (`contracts/snapshot.ts`'s `cap_usd` / `cap_armed_at` doc comments).
 * `normalizeCapUsd` / `normalizeCapArmedAt` below are what produce
 * `undefined`; `Rail.tsx`'s `capReasonOf` is what reads it back out as
 * `'unreadable'` / `'ambiguous'`.
 *
 * Without this widening, the cast at the end of `toWireSnapshot` was the
 * only thing keeping these fields' real, three-valued range out of the
 * compiler's sight (review round 3, MINOR): `contracts/snapshot.ts` declares
 * both as non-optional `string | null` / `number | null`, so a reader typed
 * against that declaration would see the `undefined` branch as unreachable
 * dead code, not as a case the compiler requires it to handle — exactly the
 * "type that lies" failure mode `mode`'s docblock above describes, reached
 * one field deeper.
 */
export type WireLlmSpendSummary = Omit<LlmSpendSummary, 'cap_usd' | 'cap_armed_at'> & {
  cap_usd: number | null | undefined;
  cap_armed_at: string | null | undefined;
};

export const SNAPSHOT_URL = '/api/snapshot';
export const POLL_INTERVAL_MS = 3_000;
/** Two consecutive missed polls put the page into its stale state (spec). */
export const STALE_AFTER_MISSED_POLLS = 2;
/**
 * How long a single poll may hang before it is abandoned (#606 item 3).
 *
 * Tied to the staleness horizon rather than picked independently: a request is
 * given exactly as long as the page is willing to keep calling its numbers
 * current, so the slot is released at the same instant the watchdog admits the
 * page is stale, and the NEXT interval tick retries. Anything longer leaves a
 * window where the rail says stale while a zombie request still holds the
 * poll slot; anything shorter would abandon a merely slow response the page
 * could still have used.
 */
function pollTimeoutMs(intervalMs: number): number {
  return intervalMs * STALE_AFTER_MISSED_POLLS;
}

/**
 * The rail's single health discriminator (#1316's decision comment: "one
 * small state discriminator on the client, not three ad-hoc flags"). Every
 * consumer that needs to know how much of the feed to trust reads THIS field,
 * not `stale/snapshot/error` combined by hand. `SnapshotFeed` carried a
 * separate `stale` boolean alongside it until #1520; its whole stated
 * justification was the rail's border colour needing the raw watchdog inside
 * the `'waiting'` window, and the page-level cold-start gate ended that —
 * `'waiting'` no longer reaches the rail at all, so within the rail `stale`
 * was exactly `status === 'stale'`, a second derivation of the discriminator
 * with nothing left to add and drift to lose.
 *
 * Ranked, highest priority first, because more than one can be true of the
 * underlying facts at once and only one word can be shown:
 *
 * 1. `'contract-mismatch'` — the served client bundle and the answering
 *    server disagree about the wire shape (#1316). Outranks everything below:
 *    a mismatched poll's `stale`/`waiting` reading would be a WRONG
 *    diagnosis, not just a less specific one — "the feed went quiet" when the
 *    real fact is "the feed is answering, but this client cannot trust what
 *    it says", which is worse than the silence it would otherwise report.
 * 2. `'waiting'` — no snapshot has ever been read successfully.
 * 3. `'stale'` — a snapshot exists, but two poll intervals have passed since
 *    the last one that validated.
 * 4. `'alive'` — the feed is healthy.
 *
 * #1520 collapsed its cold-start/stale-feed states INTO this union rather
 * than adding a second one beside it: the page-level cold-start gate
 * (`feedView` below) is a narrowing of these same four members by whether a
 * snapshot has ever landed, not a parallel flag, and `Rail.tsx`'s `HEALTH`
 * record still answers every member exactly once.
 */
export type FeedStatus = 'contract-mismatch' | 'waiting' | 'stale' | 'alive';

/**
 * The two members reachable while no snapshot has EVER validated. `'waiting'`
 * is the ordinary cold start; `'contract-mismatch'` is a first poll that
 * answered with a wire shape this client cannot trust — it outranks
 * `'waiting'` for the same reason it outranks `'stale'` (see above), so the
 * cold-start page must be able to say MISMATCH rather than reporting silence
 * the feed is not actually keeping.
 */
export type ColdStatus = Exclude<FeedStatus, 'stale' | 'alive'>;

export interface SnapshotFeed {
  /**
   * The most recent successfully-fetched payload, or `null` before the
   * first — including while `status === 'contract-mismatch'`: a mismatched
   * poll does not overwrite this with a payload this client cannot trust the
   * shape of, so it holds whatever the last VALIDATED poll produced (or
   * `null`, if there has never been one). `status`, not this field's
   * nullness, is what a caller must check before reading health off it — see
   * `Rail.tsx`'s block components, which read `status`, not `snapshot`
   * directly, for exactly this reason.
   */
  snapshot: WireSnapshot | null;
  /**
   * Client wall-clock time of the last successful poll — distinct from
   * `snapshot.generated_at`, which the server stamps. The rail's poll clock
   * reads this one; its snapshot clock reads `generated_at`/`as_of` (#1166).
   */
  lastSuccessAt: string | null;
  /** Why the last poll failed, for the rail to name. `null` when the last poll worked. */
  error: string | null;
  /** The rail's health discriminator — see `FeedStatus`'s doc comment. */
  status: FeedStatus;
}

/**
 * A feed that has produced at least one validated snapshot, and so always
 * will: `snapshot` is only ever replaced by a later validated payload, never
 * cleared (see its field comment above, and the `catch`/mismatch branches in
 * `poll()` that deliberately leave it alone). That is what makes the
 * non-nullness a guarantee for the whole life of the session rather than a
 * momentary reading — #1144's decision turns on exactly that distinction:
 * gate on "has a snapshot ever arrived", not on "is one present right now".
 */
export type LiveFeed = Omit<SnapshotFeed, 'snapshot'> & { snapshot: WireSnapshot };

/** A feed before its first validated snapshot — see `ColdStatus`. */
export type ColdFeed = Omit<SnapshotFeed, 'snapshot' | 'status'> & {
  snapshot: null;
  status: ColdStatus;
};

/**
 * The page-level gate (#1520), and the ONLY place in the client that asks
 * whether a snapshot exists. Everything downstream of a `'live'` view — the
 * rail and all three tabs — receives `WireSnapshot`, not `WireSnapshot |
 * null`, so no leaf re-derives an answer to a question the root has already
 * settled.
 *
 * Deliberately NOT keyed on `status === 'waiting'`: a first poll that comes
 * back version-skewed has no snapshot either, and `deriveStatus` ranks that
 * as `'contract-mismatch'` (rightly — the diagnosis outranks the silence).
 * Keying the gate on the status word would send that case down the live
 * branch with nothing to render. Keying it on nullness keeps ONE question at
 * the root and leaves the status word free to say which cold state it is.
 */
export type FeedView = { kind: 'cold'; feed: ColdFeed } | { kind: 'live'; feed: LiveFeed };

/**
 * What each `FeedStatus` reads as when no snapshot has arrived. `null` marks
 * the two that `deriveStatus` cannot produce against a null snapshot — both
 * require one — and those fall back to `'waiting'`, the honest reading of a
 * null snapshot anyway.
 *
 * A record rather than a ternary so the cold branch carries the same
 * obligation `HEALTH` does (`components/Rail.tsx`): a new `FeedStatus` member
 * fails to compile here until someone says whether it is reachable cold and
 * what it reads as if it is. `ColdStatus` is an `Exclude<>`, so a new member
 * joins it silently — this is what stops it being reported as WAITING by
 * default.
 */
const COLD_STATUS: { readonly [S in FeedStatus]: ColdStatus | null } = {
  'contract-mismatch': 'contract-mismatch',
  waiting: 'waiting',
  stale: null,
  alive: null,
};

export function feedView(feed: SnapshotFeed): FeedView {
  const { snapshot, status } = feed;
  if (snapshot !== null) return { kind: 'live', feed: { ...feed, snapshot } };
  const coldStatus: ColdStatus = COLD_STATUS[status] ?? 'waiting';
  return { kind: 'cold', feed: { ...feed, snapshot, status: coldStatus } };
}

export interface UseSnapshotOptions {
  url?: string;
  intervalMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Sent as `Authorization: Bearer <authToken>` on every poll when non-empty
   * (#1038). `undefined`, `null` or `''` all mean "send no `Authorization`
   * header at all" — not an empty-string header — which is what keeps the
   * default, no-credential-configured dashboard's request shape byte-for-byte
   * identical to before this option existed.
   */
  authToken?: string | null;
  /**
   * Which arm's `positions`/`closed_trades` to poll for (#1593). `undefined`
   * and `'live'` are the same request — see `snapshotUrl` — so a caller that
   * never heard of arms still sends the pre-#1592 request byte-for-byte.
   */
  arm?: TradingArmWire;
}

/**
 * The URL a poll actually fetches. `?arm=control` is appended ONLY for the
 * control arm — every other case (`undefined`, `'live'`) leaves `url`
 * untouched, so the default dashboard's request stays byte-for-byte the same
 * shape it was before this option existed (the same posture `authToken`'s
 * header takes above). The server's own default is `'live'` too
 * (`server.ts`'s `parseArmParam`), so an explicit `?arm=live` would be
 * redundant, not merely equivalent.
 */
export function snapshotUrl(url: string, arm?: TradingArmWire): string {
  return arm === 'control' ? `${url}?arm=control` : url;
}

/**
 * Reads `contract_version` off a body that at least parsed as an object,
 * without trusting anything else about its shape yet (#1316) — this runs
 * BEFORE `hasWireShape` in `poll()` below, deliberately, so a renamed or
 * dropped field that also fails the structural check is still diagnosed as a
 * contract mismatch rather than falling through to the generic "did not
 * match the wire shape" error, which reads like a proxy/captive-portal fault
 * rather than what it actually is.
 *
 * Returns `undefined` for both "the body is not even an object" and "the
 * field is absent or not a string" — this function does not need to
 * distinguish those two, because either one already fails to equal
 * `CONTRACT_VERSION` the same way. A pre-#1316 server (this field did not
 * exist yet) and a hostile/malformed payload therefore both read as
 * "unversioned", which is the correct, conservative default: an unversioned
 * server IS the old-server/new-client skew direction this field exists to
 * name.
 */
function readServerContractVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const version = (value as Record<string, unknown>).contract_version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Structural check on the parsed body. A dashboard served through a captive
 * portal or a misconfigured proxy answers `200` with HTML, and `JSON.parse`
 * failing is only one of the ways that goes wrong — a payload that parses but
 * carries no `pipeline.lanes` would render an empty lane matrix as though the
 * system had gone quiet. Failing the check keeps the last good numbers on
 * screen and lets the watchdog mark them stale, which is the honest outcome.
 */
function hasWireShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.generated_at !== 'string') return false;
  for (const key of ['positions', 'debates', 'verdicts', 'analysts']) {
    if (!Array.isArray(candidate[key])) return false;
  }
  // `llm_spend` is deliberately NOT required here — see `WireSnapshot`. It is
  // narrowed to `null` by `toWireSnapshot` instead, so an absent summary costs
  // one panel its numbers rather than costing the operator the whole page.
  for (const key of ['metrics', 'providers']) {
    const field = candidate[key];
    if (typeof field !== 'object' || field === null) return false;
  }
  const pipeline = candidate.pipeline;
  if (typeof pipeline !== 'object' || pipeline === null) return false;
  return Array.isArray((pipeline as Record<string, unknown>).lanes);
}

/** A non-null object that is not an array — `typeof [] === 'object'`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this shape one the rail's LLM cap block can actually render?
 *
 * The depth is chosen from what the consumers DEREFERENCE, not from the type
 * (PR #607 review). Every scalar they read goes through `formatUsd` /
 * `formatCount` / `formatStageDuration`, which return the module's em dash for
 * anything non-finite — so a window missing `cost_usd` degrades honestly on its
 * own. What throws is a missing OBJECT: `spend.all_time.per_debate.debates`
 * blows up on an absent `all_time` or `per_debate`, and `main.tsx` mounts
 * `<App/>` with no error boundary, so that is a white screen on a live-money
 * surface — strictly worse than the rejected-payload behaviour this branch was
 * added to replace.
 *
 * `Array.isArray` is checked at every level for the same reason: `[]` satisfies
 * `typeof x === 'object'`, so an array cast to `LlmSpendSummary` would render a
 * block of em dashes that looks like a real, empty spend summary rather than a
 * failed read. A wrong shape admitted is worse than a null rejected.
 *
 * `cap_usd` and `cap_armed_at` are DELIBERATELY NOT checked here (review round
 * 2, MINOR 3) — the three windows above are structural (a missing `all_time`
 * or `per_debate` throws on dereference), but the cap fields are two scalars
 * neither consumer dereferences into. Rejecting the whole summary over one bad
 * scalar would be exactly the `mode` mistake this function's sibling below
 * exists to avoid: three valid spend windows thrown away over one malformed
 * cap field would blank the 24h/7d/all-time footnote over a fault in an
 * unrelated field. `normalizeCapUsd` / `normalizeCapArmedAt` degrade those two
 * scalars per-field instead, the same way `mode` degrades below.
 */
function isSpendSummary(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of ['last_24h', 'last_7d', 'all_time']) {
    const window = value[key];
    if (!isPlainObject(window)) return false;
    if (!isPlainObject(window.per_debate)) return false;
  }
  return true;
}

/**
 * `null` and "anything else that is not a finite number" are DIFFERENT
 * claims and must not collapse into each other (review round 3's MAJOR —
 * the previous version mapped both to `null`, which this state machine
 * reads as "the field said so", so a malformed `cap_usd` alongside an
 * intact `cap_armed_at` rendered `'uncapped'`: an affirmative claim that the
 * operator chose to remove the ceiling, manufactured from a value this
 * client just rejected as unreadable).
 *
 * That pair — a corrupt `cap_usd` with a real `cap_armed_at` — is reachable
 * with no version skew and no client bug required:
 * `SqliteLlmSpendCapStore.read()` (`server/shared/store/sqlite-llm-spend-
 * cap-store.ts`) nullifies a non-finite stored `budget_usd` while KEEPING
 * `armed_at`, so a corrupted `REAL` column alone produces exactly this wire
 * shape (`contracts/snapshot.ts`'s `cap_armed_at` doc comment names the same
 * case). The fix once this was understood as a state-machine gap rather than
 * a scalar-typing gap: `null` here means ONLY "the wire said `null`" — the
 * legitimate discriminator input `cap_armed_at` gets to split into
 * never-armed/uncapped — and every other non-finite shape, absent included,
 * degrades to `undefined`, which `Rail.tsx`'s `capReasonOf` reports as its
 * own `'unreadable'` reason, asserting nothing about intent either way.
 */
function normalizeCapUsd(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `undefined` (the field absent — a pre-#1196 server) and `null` (the field
 * present, explicitly saying "no row was ever written") are DIFFERENT claims
 * and must not collapse into each other (review round 2's MAJOR — that
 * collapse, done with `??` in `Rail.tsx`, was this ticket's own defect one
 * level up). A malformed present value — wrong type, empty, or not even
 * `Date.parse`-able — is treated the SAME as absent: this client was told
 * nothing trustworthy about arming, not that arming is `null`, so guessing
 * "never armed" from noise would be as false as guessing "armed".
 *
 * Checked against the store's own shape AND parsed (review round 3, NIT 1 —
 * revised after the shape-only version was itself found loose). A bare
 * `Date.parse` gate admitted strings the store never writes (`"2026"`,
 * `"March 1 2026"`), and `formatClockUtc` (`client/src/lib/format.ts`) then
 * rendered them with a fabricated-looking `00:00:00Z` second precision — a
 * footnote that looked like a real arming instant for input this client
 * could not actually have received from `toStoredTimestamp`. Swapping to a
 * shape-only regex traded that looseness for the opposite one: the regex
 * alone admits `"2026-13-45T99:99:99.999Z"`, which matches the digit grammar
 * but is not a real instant, and `Date.parse` was the only check that caught
 * it — dropping it would let a nonsense string through as a trustworthy
 * arming record on a live-money surface. Both checks run: the shape rules
 * out formats the store never writes (loose ISO variants `Date.parse` alone
 * accepts), and `Date.parse` rejects the shape-valid strings whose
 * components overflow badly enough to leave no instant at all (`NaN`) — NOT
 * every shape-valid string a real calendar instant. `"2026-02-30T00:00:00.000Z"`
 * names a date no calendar has, and `"2026-09-06T24:00:00.000Z"` uses ISO
 * 8601's legitimate end-of-day `24:00:00` form for an instant a calendar
 * does have — but `Date.parse` treats both the same way: it rolls each
 * forward to a different, still shape-valid instant instead of returning
 * `NaN`, so either would pass both checks and later footnote a rolled
 * instant (`03-02`, `09-07`) as though it were the real arming time; only
 * the footnote's time-of-day component is visibly wrong here, since the
 * dashboard's cap-armed footnote renders `HH:MM:SSZ` only, no date, and
 * `00:00:00Z` is what both rolled instants happen to render. Not reachable
 * through this store, though: a `Date` cannot itself represent Feb 30 or
 * hour 24 (the rollover happens on construction, before any string exists),
 * and `toStoredTimestamp` calls `Date#toISOString()` on an already-valid
 * `Date`, unguarded, which also always emits millisecond precision — so
 * every value this store's `arm()` ever writes satisfies both checks with
 * no rollover artifact and no false negative against a real write. A
 * rollover string can only reach this function via a row written to
 * the column outside `arm()`. The regex is a literal duplicate of
 * `STORED_TIMESTAMP` (`server/shared/store/sqlite-utils.ts`), not an import
 * — `client/` and `server/` do not import each other (CLAUDE.md) — kept in
 * sync by inspection, the same way the two processes' timestamp grammar
 * always has been.
 */
const STORED_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function normalizeCapArmedAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' &&
    STORED_TIMESTAMP_SHAPE.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/**
 * `MetricsSuiteWire['profit_factor']`'s boundary normalizer (review round 1,
 * MAJOR). `hasWireShape` only checks that `metrics` is a non-null object —
 * it does not look inside at `profit_factor` — so a pre-#1270 server's
 * payload (a bare `number`, or the `null` `JSON.stringify` collapsed
 * `Infinity`/`NaN` into) passed through unchanged and reached
 * `ReviewTab.tsx`'s `switch (pf.kind)` as something with no `.kind` at all.
 * That threw — `TypeError` on `null`, the exhaustive switch's own guard on a
 * bare number — and `main.tsx` mounts with no error boundary, so it was a
 * white screen on every reload, not a degraded tile. Same class of bug
 * `normalizeCapUsd` / `normalizeCapArmedAt` above exist to close, one field
 * over.
 *
 * A `null` here is NOT read as `no_losses`: `JSON.stringify` collapses
 * `Infinity`, `NaN`, and `-Infinity` alike, so a `null` from an old server
 * could have been any of the three, and guessing the affirmative one from
 * ambiguous input would be exactly the wrong guess `normalizeCapArmedAt`'s
 * doc above warns against. It degrades to `unreadable` — which, until this
 * fix, `toProfitFactorWire` could produce but no real payload ever
 * triggered; an old server's `null` is now that state's actual production
 * route, not a type-only residual.
 *
 * A bare finite `number` (an old server's un-wrapped `profit_factor`) is
 * routed through `toProfitFactorWire` itself rather than re-implementing its
 * branches here — the domain-to-wire mapping only has one correct
 * definition. An already-shaped `{ kind }` object (today's server) is
 * trusted as-is, except a `ratio` whose `value` is not a finite number,
 * which degrades the same way for the same reason.
 */
function profitFactorOf(value: unknown): ProfitFactorWire {
  if (isPlainObject(value)) {
    if (value.kind === 'no_losses' || value.kind === 'unreadable') {
      return { kind: value.kind };
    }
    if (value.kind === 'ratio' && typeof value.value === 'number' && Number.isFinite(value.value)) {
      return { kind: 'ratio', value: value.value };
    }
    return { kind: 'unreadable' };
  }
  if (typeof value === 'number') return toProfitFactorWire(value);
  return { kind: 'unreadable' };
}

/**
 * Validates a parsed body ONCE, at the fetch boundary, and returns it with
 * `mode` narrowed — or `null` if it is not a snapshot at all.
 *
 * `mode` is deliberately NOT part of the structural check above: an
 * unrecognised or absent mode must not throw the whole payload away, because
 * positions, verdicts and the pipeline are still true and the rail has an
 * honest rendering for an unknown mode ("mode unknown" on the rail). Discarding a good
 * snapshot over one bad field would blank the screen an operator is watching
 * live money on — the opposite of what the field is for. So it degrades to
 * `null` here rather than rejecting, and nothing downstream has to re-check.
 *
 * A mode the server sends but this client does not list is treated as unknown
 * rather than passed through: rendering a word we have never seen would be
 * the "trust the wire" failure this function exists to end.
 *
 * `llm_spend` degrades the same way and for the same reason (#606 item 2): a
 * summary that is absent, or not a shape the panel can render, becomes `null` —
 * the value the rail's LLM cap block is already written to handle.
 * Degrading is NOT the same as trusting: see `isSpendSummary` for why the check
 * has to reject an array and a summary missing its windows rather than casting
 * whatever object arrived. Once the windows are known good, `cap_usd` and
 * `cap_armed_at` degrade PER FIELD (`normalizeCapUsd` / `normalizeCapArmedAt`)
 * rather than voiding the whole summary — the same `mode` reasoning, applied
 * one level deeper (review round 2, MINOR 3).
 *
 * `metrics.profit_factor` degrades PER FIELD the same way (review round 1,
 * MAJOR): `hasWireShape` only requires `metrics` to be a non-null object, so
 * an old server's un-wrapped `profit_factor` reaches here structurally
 * valid but semantically pre-#1270 — `profitFactorOf` is what a whole
 * `metrics` object being "known good" does NOT excuse this one field from.
 */
export function toWireSnapshot(body: unknown): WireSnapshot | null {
  if (!hasWireShape(body)) return null;
  const candidate = body as Record<string, unknown>;
  const mode = (RECOGNISED_MODES as readonly string[]).includes(candidate.mode as string)
    ? (candidate.mode as ServerMode)
    : null;
  const spend = candidate.llm_spend;
  // `spend` is `unknown`, so the spread source still needs a cast; narrowed
  // to `Omit<..., 'cap_usd' | 'cap_armed_at'>` so the two fields actually
  // being normalized below stay compiler-checked against `WireLlmSpendSummary`.
  const llm_spend: WireLlmSpendSummary | null = isSpendSummary(spend)
    ? {
        ...(spend as unknown as Omit<LlmSpendSummary, 'cap_usd' | 'cap_armed_at'>),
        cap_usd: normalizeCapUsd((spend as Record<string, unknown>).cap_usd),
        cap_armed_at: normalizeCapArmedAt((spend as Record<string, unknown>).cap_armed_at),
      }
    : null;
  const metricsField = candidate.metrics as Record<string, unknown>;
  const metrics: MetricsSuiteWire = {
    ...(metricsField as unknown as MetricsSuiteWire),
    profit_factor: profitFactorOf(metricsField.profit_factor),
  };
  return {
    ...(candidate as unknown as Omit<WireSnapshot, 'mode' | 'llm_spend' | 'metrics'>),
    mode,
    llm_spend,
    metrics,
  };
}

interface FeedState {
  snapshot: WireSnapshot | null;
  /** Two poll intervals with no successful (matching-contract) poll. */
  watchdogStale: boolean;
  /**
   * The most recent poll parsed as an object but carried a `contract_version`
   * other than this client's own `CONTRACT_VERSION` (or none at all). Cleared
   * only by a poll that validates — NOT by the passage of time, and NOT by
   * the staleness watchdog, which answers a different question (#1316: a
   * mismatch is a diagnosis about what the server IS saying, not about how
   * long since it last said something trustworthy).
   */
  contractMismatch: boolean;
  lastSuccessAt: string | null;
  error: string | null;
}

const INITIAL: FeedState = {
  snapshot: null,
  watchdogStale: false,
  contractMismatch: false,
  lastSuccessAt: null,
  error: null,
};

/**
 * The single place `FeedStatus` is computed from the raw booleans above —
 * see `FeedStatus`'s doc comment for the ranking and why mismatch outranks
 * staleness. It is also the only thing that reads `watchdogStale`, which is
 * why that flag stayed internal when #1520 removed the `stale` boolean from
 * `SnapshotFeed`: the watchdog still runs, it just has exactly one consumer
 * rather than two that could disagree.
 */
function deriveStatus(state: FeedState): FeedStatus {
  if (state.contractMismatch) return 'contract-mismatch';
  if (state.snapshot === null) return 'waiting';
  return state.watchdogStale ? 'stale' : 'alive';
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function useSnapshot(options: UseSnapshotOptions = {}): SnapshotFeed {
  const {
    url = SNAPSHOT_URL,
    intervalMs = POLL_INTERVAL_MS,
    fetchImpl,
    now = Date.now,
    authToken,
    arm,
  } = options;

  const [state, setState] = useState<FeedState>(INITIAL);

  // A ref, not state: the interval callback must see the current
  // url/fetch/now/authToken/arm without the effect being torn down and
  // rebuilt, which would restart the poll clock on every payload.
  const optionsRef = useRef({ url, fetchImpl, now, authToken, arm });
  optionsRef.current = { url, fetchImpl, now, authToken, arm };

  useEffect(() => {
    let cancelled = false;
    // Both of these are per-effect locals rather than refs on purpose. A ref
    // would outlive the effect, and a remount (React StrictMode does exactly
    // this in development) would then find `inFlight` still true from the
    // previous mount's aborted request and skip its own first poll — leaving
    // the page blank until the next interval tick.
    let inFlight = false;
    let lastSuccessMs = optionsRef.current.now();
    const controllers = new Set<AbortController>();

    const markStale = (watchdogStale: boolean) => {
      setState((prev) =>
        prev.watchdogStale === watchdogStale ? prev : { ...prev, watchdogStale },
      );
    };

    const timeoutMs = pollTimeoutMs(intervalMs);

    const poll = async () => {
      // A poll already in flight is not replaced: overlapping requests would
      // let an older response land after a newer one and move the numbers
      // backwards. The watchdog below is what notices a hang.
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      const doFetch = optionsRef.current.fetchImpl ?? globalThis.fetch;

      // Per POLL INVOCATION, not per effect (PR #607 review round 1, which
      // read it as effect-scoped): a fresh `timedOut` is created on every call,
      // so one poll being declared dead cannot discard the NEXT poll's payload.
      // The flag reaching the guard below is always the one belonging to the
      // request whose response is being examined.
      let timedOut = false;
      // Releasing the poll slot is idempotent and reachable from BOTH the
      // timeout and the `finally` (#606 item 3). Aborting a controller does
      // not settle a request that ignores its signal, so a `finally`-only
      // release leaves `inFlight` true forever after a hang — every later
      // `poll()` returns at the guard above, no retry is ever issued, and the
      // page merely looks stale while having silently stopped polling.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        controllers.delete(controller);
        inFlight = false;
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        release();
        if (cancelled) return;
        const message = `snapshot request timed out after ${timeoutMs}ms`;
        setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
      }, timeoutMs);

      try {
        const { authToken: token } = optionsRef.current;
        // Omitted entirely when there is no token, rather than sent as an
        // empty/blank `Authorization` header (#1038) — the no-token request
        // this dashboard sends by default must stay byte-for-byte the same
        // shape it was before this option existed.
        const headers =
          token !== undefined && token !== null && token !== ''
            ? { Authorization: `Bearer ${token}` }
            : undefined;
        const response = await doFetch(
          snapshotUrl(optionsRef.current.url, optionsRef.current.arm),
          {
            cache: 'no-store',
            signal: controller.signal,
            ...(headers !== undefined ? { headers } : {}),
          },
        );
        if (!response.ok) throw new Error(`snapshot request failed: HTTP ${response.status}`);
        const body: unknown = await response.json();
        // `timedOut` is checked after BOTH awaits, so a response whose headers
        // arrived in time but whose body hung is discarded too: a payload this
        // poll has already been declared dead over must not land later and
        // rewrite the page from a snapshot the page never showed.
        if (cancelled || timedOut) return;
        // Checked BEFORE `toWireSnapshot`/`hasWireShape`, deliberately
        // (#1316): a renamed or dropped field would also fail the structural
        // check below, and the generic "did not match the wire shape" error
        // that path throws reads like a proxy/captive-portal fault, not what
        // it actually is. `readServerContractVersion` only needs `body` to be
        // an object — it makes no other claim about shape — so this check
        // runs on strictly less trust than the structural one and is meant to
        // win the race to explain a bad payload.
        const serverVersion = readServerContractVersion(body);
        if (serverVersion !== CONTRACT_VERSION) {
          // Deliberately does NOT advance `lastSuccessMs` and does NOT touch
          // `snapshot`: this poll produced nothing this client can trust the
          // shape of, so it is not a success by either measure the rest of
          // this hook uses — see `FeedState.contractMismatch`'s doc comment.
          const message =
            serverVersion === undefined
              ? `served bundle disagrees with the server's wire contract (server sent no contract_version; this client expects ${CONTRACT_VERSION})`
              : `served bundle disagrees with the server's wire contract (server ${serverVersion}, client ${CONTRACT_VERSION})`;
          setState((prev) =>
            prev.contractMismatch && prev.error === message
              ? prev
              : { ...prev, contractMismatch: true, error: message },
          );
          return;
        }
        const snapshot = toWireSnapshot(body);
        if (snapshot === null) throw new Error('snapshot payload did not match the wire shape');
        lastSuccessMs = optionsRef.current.now();
        setState(() => ({
          snapshot,
          watchdogStale: false,
          contractMismatch: false,
          lastSuccessAt: new Date(lastSuccessMs).toISOString(),
          error: null,
        }));
      } catch (cause) {
        // An abort is either this effect tearing down or the timeout above,
        // and the timeout has already named itself in `error`.
        if (cancelled || controller.signal.aborted) return;
        // Deliberately leaves `snapshot` and `contractMismatch` untouched:
        // the numbers stay on screen and the watchdog decides when they are
        // stale; a prior mismatch stays a mismatch until a validating poll
        // clears it, rather than being papered over by an unrelated network
        // error's message.
        const message = describeError(cause);
        setState((prev) => (prev.error === message ? prev : { ...prev, error: message }));
      } finally {
        clearTimeout(timeout);
        release();
      }
    };

    void poll();

    const timer = setInterval(() => {
      // Evaluated on every tick, whether or not a request is outstanding: a
      // hung fetch never rejects, so a failure counter would sit at zero while
      // the data rots. "How long since a successful poll" is true of a hang, a
      // rejection and a 500 alike.
      markStale(optionsRef.current.now() - lastSuccessMs > intervalMs * STALE_AFTER_MISSED_POLLS);
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
    };
  }, [intervalMs]);

  return useMemo(() => {
    const status = deriveStatus(state);
    return {
      snapshot: state.snapshot,
      lastSuccessAt: state.lastSuccessAt,
      error: state.error,
      status,
    };
  }, [state]);
}
