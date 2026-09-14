import type { ColdFeed } from '../hooks/useSnapshot.ts';
import { HEALTH } from './Rail.tsx';

/**
 * The whole page before the first snapshot lands (#1520, decided in #1144).
 *
 * ONE waiting state for the dashboard, not twenty-two. Per-card waiting
 * states were declined: a half-rendered dashboard during boot makes every
 * leaf answer a question none of them can face, and the interface that forces
 * the question is what produces defaults like `?? []` that an operator cannot
 * tell from a real empty book.
 *
 * Distinct from the stale state by construction, not by wording. Staleness is
 * a snapshot that exists and is aging — the rail says so on top of the last
 * known numbers, which is exactly what an operator is reaching for when a
 * feed drops. This screen is the other case: nothing is known yet, so there
 * are no numbers to mark stale, and it says that once instead of letting
 * blank tiles say it twenty-two times.
 *
 * The health word comes from `Rail.tsx`'s `HEALTH` — the same record, keyed
 * by the same `FeedStatus` — so a cold start that is ALSO a contract mismatch
 * reads MISMATCH here, with the skew named, rather than reporting a silence
 * the feed is not keeping.
 */
export function ColdStart({ feed }: { feed: ColdFeed }) {
  const { status } = feed;
  const { word, note, announce } = HEALTH[status];
  return (
    <main className="cold-start" aria-label="Dashboard" data-health={status}>
      <span className="brand">
        <i aria-hidden="true">侍</i> SAMURAI
      </span>
      <span className={`rail-health rail-health-${status}`} data-field="health">
        {word}
      </span>
      <p className="empty-state" role={announce ? 'status' : undefined}>
        {note(feed)}
      </p>
    </main>
  );
}
