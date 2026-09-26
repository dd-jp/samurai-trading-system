import type { EvidenceWire } from '@contracts';
import { type PollOptions, usePoll } from '../../hooks/usePoll.ts';
import { FeedPanel, OwnedPanel } from '../Panel.tsx';
import { PerformancePanel } from './PerformancePanel.tsx';
import { TradeCountPanel } from './TradeCountPanel.tsx';

const EVIDENCE_URL = '/api/v2/evidence';

export function EvidenceView({ token, options }: { token: string | null; options: PollOptions }) {
  const evidence = usePoll<EvidenceWire>(EVIDENCE_URL, token, options);
  return (
    <div className="view" id="view-evidence">
      <FeedPanel title="Evidence" state={evidence}>
        {(served, note) => (
          <>
            <PerformancePanel evidence={served} note={note} />
            <TradeCountPanel evidence={served} />
            <OwnedPanel title="Live-vs-backtest band" panel={served.band}>
              <p className="panel-note">
                The debate sleeve is forward paper with no backtest band; G1 progress is its
                evidence.
              </p>
            </OwnedPanel>
            <OwnedPanel title="Gate statistics" panel={served.gate} />
          </>
        )}
      </FeedPanel>
    </div>
  );
}
