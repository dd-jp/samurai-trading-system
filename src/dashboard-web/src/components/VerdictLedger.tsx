/**
 * The verdict ledger (dashboard-spec.md, "Verdict ledger + detail drawer"): a
 * running record of settled decisions, each stamped with a hanko seal —
 * 可 go, 否 no_go, 止 stopped, 略 quorum_skip.
 *
 * Accumulation, dedupe, ordering, the 30-entry cap and first-paint seeding all
 * belong to `lib/ledger.ts`; this component only renders what that state
 * machine produced. Two details it does own:
 *
 *  - **The stamp animates only for entries that were observed settling**
 *    (`seeded === false`). A seeded entry existed before the page opened and
 *    must not claim to have just happened.
 *  - **A row opens the trace stamped on it**, not its instrument's latest one
 *    (#606 item 5). The subheading promises "click a row for its trace", and
 *    an instrument settles many times in a session.
 *  - **The gate/reason wording and the HITL badge come from `verdicts[]`**,
 *    joined on `trace_id`. Lanes that ended at `stopped` or `quorum_skip`
 *    never reach `verdict_log`, so they have no verdict row and carry their
 *    final stage as the reason instead.
 */

import type { VerdictRow } from '../../../dashboard/types.ts';
import { formatClockUtc, UNKNOWN } from '../lib/format.ts';
import type { LedgerEntry } from '../lib/ledger.ts';
import { OUTCOME_WORD, SEAL_GLYPH, stageName } from '../lib/vocabulary.ts';

export interface VerdictLedgerProps {
  entries: readonly LedgerEntry[];
  /** `verdicts[]` keyed by `trace_id` — the gate wording and the HITL flag. */
  verdictsByTrace: ReadonlyMap<string, VerdictRow>;
  /**
   * The trace the drawer is showing, NOT the selected instrument (#606 item
   * 5). An instrument can own several settled rows in one session, and only
   * one of them is the trace on screen — highlighting by instrument would
   * light up rows the drawer is not describing.
   */
  selectedTraceId: string | null;
  /**
   * Selects THIS ROW'S trace, not merely its instrument. The subheading
   * promises "click a row for its trace", and a handler that passed the
   * instrument alone made an older row open that instrument's CURRENT trace —
   * a different decision than the one stamped on the row the operator clicked.
   */
  onSelect: (instrument: string, traceId: string) => void;
}

function reasonFor(entry: LedgerEntry, verdict: VerdictRow | undefined): string {
  if (verdict !== undefined && verdict.reason !== '') return verdict.reason;
  if (entry.outcome === 'quorum_skip') return 'quorum not met at analysts';
  if (entry.final_stage !== null) return `ended at ${stageName(entry.final_stage).toLowerCase()}`;
  return 'no gate recorded for this trace';
}

export function VerdictLedger(props: VerdictLedgerProps) {
  const { entries, verdictsByTrace, selectedTraceId, onSelect } = props;

  return (
    <section className="ledger-panel" aria-label="Verdict ledger">
      <div className="panel-head">
        <h2>Verdict ledger</h2>
        <span className="panel-sub">
          settled outcomes observed this session · newest first · click a row for its trace
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="empty-state">
          No settled decision observed yet — the ledger stamps a row when a lane reaches go, no-go,
          stopped or quorum skip.
        </p>
      ) : (
        <ul className="ledger-list">
          {entries.map((entry) => {
            const verdict = verdictsByTrace.get(entry.trace_id);
            const word = OUTCOME_WORD[entry.outcome];
            const reason = reasonFor(entry, verdict);
            const hitl = verdict?.hitl_override === true;
            const clock = entry.settled_at === null ? UNKNOWN : formatClockUtc(entry.settled_at);
            const rowClass = [
              'ledger-row',
              entry.seeded ? '' : 'ledger-row-stamped',
              selectedTraceId === entry.trace_id ? 'ledger-row-selected' : '',
            ]
              .filter((part) => part !== '')
              .join(' ');
            return (
              <li key={entry.trace_id}>
                {/* A real button, so Enter and Space work without a keydown
                    handler of our own and the row is in the tab order. */}
                <button
                  type="button"
                  className={rowClass}
                  data-trace-id={entry.trace_id}
                  data-outcome={entry.outcome}
                  onClick={() => onSelect(entry.instrument, entry.trace_id)}
                  aria-label={`${entry.instrument}, ${word}${hitl ? ', human override' : ''}, at ${clock}, ${reason}`}
                >
                  <span className={`seal seal-${entry.outcome}`} aria-hidden="true">
                    {SEAL_GLYPH[entry.outcome]}
                  </span>
                  <time className="ledger-time">{clock}</time>
                  <span className="ledger-instrument">{entry.instrument}</span>
                  <span className="ledger-outcome">
                    <span className={`outcome-word outcome-${entry.outcome}`}>{word}</span>
                    {hitl && (
                      <span className="hitl-badge" title="human-in-the-loop override">
                        HITL
                      </span>
                    )}
                    <span className="ledger-reason"> · {reason}</span>
                  </span>
                  <span className="ledger-trace">
                    {entry.trace_id.slice(0, 8)}
                    {entry.seeded ? ' · seeded' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
