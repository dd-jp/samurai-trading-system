import type { MetricsSuiteWire } from '@contracts';
import type { SnapshotFeed, WireSnapshot } from '../hooks/useSnapshot.ts';
import { formatClockUtc, formatPercent, formatUsd, UNKNOWN } from '../lib/format.ts';
import { providerStateWord, WAITING_FOR_FIRST_SNAPSHOT } from '../lib/vocabulary.ts';
import { Track } from './Track.tsx';

/** ADR-0008's spend cap. The rail draws all-time spend against it. */
const LLM_SPEND_CAP_USD = 50;

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
    note: ({ snapshot }) => `polled ${formatClockUtc(snapshot?.generated_at ?? '')}`,
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
          <span className="rail-note mono" data-field="alpaca-balance">
            equity {formatUsd(alpaca.balance.equity)} · cash {formatUsd(alpaca.balance.cash)} ·
            buying power{' '}
            {alpaca.balance.buying_power === null
              ? 'not sent'
              : formatUsd(alpaca.balance.buying_power)}
          </span>
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

function SpendBlock({ snapshot }: { snapshot: WireSnapshot | null }) {
  const allTime = snapshot?.llm_spend?.all_time;
  const spent = allTime?.cost_usd;
  const fraction = spent === undefined ? Number.NaN : spent / LLM_SPEND_CAP_USD;
  const overCap = spent !== undefined && Number.isFinite(spent) && spent >= LLM_SPEND_CAP_USD;
  const unpriced = allTime?.unpriced_calls ?? 0;
  const unattributed = allTime?.per_debate.unattributed_calls ?? 0;
  const windows = snapshot?.llm_spend;
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
      {windows != null && (
        <span className="rail-note mono" data-field="llm-windows">
          24h {formatUsd(windows.last_24h.cost_usd)} · 7d {formatUsd(windows.last_7d.cost_usd)} ·
          all {formatUsd(windows.all_time.cost_usd)}
        </span>
      )}
      <span className="rail-note">
        {overCap ? 'over cap · ' : ''}
        {unpriced > 0 ? `floor — ${unpriced} unpriced calls` : 'all time, metered locally'}
        {unattributed > 0 ? ` · ${unattributed} calls carry no debate id` : ''}
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
