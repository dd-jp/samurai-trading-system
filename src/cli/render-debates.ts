/**
 * `renderDebates` — CLI Debates view (#98, docs/specs/cli-spec.md "Module:
 * Views"). Composes the `N` most recent completed `DebateLog` entries with a
 * coarse tick-in-progress status line. Pure function of `(QueryStore, asOf)`
 * — no I/O beyond the injected store, matching the one-seam-per-view
 * convention every other component's render/query boundary already uses.
 */
import type { QueryStore } from './types.js';

/** Matches the other views' default recent-history window; no config surface yet. */
const RECENT_DEBATES_LIMIT = 10;

export function renderDebates(store: QueryStore, asOf: Date): string {
  const debates = store.getRecentDebates(RECENT_DEBATES_LIMIT, asOf);
  const tickStatus = store.getTickStatus(asOf);

  const lines: string[] = ['=== Debates ==='];

  if (debates.length === 0) {
    lines.push('No completed debates.');
  } else {
    for (const debate of debates) {
      lines.push(
        `${debate.instrument}  ${debate.direction}  rounds=${debate.rounds}  ${debate.created_at.toISOString()}  debate_id=${debate.debate_id}`,
      );
      for (const contribution of debate.contributions) {
        lines.push(
          `  - ${contribution.analyst_id} (${contribution.analyst_type}): ${contribution.final_position}  influence=${contribution.influence_score}`,
        );
      }
    }
  }

  if (tickStatus !== null) {
    lines.push(`tick in progress for ${tickStatus.instrument}`);
  }

  return lines.join('\n');
}
