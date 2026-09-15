import type { AlpacaBalanceWire, MetricsSuiteWire, TradingArmWire } from '@contracts';
import type { FeedStatus, LiveFeed, SnapshotFeed, WireSnapshot } from '../hooks/useSnapshot.ts';
import { formatClockUtc, formatPercent, formatUsd } from '../lib/format.ts';
import {
  CONTROL_NO_TICK,
  providerStateWord,
  WAITING_FOR_FIRST_SNAPSHOT,
} from '../lib/vocabulary.ts';
import { CapMeter } from './CapMeter.tsx';

/**
 * The tighter of CONTEXT.md's two stated drawdown tolerances (#798,
 * 2026-08-26): ~26.2% for 3× index ETPs, ~41.8% for 3× single-stock ETPs.
 * The daily suite's `max_drawdown` is one figure for the whole book, so the
 * rail measures it against the tighter bound and says which one it chose.
 */
const DRAWDOWN_TOLERANCE = 0.262;

export type Tab = 'glance' | 'live' | 'review';

export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'glance', label: 'Glance' },
  { id: 'live', label: 'Live' },
  { id: 'review', label: 'Review' },
];

/** The two arms the rail's selector can switch between (#1593) */
export const ARMS: readonly { id: TradingArmWire; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'control', label: 'Control' },
];

export interface RailProps {
  /**
   * A feed that has already produced a snapshot (#1520). The rail reports on
   * the FRESHNESS of the feed, which is not the same job as reporting its
   * absence: a cold start is the page-level state `App.tsx` renders instead
   * of the dashboard, and never reaches here. What does reach here is a
   * snapshot plus the connection state around it — a feed going stale, or
   * answering with a contract this client cannot read — which the rail says
   * on top of the last-known snapshot rather than by blanking it.
   */
  feed: LiveFeed;
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** Which arm's feed the rail — and everything downstream of it — is showing */
  arm: TradingArmWire;
  onArm: (arm: TradingArmWire) => void;
}

/**
 * Plain buttons, not a `role="tablist"` (#1593): the arm selector is a
 * two-way switch, not a set of panels, and a native `<button>` is already
 * keyboard-reachable and operable with no roving-tabindex machinery to
 * duplicate `tabForKey`'s for two items. The selection state is carried IN
 * the accessible name (AC) rather than left to `aria-selected`/`aria-pressed`
 * alone, because a screen reader user switching arms needs to hear WHICH
 * arm is current from the name it just activated, not a separate state
 * announcement that may or may not be read depending on the AT.
 *
 * `aria-label` covers assistive tech, but the selected button's colour tint
 * (`.arm-btn-on`) is otherwise the ONLY thing telling a sighted user which
 * arm is current — exactly what dashboard-spec.md's "colour is never the
 * sole carrier of a signal" rule forbids. The " · selected" span rendered
 * beside the label below is the visible word that rule requires; it plays no
 * part in the accessible name, which `aria-label` already fully replaces.
 */
function armAriaLabel(
  entry: { id: TradingArmWire; label: string },
  current: TradingArmWire,
): string {
  return entry.id === current ? `${entry.label} arm, selected` : `${entry.label} arm`;
}

/**
 * `FeedStatus` (`useSnapshot.ts`) IS this component's health state — it is
 * not re-derived here. #1316's decision comment asked for "one small state
 * discriminator on the client, not three ad-hoc flags": before this change,
 * `Rail.tsx` recomputed waiting/stale/alive from `feed.snapshot`/`feed.stale`
 * by hand, which is exactly the kind of second, parallel derivation that
 * asks to drift from the hook's own. Reading `feed.status` directly is the
 * fix, and is also the extension point #1520 can add its states to.
 *
 * A new `FeedStatus` member needs a new `HEALTH` entry — `Record<FeedStatus,
 * …>` already forces that much — but `word`/`note` alone don't ask the
 * question that actually matters for #1520's cold-start/stale-feed states:
 * may this state's six tiles compute a reading off `snapshot`? Before
 * `rendersHealthTiles` existed, `Rail()` answered that with its own
 * `status === 'contract-mismatch'` check, a second literal comparison
 * outside this record — exactly the kind of parallel derivation the
 * paragraph above warns about, and exactly how a future state that also
 * should not trust `snapshot` (a #1520 case reusing a stale/incomplete
 * bundle) could fall through to the healthy branch by simply not being
 * `'contract-mismatch'`. `rendersHealthTiles` makes that a required field of
 * every entry here, so a new `FeedStatus` member forces a typed decision at
 * `yarn typecheck` time instead of an implicit "yes" by omission.
 *
 * `announce` is that same lesson applied to the one literal comparison still
 * left outside this record after #1316 — `HealthBlock`'s `role=` attribute,
 * which decided by hand which states are urgent enough to interrupt a screen
 * reader. #1520 folded it in: a new state now has to say whether it
 * announces, rather than inheriting silence by not being named in a
 * condition elsewhere in this file.
 *
 * SHARED with the page-level cold-start state (`ColdStart.tsx`), which is why
 * this is exported: the cold states and the freshness states are ONE machine
 * (`FeedStatus`) read by two surfaces, not two vocabularies that have to be
 * kept saying the same words. `note` is typed per member — `'stale'` and
 * `'alive'` are reachable only with a snapshot in hand, so their notes take
 * `LiveFeed` and need no null branch, while the two cold-reachable members
 * take the wider feed.
 */
type HealthFeed<S extends FeedStatus> = S extends 'stale' | 'alive' ? LiveFeed : SnapshotFeed;

export const HEALTH: {
  readonly [S in FeedStatus]: {
    word: string;
    note: (feed: HealthFeed<S>) => string;
    rendersHealthTiles: boolean;
    announce: boolean;
  };
} = {
  // Ranked ahead of every other state in `useSnapshot.ts`'s `deriveStatus` —
  // see that function's doc comment for why a contract mismatch must outrank
  // staleness rather than merely being folded into it
  'contract-mismatch': {
    word: 'MISMATCH',
    note: ({ error }) => error ?? 'served bundle disagrees with the server contract',
    rendersHealthTiles: false,
    announce: true,
  },
  waiting: {
    word: 'WAITING',
    note: ({ error }) =>
      error === null
        ? WAITING_FOR_FIRST_SNAPSHOT
        : `no snapshot yet — last attempt failed: ${error}`,
    rendersHealthTiles: true,
    // The cold-start page is the whole screen, so it is already unmissable;
    // announcing it as a live region would re-read the page a reader has
    // just landed on
    announce: false,
  },
  stale: {
    word: 'STALE',
    note: ({ snapshot, error }) =>
      `stale — last update ${formatClockUtc(snapshot.generated_at)}${
        error === null ? '' : ` · ${error}`
      }`,
    rendersHealthTiles: true,
    announce: true,
  },
  alive: {
    word: 'ALIVE',
    note: ({ lastSuccessAt }) => `polled ${formatClockUtc(lastSuccessAt ?? '')}`,
    rendersHealthTiles: true,
    announce: false,
  },
};

function HealthBlock({ feed }: { feed: LiveFeed }) {
  const { status } = feed;
  const { word, note, announce } = HEALTH[status];
  return (
    <div className="rail-block" data-field="health" data-health={status}>
      <span className="label">Bot</span>
      <span className={`rail-health rail-health-${status}`}>{word}</span>
      <span className="rail-note" role={announce ? 'status' : undefined}>
        {note(feed)}
      </span>
    </div>
  );
}

/**
 * What a health-derived tile becomes while `status === 'contract-mismatch'`
 * (#1316's decision comment: "the Rail refuses to render health-derived
 * tiles — they read as unknown, not calm"). NEVER simply omitted: a hidden
 * tile is indistinguishable from a healthy tile that has nothing to report —
 * the exact bug this issue is named for, one level up — and dashboard-spec.md
 * ("Layout — the Rail") states the general rule this follows: "a blank field
 * reads as zero". So every tile a mismatch would otherwise disable stays
 * present, with its value replaced by this explicit, visually distinct
 * reading instead of a computed one this client can no longer trust the
 * shape behind.
 */
function MismatchBlock({ label, dataField }: { label: string; dataField: string }) {
  return (
    <div className="rail-block rail-contract-mismatch" data-field={dataField}>
      <span className="label">{label}</span>
      <span className="rail-value rail-mismatch-value" data-contract-mismatch="true">
        unknown — contract mismatch
      </span>
    </div>
  );
}

function ModeBlock({ snapshot }: { snapshot: WireSnapshot }) {
  const mode = snapshot.mode;
  const known = mode === 'paper' || mode === 'live';
  return (
    <div className="rail-block" data-field="mode">
      <span className="label">Mode</span>
      {known ? (
        <span className={`pill pill-${mode}`}>{mode.toUpperCase()}</span>
      ) : (
        <span className="rail-value muted">mode unknown</span>
      )}
    </div>
  );
}

/**
 * The control arm is wired with its own in-memory `InMemoryCurrentTickStore`
 * (`control-arm-wiring.ts`), never persisted, so `tick_status` and the
 * pipeline's `live_*` fields can never hold a control row — the server
 * comment quoted below is `sqlite-query-store.ts`'s own name for this state.
 * Reading them as "idle" under the control arm would understate the absence
 * as a quiet moment rather than a structural one (#1597).
 */
function LiveTickBlock({ snapshot }: { snapshot: WireSnapshot }) {
  if (snapshot.arm === 'control') {
    return (
      <div className="rail-block" data-field="live-tick">
        <span className="label">Live tick</span>
        <span className="rail-value muted">{CONTROL_NO_TICK}</span>
      </div>
    );
  }
  const tick = snapshot.tick_status ?? null;
  const enteredAt = snapshot.pipeline.live_entered_at ?? null;
  const traceId = tick?.trace_id ?? snapshot.pipeline.live_trace_id ?? null;
  return (
    <div className="rail-block" data-field="live-tick">
      <span className="label">Live tick</span>
      {tick !== null ? (
        <span className="rail-value mono">
          {tick.instrument} · {tick.stage}
          {enteredAt !== null ? ` · since ${formatClockUtc(enteredAt)}` : ''}
        </span>
      ) : traceId !== null ? (
        <span className="rail-value">
          live — a trace is running, but this snapshot carries no tick detail
        </span>
      ) : (
        <span className="rail-value muted">idle — no tick in progress</span>
      )}
      <span className="rail-note mono">{traceId === null ? 'no live trace' : traceId}</span>
    </div>
  );
}

function balanceFigures(balance: AlpacaBalanceWire) {
  return [
    { name: 'Equity', value: formatUsd(balance.equity) },
    { name: 'Cash', value: formatUsd(balance.cash) },
    {
      name: 'Buying power',
      value: balance.buying_power === null ? 'not sent' : formatUsd(balance.buying_power),
    },
  ];
}

/**
 * dashboard-spec.md's arm selector rule: "Providers, LLM spend and alert
 * delivery render identically in both views, labelled as system" (#1597).
 * These three tiles read fields the wire never scopes by arm — there is only
 * one Alpaca/Polygon probe, one LLM spend ledger and one alert channel per
 * process — so the label states plainly that switching arms will not change
 * them, rather than leaving an operator to infer it from the figures staying
 * put across a switch.
 */
function SystemTag() {
  return (
    <span className="muted small" data-system-fact="true">
      system — identical in both arms
    </span>
  );
}

function ProvidersBlock({ snapshot }: { snapshot: WireSnapshot }) {
  const alpaca = snapshot.providers.alpaca;
  const polygon = snapshot.providers.polygon;
  const rows = [
    { name: 'Alpaca', tile: alpaca },
    { name: 'Polygon', tile: polygon },
  ];
  return (
    <div className="rail-block" data-field="providers">
      <div className="rail-meter-head">
        <span className="label">Providers</span>
        <SystemTag />
      </div>
      {rows.map(({ name, tile }) => {
        const word = tile === undefined ? null : providerStateWord(tile.state);
        return (
          <div key={name} className="rail-row" data-provider-state={tile?.state ?? 'unknown'}>
            <span className="muted">{name}</span>
            <span className={`rail-provider-state provider-${tile?.state ?? 'unknown'}`}>
              {tile === undefined ? 'not polled' : (word ?? 'state not recognised')}
            </span>
          </div>
        );
      })}
      {alpaca !== undefined &&
        (alpaca.balance === null ? (
          <span className="rail-note">
            {`equity unavailable — ${
              alpaca.detail === '' ? 'the probe did not read ok' : alpaca.detail
            }`}
          </span>
        ) : (
          <div className="rail-figures" data-field="alpaca-balance">
            {balanceFigures(alpaca.balance).map(({ name, value }) => (
              <div key={name} className="rail-row">
                <span className="muted">{name}</span>
                <span className="mono">{value}</span>
              </div>
            ))}
          </div>
        ))}
      {alpaca !== undefined && alpaca.balance !== null && alpaca.detail !== '' && (
        <span className="rail-note">Alpaca · {alpaca.detail}</span>
      )}
      {polygon !== undefined && polygon.detail !== '' && (
        <span className="rail-note">Polygon · {polygon.detail}</span>
      )}
    </div>
  );
}

/**
 * #1108: renders only when `alert_delivery_failures_24h` is nonzero — an
 * operator reading the dashboard must be able to tell the alert channel is
 * down, but a healthy channel needs no permanent tile saying so, matching
 * `LiveTickBlock`'s "idle" posture rather than `ProvidersBlock`'s
 * always-shown tiles.
 *
 * This tile is the channel-down surface (#1130) — not a backup to the
 * in-band Telegram "channel degraded" notice the server also posts. That
 * notice shares the escalation chat's own transport, so it arrives only if
 * that chat is reachable at some point within that send's own retry window
 * — it retries like every other send, so that window can run to tens of
 * seconds rather than being the instant it fires — which says nothing about
 * whether the failures it reports were a channel problem, and its silence
 * says nothing at all. This tile never crosses that transport — it reads
 * `alert_delivery_failures_24h` off the wire, itself a plain SQL count — so
 * it is the one place an operator can actually tell.
 *
 * **Absence of this tile is three CONFIGURATION states, not one**, and only
 * two are named at boot (`server/apps/service-api/index.ts`): a
 * healthy-or-quiet channel; `log-only`, where nothing is ever sent to mark
 * and 0 is by design (warned at boot); and a service-api `TELEGRAM_CHAT_ID`
 * that is set but does not match the orchestrator's, which is accepted
 * silently, counts a chat nothing wrote to, and so renders as no tile — a
 * false all-clear indistinguishable from health. `types.ts`'s
 * `getAlertDeliveryFailureCount` doc carries the full trace; #1130 documents
 * this rather than fixing it.
 *
 * WINDOWED, NOT ALL-TIME (#1131). This used to count every row ever recorded,
 * so a single transient failure left the tile reading "degraded" forever —
 * no way to tell a live outage from a resolved blip from weeks ago. The wire
 * field now trails 24 hours and self-clears once the channel has been quiet
 * that long (see `alert-delivery-log.ts`'s `ALERT_DELIVERY_FAILURE_WINDOW_MS`
 * for why 24h specifically). The Telegram "channel degraded" notice above
 * still quotes a SEPARATE in-process count that resets with the server
 * process — the two remain different denominators for the same incident, not
 * duplicates, and the notice's own text says so.
 *
 * A windowed nonzero reading still does not prove the channel is down RIGHT
 * NOW, only that a send failed within the last day — and the "healthy" state
 * above does not prove the opposite either: a row is written only when a
 * send is attempted, so a quiet system with nothing to escalate reads 0 even
 * against a channel that has been dead the whole time. This tile answers "a
 * failure was observed recently", never "the channel is currently reachable".
 */
function AlertDeliveryBlock({ snapshot }: { snapshot: WireSnapshot }) {
  const count = snapshot.alert_delivery_failures_24h;
  if (count === 0) return null;
  return (
    <div className="rail-block rail-alert-degraded" data-field="alert-delivery-failures">
      <div className="rail-meter-head">
        <span className="label">Alert channel</span>
        <SystemTag />
      </div>
      <span className="rail-value" data-alert-degraded="true">
        {count} alert{count === 1 ? '' : 's'} failed to deliver in the last 24h
      </span>
    </div>
  );
}

/**
 * The enforced ceiling to draw a meter against — `null` when a meter would
 * be unjustified but the wire is trustworthy (uncapped, never armed, or an
 * armed `$0`); `undefined` when `cap_usd` itself could not be trusted at all
 * (review round 3's MAJOR). The two are NOT the same claim: `null` says the
 * field answered and the answer was "no cap"; `undefined` says this client
 * does not know what the cap is, which must not be allowed to fall through
 * to `capReasonOf`'s `null` branch and get read as an answer — that
 * collapse is exactly what let a malformed `cap_usd` render as `'uncapped'`
 * (#1196, `normalizeCapUsd`'s doc comment in `useSnapshot.ts`).
 *
 * `$0` is deliberately NOT collapsed here: it is the most restrictive cap
 * there is, and treating it the same as "no cap configured" would invert it
 * into the least restrictive reading. `CapMeter` itself already declines to
 * divide by a `cap <= 0`, so passing `0` through still draws no meter — it
 * just keeps the real number in the head (`$spent / $0.00`) instead of an
 * em dash, and `capReasonOf` below names $0 specifically in the empty state.
 */
function capOf(snapshot: WireSnapshot): number | null | undefined {
  const cap = snapshot.llm_spend?.cap_usd;
  if (cap === null) return null;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : undefined;
}

/**
 * The wire's discriminator between "armed uncapped" and "never armed" — both
 * carry `cap_usd: null`, and only the first carries a non-null
 * `cap_armed_at` (#1196). It is consulted ONLY to split a null cap; a numeric
 * `cap_usd` is itself affirmative evidence that something armed and must be
 * honoured regardless of `cap_armed_at` (`capReasonOf` below, and
 * `contracts/snapshot.ts`'s `cap_usd` doc comment — the ambiguity is `null`
 * vs `null`, not numeric vs `null`).
 *
 * Returns three distinct states, NOT collapsed: a real string (armed,
 * verbatim); `null` (the field is present and explicitly says "no row has
 * ever been written" — genuinely never armed); and `undefined` (the field is
 * ABSENT from this wire object — a pre-#1196 server, or a value so malformed
 * `toWireSnapshot` normalized it away). `undefined` must NOT be treated as
 * `null`: a pre-#1196 server that armed a null cap did boot and did arm, it
 * simply predates this field, and reading its absence as "never armed" is an
 * affirmative false claim about enforcement — collapsing those two with `??`
 * was exactly this ticket's own defect, one level up (review round 2).
 */
function capArmedAtOf(snapshot: WireSnapshot): string | null | undefined {
  return snapshot.llm_spend?.cap_armed_at;
}

type CapReason =
  | 'unknown'
  | 'unreadable'
  | 'never-armed'
  | 'uncapped'
  | 'ambiguous'
  | 'zero'
  | 'capped';

/**
 * Names why the meter is or is not drawable, in priority order:
 *
 * 1. Missing spend outranks everything else (#1140's review) — with no
 *    snapshot this client knows nothing about the operator's budget at all
 *    and must not claim otherwise, not "unconfigured", not "uncapped".
 * 2. `capUsd === undefined` — `cap_usd` itself could not be trusted (wrong
 *    type, non-finite, or a corrupt stored value `SqliteLlmSpendCapStore`
 *    nullified) — outranks `armedAt` entirely (review round 3's MAJOR).
 *    Consulting `armedAt` here would still answer `'uncapped'` for a
 *    payload this client just admitted it cannot read, which is the same
 *    "guess dressed as an answer" mistake `'ambiguous'` exists to refuse
 *    one field over.
 * 3. A present, finite `cap_usd` outranks `cap_armed_at` — a numeric cap IS
 *    the enforced ceiling regardless of whether this wire happens to carry
 *    the arming instant too. Gating on `armedAt` before `capUsd` would throw
 *    away a live denominator on any payload missing `cap_armed_at` (a mixed
 *    client/server version, or simply an older snapshot shape) and render
 *    "never armed" against a run that plainly has an enforced cap — a
 *    regression against `origin/main`, which drew a correct meter for that
 *    same payload. `cap_armed_at` is `#1196`'s discriminator for a NULL cap
 *    only, never a gate on a numeric one.
 * 4. Only once `capUsd` is `null` (the wire EXPLICITLY said so, not merely
 *    unreadable) does `armedAt` decide the reason, and it has THREE
 *    answers, not two: a real string is `uncapped`; an explicit `null` is
 *    `never-armed`; and `undefined` (the field is absent — a pre-#1196
 *    server — or present but too malformed to trust, `normalizeCapArmedAt`
 *    in `useSnapshot.ts`) is `ambiguous` — this client was not told a
 *    trustworthy arming state, and must not guess either "armed" or
 *    "unarmed" for it (review round 2 — the cell round 1's own numeric-cap
 *    fix invoked as its motivating example but never actually tested).
 */
function capReasonOf(
  spendKnown: boolean,
  capUsd: number | null | undefined,
  armedAt: string | null | undefined,
): CapReason {
  if (!spendKnown) return 'unknown';
  if (capUsd === undefined) return 'unreadable';
  if (capUsd === null) {
    if (armedAt === undefined) return 'ambiguous';
    return armedAt === null ? 'never-armed' : 'uncapped';
  }
  // `<= 0`, not `=== 0`: `CapMeter` declines to draw for any non-positive
  // cap, and `'capped'` must imply a drawn meter — a negative `cap_usd` (a
  // malformed wire value no code path in this repo *arms*, but the type is a
  // bare `number`) falling through to `'capped'` would hand `CapMeter` a `''`
  // empty state for a cap it still refuses to draw against (advisor review,
  // #1196)
  if (capUsd <= 0) return 'zero';
  return 'capped';
}

const CAP_EMPTY_STATE: Readonly<Record<Exclude<CapReason, 'capped' | 'zero'>, string>> = {
  unknown: 'no spend figure on this snapshot — meter not drawable',
  // Distinct from `ambiguous`: this is a malformed/untrustworthy `cap_usd`
  // itself, not a missing discriminator for an otherwise-explicit `null`
  // (review round 3's MAJOR) — asserts nothing about arming or intent
  unreadable: 'LLM spend cap on this snapshot could not be read — meter not drawable',
  // Distinct from `uncapped`: nothing may be enforcing anything here, which
  // is the opposite of an operator's deliberate choice (#1196)
  'never-armed': 'LLM spend cap was never armed — meter not drawable',
  uncapped: 'LLM spend is deliberately uncapped — meter not drawable',
  // Asserts NEITHER "armed" nor "unarmed" — a pre-#1196 server (or a
  // malformed cap_armed_at this client could not trust) leaves this wire
  // silent on arming state, and the honest reading is that silence, not a
  // guess in either direction (review round 2)
  ambiguous: 'no trustworthy arming record on this snapshot — meter not drawable',
};

// Never "no LLM budget configured": $0 (or a malformed negative) is a
// configured, maximally restrictive budget, not an absent one — and the
// actual figure is named rather than a hardcoded "$0" (#1196)
function zeroCapEmptyState(capUsd: number): string {
  return `LLM spend cap is ${formatUsd(capUsd)} — meter not drawable`;
}

function SpendBlock({ snapshot }: { snapshot: WireSnapshot }) {
  const allTime = snapshot.llm_spend?.all_time;
  const spent = allTime?.cost_usd;
  const cap = capOf(snapshot);
  // `CapMeter`'s `cap` prop is `number | null` — it has no concept of
  // "unreadable" of its own, and does not need one: passing `undefined`
  // through as `null` still draws no meter and shows the same em-dash
  // denominator CapMeter already renders for `null` (`CapMeter.tsx`). Only
  // `capReasonOf` below needs the raw three-valued `cap` to tell
  // "unreadable" apart from "the wire explicitly said no cap"
  const capForMeter = cap ?? null;
  const armedAt = capArmedAtOf(snapshot);
  const spendKnown = spent !== undefined && Number.isFinite(spent);
  const reason = capReasonOf(spendKnown, cap, armedAt);
  const unpriced = allTime?.unpriced_calls ?? 0;
  const unattributed = allTime?.per_debate.unattributed_calls ?? 0;
  const windows = snapshot.llm_spend;
  // A $0 cap with any recorded spend is already breached, but `CapMeter`
  // never divides by a cap `<= 0` (0/0 and x/0 are both unjustifiable), so
  // this is stated directly rather than left for a fabricated `over` flag
  const zeroCapBreached = reason === 'zero' && spendKnown && (spent ?? 0) > 0;
  return (
    <CapMeter
      dataField="llm-cap"
      heading="LLM cap"
      value={spent}
      cap={capForMeter}
      format={formatUsd}
      tone="cyan"
      emptyState={
        reason === 'capped'
          ? '' // 'capped' means capUsd > 0, which CapMeter always draws
          : reason === 'zero'
            ? `${zeroCapEmptyState(cap ?? 0)}${zeroCapBreached ? ' · already over' : ''}`
            : CAP_EMPTY_STATE[reason]
      }
      trackLabel={(fraction, _value, cap) =>
        `LLM budget used: ${formatPercent(fraction)} of the ${formatUsd(cap)} cap`
      }
      footnote={(over) => (
        <>
          <SystemTag />
          {windows != null && (
            <span className="rail-note mono" data-field="llm-windows">
              {`24h ${formatUsd(windows.last_24h.cost_usd)} · 7d ${formatUsd(
                windows.last_7d.cost_usd,
              )} · all ${formatUsd(windows.all_time.cost_usd)}`}
            </span>
          )}
          <span className="rail-note">
            {over || zeroCapBreached ? 'over cap · ' : ''}
            {unpriced > 0 ? `floor — ${unpriced} unpriced calls` : 'all time, metered locally'}
            {unattributed > 0 ? ` · ${unattributed} calls carry no debate id` : ''}
            {(reason === 'uncapped' || reason === 'zero') && typeof armedAt === 'string'
              ? ` · armed ${formatClockUtc(armedAt)}`
              : ''}
          </span>
        </>
      )}
    />
  );
}

/**
 * `'absent'` — "no daily suite yet" — was removed by #1520 along with the
 * only state that could produce it: it meant `metrics === null`, which this
 * component saw only because `Rail` used to pass `snapshot?.metrics ?? null`
 * through a nullable snapshot. `metrics` is required and non-nullable on the
 * wire (`contracts/snapshot.ts`) and `hasWireShape` rejects a payload where
 * it is not a non-null object, so with the snapshot itself now guaranteed
 * (`LiveFeed`), "no suite has run" has no wire representation to read. A
 * suite that ran and returned an unusable figure is `'unreadable'`, which is
 * what #1264 was actually about.
 */
type DrawdownReason = 'unreadable' | 'drawn';

/**
 * The finite number to hand `CapMeter`, or `undefined` when the field cannot
 * be trusted as one — mirrors `capOf`'s posture above (never hand a consumer
 * a raw wire scalar it has to re-validate).
 *
 * `max_drawdown` is typed as a required, finite fraction
 * (contracts/metrics.ts:38), so a wrong type, `NaN`, or a non-finite value at
 * runtime is an upstream defect, not a documented alternative. The type is
 * checked with `typeof` *before* any arithmetic, rather than folding it into
 * the finiteness check below: dividing first and asking `Number.isFinite` of
 * the quotient — needed anyway, for the overflow case below — would let JS's
 * own numeric coercion (`'0.2' / cap` divides cleanly, `null / cap === 0`)
 * turn a wrong-typed value into a finite-looking quotient before finiteness
 * is ever tested, the same silent-fallthrough class this ticket exists to
 * close. `typeof` sees the value before that coercion has a chance to run.
 *
 * The quotient itself is also checked, not just the raw value: `cap`
 * (`DRAWDOWN_TOLERANCE`) is a fixed, positive, finite constant, so the only
 * way a finite `max_drawdown` can still fail to draw is a value large enough
 * that dividing by it overflows (`1e308 / 0.262` is `Infinity`). Returning
 * that value as "readable" would hand `CapMeter` a value it goes on to
 * refuse to draw (`meter === null` on a non-finite fraction), rendering no
 * sentence at all once the caller assumes "readable" means "drawn".
 */
function drawdownValueOf(metrics: MetricsSuiteWire): number | undefined {
  const value = metrics.max_drawdown;
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value / DRAWDOWN_TOLERANCE) ? value : undefined;
}

const DRAWDOWN_EMPTY_STATE: Readonly<Record<Exclude<DrawdownReason, 'drawn'>, string>> = {
  // Says the figure could not be read — never "no daily suite yet", which
  // would be an affirmative claim that nothing has run, made about a suite
  // that did (#1264)
  unreadable: 'daily suite drawdown figure could not be read — meter not drawable',
};

function DrawdownBlock({ metrics }: { metrics: MetricsSuiteWire }) {
  const value = drawdownValueOf(metrics);
  const reason: DrawdownReason = value === undefined ? 'unreadable' : 'drawn';
  return (
    <CapMeter
      dataField="drawdown"
      heading="Drawdown"
      value={value}
      cap={DRAWDOWN_TOLERANCE}
      format={formatPercent}
      tone="amber"
      emptyState={reason === 'drawn' ? '' : DRAWDOWN_EMPTY_STATE[reason]}
      trackLabel={(_fraction, value) =>
        `max drawdown ${formatPercent(value)} of the ${formatPercent(
          DRAWDOWN_TOLERANCE,
        )} index tolerance`
      }
      footnote={(over) => (
        <span className="rail-note">
          {over ? 'over tolerance · ' : ''}daily suite max · index tolerance (#798)
        </span>
      )}
    />
  );
}

/**
 * Arrow keys move the selected tab, as the tablist pattern requires of a
 * vertical list; Home and End jump to the ends. Focus follows the selection
 * so a keyboard user is never left on a tab that is no longer selected.
 */
function tabForKey(key: string, current: Tab): Tab | null {
  const index = TABS.findIndex((entry) => entry.id === current);
  if (key === 'ArrowDown') return TABS[(index + 1) % TABS.length]?.id ?? null;
  if (key === 'ArrowUp') return TABS[(index - 1 + TABS.length) % TABS.length]?.id ?? null;
  if (key === 'Home') return TABS[0]?.id ?? null;
  if (key === 'End') return TABS[TABS.length - 1]?.id ?? null;
  return null;
}

export function Rail(props: RailProps) {
  const { feed, tab, onTab, arm, onArm } = props;
  const { snapshot, status, lastSuccessAt } = feed;
  const mismatched = status === 'contract-mismatch';
  // Read off `status`, not off a `stale` boolean carried beside it (#1520):
  // inside the rail the two were the same reading, and the second one existed
  // only to cover the cold-start window the page-level gate now owns
  const stale = status === 'stale';
  // The tile gate, not `mismatched`: this is the field #1520 must set on any
  // new `HEALTH` entry, so a state that also shouldn't trust `snapshot` gets
  // caught by the compiler rather than falling through to the healthy
  // branch by default. `mismatched` above stays a literal check because it
  // drives ONLY this state's own visual styling (`rail-mismatch`,
  // `data-contract-mismatch`), not the six tiles' render gate
  const renderHealthTiles = HEALTH[status].rendersHealthTiles;
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = tabForKey(event.key, tab);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <aside
      className={mismatched ? 'rail rail-mismatch' : stale ? 'rail rail-stale' : 'rail'}
      aria-label="Rail"
      data-stale={stale}
      data-contract-mismatch={mismatched}
    >
      <span className="brand">
        <i aria-hidden="true">侍</i> SAMURAI
      </span>
      <nav aria-label="Trading arm">
        <div className="arm-toggle">
          {ARMS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-label={armAriaLabel(entry, arm)}
              className={arm === entry.id ? 'arm-btn arm-btn-on' : 'arm-btn'}
              onClick={() => onArm(entry.id)}
            >
              {entry.label}
              {arm === entry.id && <span className="arm-btn-mark"> · selected</span>}
            </button>
          ))}
        </div>
      </nav>
      <nav className="rail-tabs" aria-label="Tabs">
        <div role="tablist" aria-orientation="vertical" onKeyDown={onTabKey}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`panel-${entry.id}`}
              className={tab === entry.id ? 'tab tab-on' : 'tab'}
              onClick={() => onTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </nav>
      {/*
       * Six health-derived tiles below, each gated on `renderHealthTiles`
       * (`HEALTH[status].rendersHealthTiles`, not a literal `status` check —
       * see that field's doc comment): whenever the current `FeedStatus`
       * says it must not, none of them may compute a reading off `snapshot`
       * — the wire shape underneath it is exactly what is in question during
       * a contract mismatch, and rendering as usual is how #1316 itself
       * happened (`AlertDeliveryBlock`'s `?? 0` reading an absent field as a
       * healthy zero). `MismatchBlock` replaces each with an explicit
       * "unknown" tile instead of hiding it — see that component's doc
       * comment.
       */}
      <div className="rail-status">
        <HealthBlock feed={feed} />
        {renderHealthTiles ? (
          <ModeBlock snapshot={snapshot} />
        ) : (
          <MismatchBlock label="Mode" dataField="mode" />
        )}
        {renderHealthTiles ? (
          <LiveTickBlock snapshot={snapshot} />
        ) : (
          <MismatchBlock label="Live tick" dataField="live-tick" />
        )}
        {renderHealthTiles ? (
          <AlertDeliveryBlock snapshot={snapshot} />
        ) : (
          <MismatchBlock label="Alert channel" dataField="alert-delivery-failures" />
        )}
        {renderHealthTiles ? (
          <ProvidersBlock snapshot={snapshot} />
        ) : (
          <MismatchBlock label="Providers" dataField="providers" />
        )}
        {renderHealthTiles ? (
          <SpendBlock snapshot={snapshot} />
        ) : (
          <MismatchBlock label="LLM cap" dataField="llm-cap" />
        )}
        {renderHealthTiles ? (
          <DrawdownBlock metrics={snapshot.metrics} />
        ) : (
          <MismatchBlock label="Drawdown" dataField="drawdown" />
        )}
      </div>
      <div className="rail-foot mono muted" data-field="snapshot-clock">
        <span>snapshot {formatClockUtc(snapshot.as_of)}</span>
        {/* Not a duplicate of HealthBlock's visible "polled" note: this one
            renders in every health state, so it still reaches a screen reader
            once the visible note has switched to STALE's "last update" line */}
        {lastSuccessAt !== null && (
          <span className="visually-hidden">
            Last successful poll {formatClockUtc(lastSuccessAt)}
          </span>
        )}
      </div>
    </aside>
  );
}
