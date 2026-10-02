import type { HeartbeatWire, PanelWire, V2OverviewWire } from '@contracts';
import type { PollStatus } from '../hooks/usePoll.ts';
import { utcMinute } from '../lib/format.ts';
import { ControlPanel } from './ControlPanel.tsx';

function field<T>(panel: PanelWire<T>, read: (fed: T) => string, empty: string): string {
  if (panel.status === 'fed') return read(panel);
  if (panel.status === 'empty') return empty;
  return `not yet fed (${panel.ticket})`;
}

function nextDueText(due: string, now: string): string {
  return due < now.slice(0, 10) ? `${due} (overdue, estimate)` : `${due} (estimate)`;
}

function Heartbeat({ heartbeat, now }: { heartbeat: HeartbeatWire; now: string }) {
  return (
    <>
      <span>
        Last cycle{' '}
        {field(
          heartbeat.last_cycle,
          (cycle) => `${cycle.trading_date}, recorded ${utcMinute(cycle.recorded_at)}`,
          'none yet',
        )}
      </span>
      <span>
        Next due {field(heartbeat.next_due, (next) => nextDueText(next.due_date, now), 'none')}
      </span>
      <span>
        Ping{' '}
        {field(
          heartbeat.last_ping,
          (ping) => `${ping.outcome} ${utcMinute(ping.pinged_at)}`,
          'none',
        )}
      </span>
    </>
  );
}

const FEED_PROBLEMS: Readonly<Partial<Record<PollStatus, string>>> = {
  waiting: 'Waiting for the first response.',
  unauthorized:
    'The dashboard token is missing or wrong. Open the page with ?token=<SAMURAI_DASHBOARD_TOKEN>.',
  'contract-mismatch':
    'The server runs a different contract version. Rebuild and restart the dashboard.',
};

export interface StatusStripProps {
  readonly overview: V2OverviewWire | null;
  readonly status: PollStatus;
  readonly error: string | null;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly onRecorded: () => void;
}

export function StatusStrip({
  overview,
  status,
  error,
  token,
  fetchImpl,
  onRecorded,
}: StatusStripProps) {
  const problem =
    status === 'failed' ? `The last refresh failed: ${error}.` : FEED_PROBLEMS[status];
  return (
    <header className="strip">
      {problem !== undefined && (
        <p className="warn" role="alert">
          {problem}
        </p>
      )}
      {overview !== null && (
        <>
          <p className="strip-line">
            <strong>{overview.mode.toUpperCase()}</strong>
            <Heartbeat heartbeat={overview.heartbeat} now={overview.generated_at} />
            <span>Data as of {utcMinute(overview.generated_at)}</span>
          </p>
          <ControlPanel
            control={overview.control}
            token={token}
            fetchImpl={fetchImpl}
            onRecorded={onRecorded}
          />
        </>
      )}
    </header>
  );
}
