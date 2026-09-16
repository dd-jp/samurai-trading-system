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
 * The tighter of CONTEXT.md's two drawdown tolerances (index ~26.2% vs
 * single-stock ~41.8%); the daily suite reports one figure for the whole
 * book, so the rail checks it against the stricter bound
 */
const DRAWDOWN_TOLERANCE = 0.262;

export type Tab = 'glance' | 'live' | 'review';

export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'glance', label: 'Glance' },
  { id: 'live', label: 'Live' },
  { id: 'review', label: 'Review' },
];

export const ARMS: readonly { id: TradingArmWire; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'control', label: 'Control' },
];

export interface RailProps {
  /**
   * Already produced a snapshot — cold start is a page-level state
   * `App.tsx` renders instead of the dashboard, and never reaches here. This
   * reports the feed's freshness/health on top of the last-known snapshot,
   * not its absence.
   */
  feed: LiveFeed;
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** Which arm's feed the rail — and everything downstream of it — is showing */
  arm: TradingArmWire;
  onArm: (arm: TradingArmWire) => void;
}

/**
 * Plain buttons, not `role="tablist"`: this is a two-way switch, not a set
 * of panels, so a native `<button>` needs no roving-tabindex machinery.
 * Selection is carried in the accessible name (not `aria-selected`) because
 * the selected-tint colour is otherwise the only signal to a sighted user —
 * dashboard-spec.md: "colour is never the sole carrier of a signal".
 */
function armAriaLabel(
  entry: { id: TradingArmWire; label: string },
  current: TradingArmWire,
): string {
  return entry.id === current ? `${entry.label} arm, selected` : `${entry.label} arm`;
}

/**
 * `FeedStatus` is the single source of truth for health state — never
 * re-derive it from `snapshot`/`stale` flags beside it (that drift caused
 * #1316). `rendersHealthTiles` and `announce` are required fields here so a
 * new `FeedStatus` member forces a typed decision at every call site instead
 * of silently falling through to a literal check elsewhere in this file.
 * Exported because `ColdStart.tsx` shares this same state machine.
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
 * Rendered instead of a health-derived tile during a contract mismatch.
 * Never omitted — a hidden tile is indistinguishable from a healthy tile
 * with nothing to report (dashboard-spec.md: "a blank field reads as zero").
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
 * The control arm's tick store is in-memory only (`control-arm-wiring.ts`),
 * so `tick_status`/`live_*` never hold a control-arm row. Reading them as
 * "idle" under control would understate the absence as a quiet moment
 * rather than a structural one.
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
 * dashboard-spec.md: providers, LLM spend and alert delivery render
 * identically in both arms — there is one probe/ledger/channel per process,
 * not one per arm — so this states plainly what the figures alone would
 * otherwise leave an operator to infer
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
 * Renders only when nonzero — a healthy channel gets no permanent tile.
 * Absence isn't proof of health: it also covers `log-only` mode and a
 * mismatched `TELEGRAM_CHAT_ID` between service-api and the orchestrator,
 * both of which silently produce a zero count. The window is 24h and
 * self-clears, distinct from the in-process "channel degraded" Telegram
 * notice's own counter — a nonzero reading here means a send failed
 * recently, not that the channel is currently unreachable.
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
 * `null` = the wire explicitly says no cap; `undefined` = `cap_usd` itself
 * could not be trusted. Keep these distinct — collapsing them let a
 * malformed `cap_usd` render as `'uncapped'` (`normalizeCapUsd` in
 * `useSnapshot.ts`). `$0` is passed through rather than treated as "no cap":
 * it's the most restrictive cap there is, and `CapMeter` already declines to
 * divide by a `cap <= 0`.
 */
function capOf(snapshot: WireSnapshot): number | null | undefined {
  const cap = snapshot.llm_spend?.cap_usd;
  if (cap === null) return null;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : undefined;
}

/**
 * Discriminates "armed uncapped" from "never armed" when `cap_usd` is null;
 * must not gate a numeric `cap_usd`, which is itself proof something armed
 * (see `capReasonOf` below). `undefined` here means the field is absent
 * (a pre-this-field server) or unreadable — do not collapse that to `null`
 * ("never armed"), which is an affirmative false claim about enforcement.
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
 * Priority order matters: missing spend outranks everything (no snapshot
 * means no known budget); an untrustworthy `capUsd` outranks `armedAt`
 * (guessing 'uncapped' for an unreadable field is the same mistake
 * 'ambiguous' exists to avoid); a present numeric `capUsd` outranks
 * `armedAt` too (a numeric cap is itself proof of enforcement, regardless of
 * whether this wire happens to carry the arming instant). Only a `null`
 * `capUsd` falls through to `armedAt`'s three-way read.
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
  // `<= 0`, not `=== 0`: `CapMeter` refuses to draw for any non-positive
  // cap, so a malformed negative `cap_usd` must not fall through to 'capped'
  if (capUsd <= 0) return 'zero';
  return 'capped';
}

const CAP_EMPTY_STATE: Readonly<Record<Exclude<CapReason, 'capped' | 'zero'>, string>> = {
  unknown: 'no spend figure on this snapshot — meter not drawable',
  // Distinct from `ambiguous`: a malformed/untrustworthy `cap_usd` itself,
  // not a missing discriminator for an otherwise-explicit `null`
  unreadable: 'LLM spend cap on this snapshot could not be read — meter not drawable',
  // Distinct from `uncapped`: nothing is enforcing anything here, the
  // opposite of an operator's deliberate choice
  'never-armed': 'LLM spend cap was never armed — meter not drawable',
  uncapped: 'LLM spend is deliberately uncapped — meter not drawable',
  // Asserts neither "armed" nor "unarmed" — this wire is silent on arming
  // state, and the honest reading is that silence, not a guess either way
  ambiguous: 'no trustworthy arming record on this snapshot — meter not drawable',
};

// $0 (or a malformed negative) is a configured, maximally restrictive
// budget, not an absent one — never "no LLM budget configured"
function zeroCapEmptyState(capUsd: number): string {
  return `LLM spend cap is ${formatUsd(capUsd)} — meter not drawable`;
}

function spendEmptyState(reason: CapReason, cap: number | null, zeroCapBreached: boolean): string {
  // 'capped' means capUsd > 0, which CapMeter always draws
  if (reason === 'capped') return '';
  if (reason === 'zero') {
    return `${zeroCapEmptyState(cap ?? 0)}${zeroCapBreached ? ' · already over' : ''}`;
  }
  return CAP_EMPTY_STATE[reason];
}

function spendFootnoteNote(input: {
  over: boolean;
  zeroCapBreached: boolean;
  unpriced: number;
  unattributed: number;
  reason: CapReason;
  armedAt: string | null | undefined;
}): string {
  const { over, zeroCapBreached, unpriced, unattributed, reason, armedAt } = input;
  const overPrefix = over || zeroCapBreached ? 'over cap · ' : '';
  const base = unpriced > 0 ? `floor — ${unpriced} unpriced calls` : 'all time, metered locally';
  const unattributedSuffix = unattributed > 0 ? ` · ${unattributed} calls carry no debate id` : '';
  const armedSuffix =
    (reason === 'uncapped' || reason === 'zero') && typeof armedAt === 'string'
      ? ` · armed ${formatClockUtc(armedAt)}`
      : '';
  return `${overPrefix}${base}${unattributedSuffix}${armedSuffix}`;
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
      emptyState={spendEmptyState(reason, capForMeter, zeroCapBreached)}
      trackLabel={(fraction, _value, cap) =>
        `LLM budget used: ${formatPercent(fraction)} of the ${formatUsd(cap)} cap`
      }
      footnote={(over) => (
        <>
          <SystemTag />
          {windows != null && (
            <span className="rail-note mono" data-field="llm-windows">
              24h {formatUsd(windows.last_24h.cost_usd)} · 7d {formatUsd(windows.last_7d.cost_usd)}{' '}
              · all {formatUsd(windows.all_time.cost_usd)}
            </span>
          )}
          <span className="rail-note">
            {spendFootnoteNote({ over, zeroCapBreached, unpriced, unattributed, reason, armedAt })}
          </span>
        </>
      )}
    />
  );
}

/**
 * `metrics` is required and non-nullable on the wire, so "no suite has run"
 * has no wire representation to read — a suite that ran but returned an
 * unusable figure is `'unreadable'` instead
 */
type DrawdownReason = 'unreadable' | 'drawn';

/**
 * The finite number to hand `CapMeter`, or `undefined` when the field cannot
 * be trusted — mirrors `capOf`'s posture above. `typeof` is checked before
 * dividing: numeric coercion (`'0.2' / cap`, `null / cap === 0`) could turn
 * a wrong-typed value into a finite-looking quotient before a finiteness
 * check ever runs. The quotient is also checked, not just the raw value,
 * because a huge but finite `max_drawdown` can overflow when divided by the
 * fixed `DRAWDOWN_TOLERANCE` (e.g. `1e308 / 0.262` is `Infinity`).
 */
function drawdownValueOf(metrics: MetricsSuiteWire): number | undefined {
  const value = metrics.max_drawdown;
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value / DRAWDOWN_TOLERANCE) ? value : undefined;
}

const DRAWDOWN_EMPTY_STATE: Readonly<Record<Exclude<DrawdownReason, 'drawn'>, string>> = {
  // Never "no daily suite yet" — that would be an affirmative claim that
  // nothing has run, made about a suite that did
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

// Follows the ARIA vertical-tablist keyboard pattern (arrows move, Home/End jump to ends)
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
  // Read off `status`, not a separate `stale` boolean — the page-level gate
  // owns the cold-start window, so there is only one reading left in here
  const stale = status === 'stale';
  // The tile gate, not `mismatched` — `mismatched` only drives this state's
  // own visual styling. `rendersHealthTiles` forces a typed decision for
  // every `HEALTH` entry, so a state that shouldn't trust `snapshot` can't
  // fall through to the healthy branch by default (see `MismatchBlock`)
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
        {lastSuccessAt !== null && (
          // Not a duplicate of HealthBlock's visible "polled" note: this one
          // renders in every health state, so it still reaches a screen reader
          // once the visible note has switched to STALE's "last update" line
          <span className="visually-hidden">
            Last successful poll {formatClockUtc(lastSuccessAt)}
          </span>
        )}
      </div>
    </aside>
  );
}
