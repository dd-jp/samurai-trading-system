import type { V2OverviewWire } from '@contracts';
import { useEffect, useState } from 'react';
import { EvidenceView } from './components/evidence/EvidenceView.tsx';
import { GlanceView } from './components/glance/GlanceView.tsx';
import { LiveView } from './components/live/LiveView.tsx';
import { RailHealth } from './components/RailHealth.tsx';
import { RecordsView } from './components/records/RecordsView.tsx';
import { StatusStrip } from './components/StatusStrip.tsx';
import { type PollOptions, usePoll } from './hooks/usePoll.ts';
import {
  resolveDashboardToken,
  stripTokenParam,
  type TokenStorage,
} from './lib/dashboard-token.ts';
import './App.css';

const OVERVIEW_URL = '/api/v2/overview';

const VIEWS = [
  { id: 'glance', label: 'Glance' },
  { id: 'live', label: 'Live' },
  { id: 'review', label: 'Review' },
] as const;

type View = (typeof VIEWS)[number]['id'];

function viewFromHash(): View {
  const id = window.location.hash.replace(/^#/, '');
  return VIEWS.find((view) => view.id === id)?.id ?? 'glance';
}

function orFallback<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

const safeSessionStorage: TokenStorage = {
  getItem: (key) => orFallback(() => window.sessionStorage.getItem(key), null),
  setItem: (key, value) => orFallback(() => window.sessionStorage.setItem(key, value), undefined),
};

function useDashboardToken(): string | null {
  const [token] = useState(() => resolveDashboardToken(window.location.search, safeSessionStorage));
  useEffect(() => {
    const search = stripTokenParam(window.location.search);
    if (search !== window.location.search) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${search}${window.location.hash}`,
      );
    }
  }, []);
  return token;
}

function useView(): View {
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return view;
}

export function App(options: PollOptions = {}) {
  const token = useDashboardToken();
  const view = useView();
  const overview = usePoll<V2OverviewWire>(OVERVIEW_URL, token, options);
  return (
    <div className="app">
      <div className="rail">
        <p className="brand">
          <span lang="ja">侍</span> SAMURAI
        </p>
        <nav className="views" aria-label="Views">
          {VIEWS.map((entry) => (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              aria-current={view === entry.id ? 'page' : undefined}
            >
              {entry.label}
            </a>
          ))}
        </nav>
        <StatusStrip
          overview={overview.data}
          status={overview.status}
          error={overview.error}
          token={token}
          fetchImpl={options.fetchImpl}
          onRecorded={overview.refresh}
        />
        {overview.data !== null && <RailHealth overview={overview.data} />}
      </div>
      <main>
        {view === 'glance' && overview.data !== null && <GlanceView overview={overview.data} />}
        {view === 'live' && overview.data !== null && (
          <LiveView overview={overview.data} token={token} options={options} />
        )}
        {view === 'review' && (
          <>
            <EvidenceView token={token} options={options} />
            <RecordsView token={token} options={options} overview={overview} />
          </>
        )}
      </main>
    </div>
  );
}
