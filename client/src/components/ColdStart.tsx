import type { ColdFeed } from '../hooks/useSnapshot.ts';
import { HEALTH } from './Rail.tsx';

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
