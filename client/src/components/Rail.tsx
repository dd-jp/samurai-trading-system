import type { AlpacaBalanceWire, MetricsSuiteWire, TradingArmWire } from '@contracts';
import type { FeedStatus, LiveFeed, SnapshotFeed, WireSnapshot } from '../hooks/useSnapshot.ts';
import { formatClockUtc, formatPercent, formatUsd } from '../lib/format.ts';
import {
  CONTROL_NO_TICK,
  providerStateWord,
  WAITING_FOR_FIRST_SNAPSHOT,
} from '../lib/vocabulary.ts';
import { CapMeter } from './CapMeter.tsx';

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
  feed: LiveFeed;
  tab: Tab;
  onTab: (tab: Tab) => void;
  arm: TradingArmWire;
  onArm: (arm: TradingArmWire) => void;
}

function armAriaLabel(
  entry: { id: TradingArmWire; label: string },
  current: TradingArmWire,
): string {
  return entry.id === current ? `${entry.label} arm, selected` : `${entry.label} arm`;
}

type HealthFeed<S extends FeedStatus> = S extends 'stale' | 'alive' ? LiveFeed : SnapshotFeed;

export const HEALTH: {
  readonly [S in FeedStatus]: {
    word: string;
    note: (feed: HealthFeed<S>) => string;
    rendersHealthTiles: boolean;
    announce: boolean;
  };
} = {
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

function liveTickTraceId(snapshot: WireSnapshot): string | null {
  return snapshot.tick_status?.trace_id ?? snapshot.pipeline.live_trace_id ?? null;
}

function liveTickMain(snapshot: WireSnapshot): { className: string; text: string } {
  const tick = snapshot.tick_status ?? null;
  if (tick !== null) {
    const enteredAt = snapshot.pipeline.live_entered_at ?? null;
    const since = enteredAt !== null ? ` · since ${formatClockUtc(enteredAt)}` : '';
    return { className: 'rail-value mono', text: `${tick.instrument} · ${tick.stage}${since}` };
  }
  if (liveTickTraceId(snapshot) !== null) {
    return {
      className: 'rail-value',
      text: 'live — a trace is running, but this snapshot carries no tick detail',
    };
  }
  return { className: 'rail-value muted', text: 'idle — no tick in progress' };
}

function LiveTickBlock({ snapshot }: { snapshot: WireSnapshot }) {
  if (snapshot.arm === 'control') {
    return (
      <div className="rail-block" data-field="live-tick">
        <span className="label">Live tick</span>
        <span className="rail-value muted">{CONTROL_NO_TICK}</span>
      </div>
    );
  }
  const traceId = liveTickTraceId(snapshot);
  const main = liveTickMain(snapshot);
  return (
    <div className="rail-block" data-field="live-tick">
      <span className="label">Live tick</span>
      <span className={main.className}>{main.text}</span>
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

function capOf(snapshot: WireSnapshot): number | null | undefined {
  const cap = snapshot.llm_spend?.cap_usd;
  if (cap === null) return null;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : undefined;
}

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
  if (capUsd <= 0) return 'zero';
  return 'capped';
}

const CAP_EMPTY_STATE: Readonly<Record<Exclude<CapReason, 'capped' | 'zero'>, string>> = {
  unknown: 'no spend figure on this snapshot — meter not drawable',
  unreadable: 'LLM spend cap on this snapshot could not be read — meter not drawable',
  'never-armed': 'LLM spend cap was never armed — meter not drawable',
  uncapped: 'LLM spend is deliberately uncapped — meter not drawable',
  ambiguous: 'no trustworthy arming record on this snapshot — meter not drawable',
};

function zeroCapEmptyState(capUsd: number): string {
  return `LLM spend cap is ${formatUsd(capUsd)} — meter not drawable`;
}

function spendEmptyState(reason: CapReason, cap: number | null, zeroCapBreached: boolean): string {
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

interface SpendMeterInputs {
  spent: number | undefined;
  capForMeter: number | null;
  armedAt: string | null | undefined;
  reason: CapReason;
  unpriced: number;
  unattributed: number;
  windows: WireSnapshot['llm_spend'];
  zeroCapBreached: boolean;
}

function spendMeterInputs(snapshot: WireSnapshot): SpendMeterInputs {
  const allTime = snapshot.llm_spend?.all_time;
  const spent = allTime?.cost_usd;
  const cap = capOf(snapshot);
  const armedAt = capArmedAtOf(snapshot);
  const spendKnown = spent !== undefined && Number.isFinite(spent);
  const reason = capReasonOf(spendKnown, cap, armedAt);
  const zeroCapBreached = reason === 'zero' && spendKnown && (spent ?? 0) > 0;
  return {
    spent,
    capForMeter: cap ?? null,
    armedAt,
    reason,
    unpriced: allTime?.unpriced_calls ?? 0,
    unattributed: allTime?.per_debate.unattributed_calls ?? 0,
    windows: snapshot.llm_spend,
    zeroCapBreached,
  };
}

function SpendBlock({ snapshot }: { snapshot: WireSnapshot }) {
  const { spent, capForMeter, armedAt, reason, unpriced, unattributed, windows, zeroCapBreached } =
    spendMeterInputs(snapshot);
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

type DrawdownReason = 'unreadable' | 'drawn';

function drawdownValueOf(metrics: MetricsSuiteWire): number | undefined {
  const value = metrics.max_drawdown;
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value / DRAWDOWN_TOLERANCE) ? value : undefined;
}

const DRAWDOWN_EMPTY_STATE: Readonly<Record<Exclude<DrawdownReason, 'drawn'>, string>> = {
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

const TAB_KEY_DELTA: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  ArrowUp: -1,
};

function tabForKey(key: string, current: Tab): Tab | null {
  if (key === 'Home') return TABS[0]?.id ?? null;
  if (key === 'End') return TABS[TABS.length - 1]?.id ?? null;
  const delta = TAB_KEY_DELTA[key];
  if (delta === undefined) return null;
  const index = TABS.findIndex((entry) => entry.id === current);
  return TABS[(index + delta + TABS.length) % TABS.length]?.id ?? null;
}

export function Rail(props: RailProps) {
  const { feed, tab, onTab, arm, onArm } = props;
  const { snapshot, status, lastSuccessAt } = feed;
  const mismatched = status === 'contract-mismatch';
  const stale = status === 'stale';
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
          <span className="visually-hidden">
            Last successful poll {formatClockUtc(lastSuccessAt)}
          </span>
        )}
      </div>
    </aside>
  );
}
