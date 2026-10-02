import {
  CONTROL_REASON_MAX_CHARS,
  type ControlAction,
  type ControlDisplayStateWire,
  type ControlWire,
} from '@contracts';
import { useState } from 'react';
import {
  type ControlOutcome,
  controlRequest,
  type PendingControl,
  sendControl,
} from '../lib/controls.ts';
import { utcMinute } from '../lib/format.ts';

const STATE_WORDS: Readonly<Record<ControlDisplayStateWire, string>> = {
  running: 'RUNNING',
  paused: 'PAUSED',
  'halted-manual': 'HALTED (manual)',
  'halted-loss-budget': 'HALTED (loss budget)',
};

const ACTION_LABELS: Readonly<Record<ControlAction, string>> = {
  pause: 'Pause entries',
  halt: 'Halt: flat at next fill',
  resume: 'Resume',
};

const ACTION_EFFECTS: Readonly<Record<ControlAction, string>> = {
  pause: 'It takes effect at the next cycle.',
  halt: 'Exits go out within about a minute, or at the next cycle if the signals process is down.',
  resume: 'It takes effect at the next cycle.',
};

function outcomeMessage(outcome: ControlOutcome): string {
  switch (outcome.kind) {
    case 'recorded':
      return `${outcome.replayed ? 'Already recorded' : 'Recorded'}: ${outcome.control.action} #${outcome.control.control_id}. ${ACTION_EFFECTS[outcome.control.action]}`;
    case 'too-soon':
      return `One control per 10 seconds: try again in ${outcome.retryAfterSeconds} s.`;
    case 'refused':
      return `Refused: ${outcome.error}.`;
    case 'unauthorized':
      return 'The dashboard token was rejected.';
    case 'failed':
      return `Not sent: ${outcome.error}. Try again; the same request is not recorded twice.`;
  }
}

function History({ control }: { control: ControlWire }) {
  if (control.history.length === 0) return null;
  return (
    <details className="history">
      <summary>Control history ({control.history.length})</summary>
      <table className="grid">
        <tbody>
          {control.history.map((row) => (
            <tr key={row.control_id}>
              <th scope="row">{row.action}</th>
              <td>{utcMinute(row.set_at)}</td>
              <td>{row.source}</td>
              <td>{row.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export interface ControlPanelProps {
  readonly control: ControlWire;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly newKey?: () => string;
  readonly onRecorded: () => void;
}

export function ControlPanel({
  control,
  token,
  fetchImpl = fetch,
  newKey = () => crypto.randomUUID(),
  onRecorded,
}: ControlPanelProps) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<PendingControl | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (action: ControlAction) => {
    const request = controlRequest(action, reason, pending, newKey);
    if ('error' in request) {
      setMessage(request.error);
      return;
    }
    setPending(request);
    setBusy(true);
    const outcome = await sendControl(request, token, fetchImpl);
    setBusy(false);
    setMessage(outcomeMessage(outcome));
    if (outcome.kind === 'recorded') {
      setPending(null);
      setReason('');
      onRecorded();
    }
  };

  const actions: ControlAction[] =
    control.in_force === null ? ['pause', 'halt'] : ['pause', 'halt', 'resume'];

  return (
    <section className="control" aria-label="Halt and pause">
      <p className="state" data-state={control.state}>
        State: <strong>{STATE_WORDS[control.state]}</strong>
        {control.in_force !== null && (
          <span>
            {' '}
            since {utcMinute(control.in_force.set_at)} from {control.in_force.source}:{' '}
            {control.in_force.reason}
          </span>
        )}
      </p>
      {control.loss_budget_halted_books.length > 0 && (
        <p className="warn" role="note">
          The loss budget has halted {control.loss_budget_halted_books.join(', ')}. Resume does not
          lift it.
        </p>
      )}
      <label className="reason">
        Reason
        <input
          type="text"
          value={reason}
          maxLength={CONTROL_REASON_MAX_CHARS}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={`action-${action}`}
            disabled={busy}
            onClick={() => void submit(action)}
          >
            {ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      {message !== null && (
        <p className="panel-note" role="status">
          {message}
        </p>
      )}
      <History control={control} />
    </section>
  );
}
