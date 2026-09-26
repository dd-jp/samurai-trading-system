import type { V2OverviewWire } from '@contracts';
import { useEffect, useState } from 'react';
import { StatusStrip } from './components/StatusStrip.tsx';
import { TodayView } from './components/today/TodayView.tsx';
import { type PollOptions, usePoll } from './hooks/usePoll.ts';
import {
  resolveDashboardToken,
  stripTokenParam,
  type TokenStorage,
} from './lib/dashboard-token.ts';
import './App.css';

export const OVERVIEW_URL = '/api/v2/overview';

const VIEWS = [{ id: 'today', label: 'Today' }] as const;

type View = (typeof VIEWS)[number]['id'];

function viewFromHash(): View {
  const id = window.location.hash.replace(/^#/, '');
  return VIEWS.find((view) => view.id === id)?.id ?? 'today';
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
  const [token] = useState(() =>
    resolveDashboardToken(window.location.search, safeSessionStorage),
  );
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
      <StatusStrip
        overview={overview.data}
        status={overview.status}
        error={overview.error}
        token={token}
        fetchImpl={options.fetchImpl}
        onRecorded={overview.refresh}
      />
      <nav className="views" aria-label="Views">
        {VIEWS.map((entry) => (
          <a key={entry.id} href={`#${entry.id}`} aria-current={view === entry.id ? 'page' : undefined}>
            {entry.label}
          </a>
        ))}
      </nav>
      <main>{view === 'today' && overview.data !== null && <TodayView overview={overview.data} />}</main>
    </div>
  );
}
