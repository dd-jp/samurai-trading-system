import {
  JOURNAL_FILTER_MAX_CHARS,
  type JournalActionFilterWire,
  type JournalDayWire,
  type JournalDecisionWire,
  type JournalOrderWire,
  type JournalWire,
} from '@contracts';
import { type FormEvent, type ReactNode, useState } from 'react';
import { type PollOptions, usePoll } from '../../hooks/usePoll.ts';
import { fixed, gbp, percent, utcMinute } from '../../lib/format.ts';
import { type JournalFilters, journalUrl, NO_FILTERS, outcomeOf } from '../../lib/journal.ts';
import { FeedNote } from '../Panel.tsx';

const TITLE = 'Decision journal';

const ACTIONS: readonly { readonly value: JournalActionFilterWire | ''; readonly label: string }[] =
  [
    { value: '', label: 'Any' },
    { value: 'enter_long', label: 'Entered long' },
    { value: 'enter_short', label: 'Entered short' },
    { value: 'vetoed', label: 'Vetoed' },
    { value: 'skip', label: 'Skipped, not vetoed' },
    { value: 'none', label: 'None' },
  ];

const TEXT_FIELDS = [
  { key: 'book', label: 'Book' },
  { key: 'instrument', label: 'Instrument' },
  { key: 'veto', label: 'Veto category' },
] as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Order({ order }: { order: JournalOrderWire }) {
  return (
    <li>
      {order.leg} {order.side} {order.instrument} ({order.venue}), {order.outcome}
      {order.dry_run ? ', dry run' : ''}, {utcMinute(order.recorded_at)}
      {order.fills.length > 0 && (
        <ul>
          {order.fills.map((fill) => (
            <li key={fill.fill_id}>
              Fill {fill.qty} at {gbp(fill.price_gbp)}, fee {gbp(fill.fee_gbp)},{' '}
              {utcMinute(fill.recorded_at)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Decision({ decision }: { decision: JournalDecisionWire }) {
  return (
    <details className="entry" data-outcome={outcomeOf(decision)}>
      <summary>
        {decision.instrument} {decision.direction}, {decision.book_id}: {outcomeOf(decision)},{' '}
        {percent(decision.confidence, 0)}
      </summary>
      <dl>
        <Fact label="Reason">{decision.reason}</Fact>
        {decision.veto !== null && <Fact label="Veto category">{decision.veto}</Fact>}
        <Fact label="Size">
          {decision.size_shares} shares, stop {fixed(decision.stop_price)}
        </Fact>
        <Fact label="Inputs hash">
          <code>{decision.inputs_hash}</code>
        </Fact>
        <Fact label="Debate">{decision.debate_id ?? 'none'}</Fact>
        <Fact label="Recorded">{utcMinute(decision.recorded_at)}</Fact>
        <Fact label="Payload">
          <pre>{JSON.stringify(decision.payload, null, 2)}</pre>
        </Fact>
      </dl>
      {decision.orders.length > 0 && (
        <ul aria-label="Orders">
          {decision.orders.map((order) => (
            <Order key={order.client_order_id} order={order} />
          ))}
        </ul>
      )}
    </details>
  );
}

function Day({ day }: { day: JournalDayWire }) {
  return (
    <article className="day" aria-label={`Cycle ${day.trading_date}`}>
      <h3>{day.trading_date}</h3>
      {day.decisions.length === 0 && <p className="panel-note">No decisions.</p>}
      {day.decisions.map((decision) => (
        <Decision key={decision.decision_id} decision={decision} />
      ))}
      {day.unlinked_orders.length > 0 && (
        <ul aria-label="Orders no decision owns">
          {day.unlinked_orders.map((order) => (
            <Order key={order.client_order_id} order={order} />
          ))}
        </ul>
      )}
      {day.refusals.length > 0 && (
        <ul aria-label="Refusals">
          {day.refusals.map((refusal) => (
            <li key={refusal.refusal_id}>
              {refusal.scope}, {refusal.parameter} ({refusal.ticket}): {refusal.message}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function Search({ onSearch }: { onSearch: (filters: JournalFilters) => void }) {
  const [draft, setDraft] = useState<JournalFilters>(NO_FILTERS);
  const set = (key: keyof JournalFilters) => (value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(draft);
  };
  return (
    <form className="search" aria-label="Search the journal" onSubmit={submit}>
      <label>
        From
        <input type="date" value={draft.from} onChange={(e) => set('from')(e.target.value)} />
      </label>
      <label>
        To
        <input type="date" value={draft.to} onChange={(e) => set('to')(e.target.value)} />
      </label>
      {TEXT_FIELDS.map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            type="text"
            maxLength={JOURNAL_FILTER_MAX_CHARS}
            value={draft[field.key]}
            onChange={(e) => set(field.key)(e.target.value)}
          />
        </label>
      ))}
      <label>
        Outcome
        <select value={draft.action} onChange={(e) => set('action')(e.target.value)}>
          {ACTIONS.map((action) => (
            <option key={action.value} value={action.value}>
              {action.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Search</button>
    </form>
  );
}

function Pager({
  journal,
  before,
  onPage,
}: {
  journal: JournalWire;
  before: string | null;
  onPage: (before: string | null) => void;
}) {
  return (
    <div className="pager">
      {before !== null && (
        <button type="button" onClick={() => onPage(null)}>
          Newest
        </button>
      )}
      {journal.next_before !== null && (
        <button type="button" onClick={() => onPage(journal.next_before)}>
          Older
        </button>
      )}
    </div>
  );
}

export function JournalPanel({ token, options }: { token: string | null; options: PollOptions }) {
  const [filters, setFilters] = useState<JournalFilters>(NO_FILTERS);
  const [before, setBefore] = useState<string | null>(null);
  const journal = usePoll<JournalWire>(journalUrl(filters, before), token, options);
  const search = (next: JournalFilters) => {
    setFilters(next);
    setBefore(null);
  };
  return (
    <section className="panel wide" aria-label={TITLE} data-status={journal.status}>
      <h2>{TITLE}</h2>
      <Search onSearch={search} />
      <FeedNote state={journal} />
      {journal.data !== null && journal.data.days.length === 0 && (
        <p className="panel-note">No cycle days match.</p>
      )}
      {journal.data?.days.map((day) => (
        <Day key={day.trading_date} day={day} />
      ))}
      {journal.data !== null && <Pager journal={journal.data} before={before} onPage={setBefore} />}
    </section>
  );
}
