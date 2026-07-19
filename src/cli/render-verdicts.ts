/**
 * `renderVerdicts` — CLI Verdicts view (#97, docs/specs/cli-spec.md "Module:
 * Views"). Renders the `N` most recent verdict/audit_log entries — a
 * chronological go/no-go history with the gate that fired and any HITL
 * override — so an operator can audit every decision the pipeline made, not
 * just the ones that resulted in a trade. Pure function of `(QueryStore,
 * asOf)`, matching `renderDebates`'s one-seam-per-view convention.
 */
import type { QueryStore } from './types.js';

/** Matches the other views' default recent-history window; no config surface yet. */
const RECENT_VERDICTS_LIMIT = 10;

export function renderVerdicts(store: QueryStore, asOf: Date): string {
  const verdicts = store.getVerdictHistory(RECENT_VERDICTS_LIMIT, asOf);

  const lines: string[] = ['=== Verdicts ==='];

  if (verdicts.length === 0) {
    lines.push('No verdict history.');
  } else {
    for (const verdict of verdicts) {
      lines.push(
        `${verdict.timestamp.toISOString()}  ${verdict.instrument}  ${verdict.status}  reason=${verdict.reason}  hitl_override=${verdict.hitl_override}  trace_id=${verdict.trace_id}`,
      );
    }
  }

  return lines.join('\n');
}
