import type { LlmSpendWire, PanelWire, ReconcileWire, ResearchWire, TaxWire } from '@contracts';
import { type PollOptions, usePoll } from '../../hooks/usePoll.ts';
import { FeedPanel, OwnedPanel } from '../Panel.tsx';
import { JournalPanel } from './JournalPanel.tsx';
import { LlmSpendPanel } from './LlmSpendPanel.tsx';
import { ResearchPanel } from './ResearchPanel.tsx';

const RESEARCH_URL = '/api/v2/research';
const RECONCILE_URL = '/api/v2/reconcile';
const TAX_URL = '/api/v2/tax';

interface FeedProps {
  readonly token: string | null;
  readonly options: PollOptions;
}

function Research({ token, options }: FeedProps) {
  const research = usePoll<ResearchWire>(RESEARCH_URL, token, options);
  return (
    <FeedPanel title="Research loop" state={research}>
      {(served, note) => <ResearchPanel research={served} note={note} />}
    </FeedPanel>
  );
}

function Reconcile({ token, options }: FeedProps) {
  const reconcile = usePoll<ReconcileWire>(RECONCILE_URL, token, options);
  return (
    <FeedPanel title="Reconcile diffs" state={reconcile}>
      {(served, note) => (
        <OwnedPanel title="Reconcile diffs" panel={served.reconcile}>
          {note}
        </OwnedPanel>
      )}
    </FeedPanel>
  );
}

function Tax({ token, options }: FeedProps) {
  const tax = usePoll<TaxWire>(TAX_URL, token, options);
  return (
    <FeedPanel title="Tax export" state={tax}>
      {(served, note) => (
        <OwnedPanel title="Tax export" panel={served.disposals}>
          <p className="panel-note">
            The CSV download for a tax year opens once the per-disposal tax log exists.
          </p>
          {note}
        </OwnedPanel>
      )}
    </FeedPanel>
  );
}

export function RecordsView({
  token,
  options,
  llmSpend,
}: FeedProps & { llmSpend: PanelWire<LlmSpendWire> }) {
  return (
    <div className="view" id="view-records">
      <JournalPanel token={token} options={options} />
      <Research token={token} options={options} />
      <LlmSpendPanel panel={llmSpend} />
      <Reconcile token={token} options={options} />
      <Tax token={token} options={options} />
    </div>
  );
}
