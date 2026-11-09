import type { DecisionWire, JournalDecisionWire, JournalWire, V2OverviewWire } from '@contracts';
import { useState } from 'react';
import { type PollOptions, usePoll } from '../../hooks/usePoll.ts';
import { journalUrl, NO_FILTERS } from '../../lib/journal.ts';
import { FeedPanel } from '../Panel.tsx';
import { DecisionTrace } from '../records/JournalPanel.tsx';
import { DecisionsPanel } from '../today/DecisionsPanel.tsx';

function traceOf(journal: JournalWire, selected: DecisionWire): JournalDecisionWire | undefined {
  return journal.days
    .find((day) => day.trading_date === selected.trading_date)
    ?.decisions.find((decision) => decision.decision_id === selected.decision_id);
}

function Trace({ journal, selected }: { journal: JournalWire; selected: DecisionWire | null }) {
  if (selected === null) return <p className="panel-note">Select a decision to see its trace.</p>;
  const decision = traceOf(journal, selected);
  if (decision === undefined) {
    return <p className="panel-note">This decision is not on the newest journal page.</p>;
  }
  return (
    <div className="entry">
      <p className="panel-lead">
        {decision.instrument} {decision.direction}, {decision.book_id}
      </p>
      <DecisionTrace decision={decision} />
    </div>
  );
}

const NEWEST_JOURNAL_URL = journalUrl(NO_FILTERS, null);

export function LiveView({
  overview,
  token,
  options,
}: {
  overview: V2OverviewWire;
  token: string | null;
  options: PollOptions;
}) {
  const [selected, setSelected] = useState<DecisionWire | null>(null);
  const journal = usePoll<JournalWire>(NEWEST_JOURNAL_URL, token, options);
  return (
    <div className="view" id="view-live">
      <DecisionsPanel panel={overview.decisions} selected={selected} onSelect={setSelected} />
      <FeedPanel title="Trace" state={journal}>
        {(served, note) => (
          <section className="panel" aria-label="Trace">
            <h2>Trace</h2>
            <Trace journal={served} selected={selected} />
            {note}
          </section>
        )}
      </FeedPanel>
    </div>
  );
}
