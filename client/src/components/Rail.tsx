import type { AlpacaBalanceWire, MetricsSuiteWire } from '@contracts';
import type { SnapshotFeed, WireSnapshot } from '../hooks/useSnapshot.ts';
import { formatClockUtc, formatPercent, formatUsd, UNKNOWN } from '../lib/format.ts';
import { providerStateWord, WAITING_FOR_FIRST_SNAPSHOT } from '../lib/vocabulary.ts';
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

export interface RailProps {
  feed: SnapshotFeed;
  tab: Tab;
  onTab: (tab: Tab) => void;
}

type HealthState = 'waiting' | 'stale' | 'alive';

const HEALTH: Readonly<
  Record<HealthState, { word: string; note: (feed: SnapshotFeed) => string }>
> = {
  waiting: {
    word: 'WAITING',
    note: ({ error }) =>
      error === null
        ? WAITING_FOR_FIRST_SNAPSHOT
        : `no snapshot yet — last attempt failed: ${error}`,
  },
  stale: {
    word: 'STALE',
    note: ({ snapshot, error }) =>
      `stale — last update ${formatClockUtc(snapshot?.generated_at ?? '')}${
        error === null ? '' : ` · ${error}`
      }`,
  },
  alive: {
    word: 'ALIVE',
    note: ({ lastSuccessAt }) => `polled ${formatClockUtc(lastSuccessAt ?? '')}`,
  },
};

function HealthBlock({ feed }: { feed: SnapshotFeed }) {
  const state: HealthState = feed.snapshot === null ? 'waiting' : feed.stale ? 'stale' : 'alive';
  const { word, note } = HEALTH[state];
  return (
    <div className="rail-block" data-field="health" data-health={state}>
      <span className="label">Bot</span>
      <span className={`rail-health rail-health-${state}`}>{word}</span>
      <span className="rail-note" role={state === 'stale' ? 'status' : undefined}>
        {note(feed)}
      </span>
    </div>
  );
}

function ModeBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const mode = snapshot?.mode;
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

function LiveTickBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const tick = snapshot?.tick_status ?? null;
  const enteredAt = snapshot?.pipeline.live_entered_at ?? null;
  const traceId = tick?.trace_id ?? snapshot?.pipeline.live_trace_id ?? null;
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

function ProvidersBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const alpaca = snapshot?.providers.alpaca;
  const polygon = snapshot?.providers.polygon;
  const rows = [
    { name: 'Alpaca', tile: alpaca },
    { name: 'Polygon', tile: polygon },
  ];
  return (
    <div className="rail-block" data-field="providers">
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
            equity unavailable —{' '}
            {alpaca.detail === '' ? 'the probe did not read ok' : alpaca.detail}
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
 * #1108: renders only when `alert_delivery_failures` is nonzero — an
 * operator reading the dashboard must be able to tell the alert channel is
 * down, but a healthy channel needs no permanent tile saying so, matching
 * `LiveTickBlock`'s "idle" posture rather than `ProvidersBlock`'s
 * always-shown tiles.
 *
 * This tile is the channel-down surface (#1130) — not a backup to the
 * in-band Telegram "channel degraded" notice the server also posts. That
 * notice shares the escalation chat's own transport, so it cannot arrive in
 * the one case it would matter (the channel actually being down); it only
 * ever reaches a reachable chat. This tile never crosses that transport —
 * it reads `alert_delivery_failures` off the wire, itself a plain SQL count
 * — so it is the one place an operator can actually tell, provided the
 * service-api process's own `TELEGRAM_CHAT_ID` agrees with the
 * orchestrator's; it reads 0 by design under `log-only`, where nothing is
 * ever sent to mark.
 */
function AlertDeliveryBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const count = snapshot?.alert_delivery_failures ?? 0;
  if (count === 0) return null;
  return (
    <div className="rail-block rail-alert-degraded" data-field="alert-delivery-failures">
      <span className="label">Alert channel</span>
      <span className="rail-value" data-alert-degraded="true">
        {count} alert{count === 1 ? '' : 's'} failed to deliver
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
function capOf(snapshot: WireSnapshot | null): number | null | undefined {
  const cap = snapshot?.llm_spend?.cap_usd;
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
function capArmedAtOf(snapshot: WireSnapshot | null): string | null | undefined {
  return snapshot?.llm_spend?.cap_armed_at;
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
  // #1196).
  if (capUsd <= 0) return 'zero';
  return 'capped';
}

const CAP_EMPTY_STATE: Readonly<Record<Exclude<CapReason, 'capped' | 'zero'>, string>> = {
  unknown: 'no spend figure on this snapshot — meter not drawable',
  // Distinct from `ambiguous`: this is a malformed/untrustworthy `cap_usd`
  // itself, not a missing discriminator for an otherwise-explicit `null`
  // (review round 3's MAJOR) — asserts nothing about arming or intent.
  unreadable: 'LLM spend cap on this snapshot could not be read — meter not drawable',
  // Distinct from `uncapped`: nothing may be enforcing anything here, which
  // is the opposite of an operator's deliberate choice (#1196).
  'never-armed': 'LLM spend cap was never armed — meter not drawable',
  uncapped: 'LLM spend is deliberately uncapped — meter not drawable',
  // Asserts NEITHER "armed" nor "unarmed" — a pre-#1196 server (or a
  // malformed cap_armed_at this client could not trust) leaves this wire
  // silent on arming state, and the honest reading is that silence, not a
  // guess in either direction (review round 2).
  ambiguous: 'no trustworthy arming record on this snapshot — meter not drawable',
};

// Never "no LLM budget configured": $0 (or a malformed negative) is a
// configured, maximally restrictive budget, not an absent one — and the
// actual figure is named rather than a hardcoded "$0" (#1196).
function zeroCapEmptyState(capUsd: number): string {
  return `LLM spend cap is ${formatUsd(capUsd)} — meter not drawable`;
}

function SpendBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const allTime = snapshot?.llm_spend?.all_time;
  const spent = allTime?.cost_usd;
  const cap = capOf(snapshot);
  // `CapMeter`'s `cap` prop is `number | null` — it has no concept of
  // "unreadable" of its own, and does not need one: passing `undefined`
  // through as `null` still draws no meter and shows the same em-dash
  // denominator CapMeter already renders for `null` (`CapMeter.tsx`). Only
  // `capReasonOf` below needs the raw three-valued `cap` to tell
  // "unreadable" apart from "the wire explicitly said no cap".
  const capForMeter = cap ?? null;
  const armedAt = capArmedAtOf(snapshot);
  const spendKnown = spent !== undefined && Number.isFinite(spent);
  const reason = capReasonOf(spendKnown, cap, armedAt);
  const unpriced = allTime?.unpriced_calls ?? 0;
  const unattributed = allTime?.per_debate.unattributed_calls ?? 0;
  const windows = snapshot?.llm_spend;
  // A $0 cap with any recorded spend is already breached, but `CapMeter`
  // never divides by a cap `<= 0` (0/0 and x/0 are both unjustifiable), so
  // this is stated directly rather than left for a fabricated `over` flag.
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
          {windows != null && (
            <span className="rail-note mono" data-field="llm-windows">
              24h {formatUsd(windows.last_24h.cost_usd)} · 7d {formatUsd(windows.last_7d.cost_usd)}{' '}
              · all {formatUsd(windows.all_time.cost_usd)}
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

type DrawdownReason = 'absent' | 'unreadable' | 'drawn';

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
function drawdownValueOf(metrics: MetricsSuiteWire | null): number | undefined {
  if (metrics === null) return undefined;
  const value = metrics.max_drawdown;
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value / DRAWDOWN_TOLERANCE) ? value : undefined;
}

/**
 * `metrics === null` and `drawdownValueOf(metrics) === undefined` are BOTH
 * "no value to draw", but they are different facts: the first means no
 * snapshot has ever polled successfully — through this server, `metrics` is
 * required and non-nullable on the wire type, and `useSnapshot.ts`'s
 * `hasWireShape` rejects any payload where it is not a non-null object, so a
 * live snapshot's `metrics` is never itself `null`; the second means a
 * snapshot exists and `max_drawdown` in it could not be read. Collapsing them
 * told the operator "nothing to show yet" for a state that, were
 * `max_drawdown` ever to actually go non-finite, would mean a run happened
 * and returned a broken figure (#1264).
 */
function drawdownReasonOf(
  metrics: MetricsSuiteWire | null,
  value: number | undefined,
): DrawdownReason {
  if (metrics === null) return 'absent';
  return value === undefined ? 'unreadable' : 'drawn';
}

const DRAWDOWN_EMPTY_STATE: Readonly<Record<Exclude<DrawdownReason, 'drawn'>, string>> = {
  absent: 'no daily suite yet — meter not drawable',
  // Says the figure could not be read, not that no suite ran — the opposite
  // claim `absent` above makes for the genuinely-no-report case (#1264).
  unreadable: 'daily suite drawdown figure could not be read — meter not drawable',
};

function DrawdownBlock({ metrics }: { metrics: MetricsSuiteWire | null }) {
  const value = drawdownValueOf(metrics);
  const reason = drawdownReasonOf(metrics, value);
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
  const { feed, tab, onTab } = props;
  const { snapshot, stale, lastSuccessAt } = feed;
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = tabForKey(event.key, tab);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <aside className={stale ? 'rail rail-stale' : 'rail'} aria-label="Rail" data-stale={stale}>
      <span className="brand">
        <i aria-hidden="true">侍</i> SAMURAI
      </span>
      <nav className="rail-tabs" aria-label="Tabs">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: no click handler here — the key handler implements the tablist arrow-key contract for the tab buttons inside. */}
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
      <div className="rail-status">
        <HealthBlock feed={feed} />
        <ModeBlock snapshot={snapshot} />
        <LiveTickBlock snapshot={snapshot} />
        <AlertDeliveryBlock snapshot={snapshot} />
        <ProvidersBlock snapshot={snapshot} />
        <SpendBlock snapshot={snapshot} />
        <DrawdownBlock metrics={snapshot?.metrics ?? null} />
      </div>
      <div className="rail-foot mono muted" data-field="snapshot-clock">
        <span>snapshot {snapshot === null ? UNKNOWN : formatClockUtc(snapshot.as_of)}</span>
        {/* Not a duplicate of HealthBlock's visible "polled" note: this one
            renders in every health state, so it still reaches a screen reader
            once the visible note has switched to STALE's "last update" line. */}
        {lastSuccessAt !== null && (
          <span className="visually-hidden">
            Last successful poll {formatClockUtc(lastSuccessAt)}
          </span>
        )}
      </div>
    </aside>
  );
}
