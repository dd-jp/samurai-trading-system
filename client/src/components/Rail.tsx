import type { MetricsSuiteWire } from '@contracts';
import type { WireSnapshot } from '../hooks/useSnapshot.ts';
import { barWidth, formatClockUtc, formatPercent, formatUsd, UNKNOWN } from '../lib/format.ts';
import { providerStateWord } from '../lib/vocabulary.ts';

/** ADR-0008's spend cap. The rail draws all-time spend against it. */
export const LLM_SPEND_CAP_USD = 50;

/**
 * The tighter of CONTEXT.md's two stated drawdown tolerances (#798,
 * 2026-08-26): ~26.2% for 3× index ETPs, ~41.8% for 3× single-stock ETPs.
 * The daily suite's `max_drawdown` is one figure for the whole book, so the
 * rail measures it against the tighter bound and says which one it chose.
 */
export const DRAWDOWN_TOLERANCE = 0.262;

export type Tab = 'glance' | 'live' | 'review';

export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'glance', label: 'Glance' },
  { id: 'live', label: 'Live' },
  { id: 'review', label: 'Review' },
];

export interface RailProps {
  snapshot: WireSnapshot | null;
  stale: boolean;
  lastSuccessAt: string | null;
  error: string | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
}

function HealthBlock(props: {
  snapshot: WireSnapshot | null;
  stale: boolean;
  error: string | null;
}) {
  const { snapshot, stale, error } = props;
  const state = snapshot === null ? 'waiting' : stale ? 'stale' : 'alive';
  const word = state === 'alive' ? 'ALIVE' : state === 'stale' ? 'STALE' : 'WAITING';
  return (
    <div className="rail-block" data-field="health" data-health={state}>
      <span className="label">Bot</span>
      <span className={`rail-health rail-health-${state}`}>{word}</span>
      <span className="rail-note" role={stale ? 'status' : undefined}>
        {state === 'waiting'
          ? error === null
            ? 'waiting for the first snapshot'
            : `no snapshot yet — last attempt failed: ${error}`
          : state === 'stale'
            ? `stale — last update ${formatClockUtc(snapshot?.generated_at ?? '')}${
                error === null ? '' : ` · ${error}`
              }`
            : `polled ${formatClockUtc(snapshot?.generated_at ?? '')}`}
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
          <div key={name} className="rail-provider" data-provider-state={tile?.state ?? 'unknown'}>
            <span className="muted">{name}</span>
            <span
              className={`rail-provider-state provider-${tile?.state ?? 'unknown'}`}
              title={tile?.detail}
            >
              {tile === undefined ? 'not polled' : (word ?? 'state not recognised')}
            </span>
          </div>
        );
      })}
      {alpaca?.balance != null && (
        <span className="rail-note mono">equity {formatUsd(alpaca.balance.equity)}</span>
      )}
    </div>
  );
}

function Track(props: { fraction: number; tone: 'cyan' | 'amber' | 'bad'; label: string }) {
  const width = barWidth(props.fraction);
  if (width === null) return null;
  return (
    <span className="track" role="img" aria-label={props.label}>
      <i className={`track-fill track-${props.tone}`} style={{ width }} />
    </span>
  );
}

function SpendBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const allTime = snapshot?.llm_spend?.all_time;
  const spent = allTime?.cost_usd;
  const fraction = spent === undefined ? Number.NaN : spent / LLM_SPEND_CAP_USD;
  const overCap = spent !== undefined && Number.isFinite(spent) && spent >= LLM_SPEND_CAP_USD;
  const unpriced = allTime?.unpriced_calls ?? 0;
  return (
    <div className="rail-block" data-field="llm-cap">
      <div className="rail-meter-head">
        <span className="muted">LLM cap</span>
        <span className="mono">
          {spent === undefined ? UNKNOWN : formatUsd(spent)} / ${LLM_SPEND_CAP_USD}
        </span>
      </div>
      {Number.isFinite(fraction) ? (
        <Track
          fraction={fraction}
          tone={overCap ? 'bad' : 'cyan'}
          label={`LLM budget used: ${formatPercent(fraction)} of the $${LLM_SPEND_CAP_USD} cap`}
        />
      ) : (
        <span className="rail-note">no spend figure on this snapshot — meter not drawable</span>
      )}
      <span className="rail-note">
        {overCap ? 'over cap · ' : ''}
        {unpriced > 0 ? `floor — ${unpriced} unpriced calls` : 'all time, metered locally'}
      </span>
    </div>
  );
}

function DrawdownBlock({ metrics }: { metrics: MetricsSuiteWire | null }) {
  const drawdown = metrics?.max_drawdown;
  const fraction = drawdown === undefined ? Number.NaN : drawdown / DRAWDOWN_TOLERANCE;
  const over = Number.isFinite(fraction) && fraction >= 1;
  return (
    <div className="rail-block" data-field="drawdown">
      <div className="rail-meter-head">
        <span className="muted">Drawdown</span>
        <span className="mono">
          {drawdown === undefined ? UNKNOWN : formatPercent(drawdown)} /{' '}
          {formatPercent(DRAWDOWN_TOLERANCE)}
        </span>
      </div>
      {Number.isFinite(fraction) ? (
        <Track
          fraction={fraction}
          tone={over ? 'bad' : 'amber'}
          label={`max drawdown ${formatPercent(drawdown ?? Number.NaN)} of the ${formatPercent(
            DRAWDOWN_TOLERANCE,
          )} index tolerance`}
        />
      ) : (
        <span className="rail-note">no daily suite yet — meter not drawable</span>
      )}
      <span className="rail-note">daily suite max · index tolerance (#798)</span>
    </div>
  );
}

export function Rail(props: RailProps) {
  const { snapshot, stale, lastSuccessAt, error, tab, onTab } = props;
  return (
    <aside className={stale ? 'rail rail-stale' : 'rail'} aria-label="Rail" data-stale={stale}>
      <span className="brand">
        <i aria-hidden="true">侍</i> SAMURAI
      </span>
      <nav className="rail-tabs" aria-label="Tabs">
        <div role="tablist" aria-orientation="vertical">
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
        <HealthBlock snapshot={snapshot} stale={stale} error={error} />
        <ModeBlock snapshot={snapshot} />
        <LiveTickBlock snapshot={snapshot} />
        <ProvidersBlock snapshot={snapshot} />
        <SpendBlock snapshot={snapshot} />
        <DrawdownBlock metrics={snapshot?.metrics ?? null} />
      </div>
      <div className="rail-foot mono muted" data-field="snapshot-clock">
        <span>snapshot {snapshot === null ? UNKNOWN : formatClockUtc(snapshot.as_of)}</span>
        {lastSuccessAt !== null && (
          <span className="visually-hidden">
            Last successful poll {formatClockUtc(lastSuccessAt)}
          </span>
        )}
      </div>
    </aside>
  );
}
