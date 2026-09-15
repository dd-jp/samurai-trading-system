/**
 * The composition root: one poll per arm, one rail, three tabs.
 *
 * State that outlives a poll lives here — which tab is open, which arm is
 * selected, and what each tab has selected — so a 3-second re-render never
 * resets any of it. The verdict ledger and equity series live in
 * `useLedger`/`useEquitySamples`. Everything below is a pure function of
 * `snapshot` plus that state.
 *
 * Switching arms (#1593) is a `key`-forced remount of `ArmView`, not a state
 * update inside it — see that component's doc comment for why. `App` itself
 * owns `tab`/`arm` and the hash they are read from/written to, so a remount
 * on arm switch does not lose which tab was open.
 *
 * `ArmView` is where the client decides, once per arm, whether a snapshot
 * exists at all (#1520): before the first one lands it renders `ColdStart`
 * and nothing else, and after it the rail and all three tabs are handed a
 * non-null `WireSnapshot`. That is a guarantee rather than a reading, because
 * the feed never clears a snapshot it has accepted — see `feedView` in
 * `hooks/useSnapshot.ts`.
 */
import type { TradingArmWire, VerdictRow } from '@contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ColdStart } from './components/ColdStart.tsx';
import { ARMS, Rail, TABS, type Tab } from './components/Rail.tsx';
import { GlanceTab } from './components/tabs/GlanceTab.tsx';
import { LiveTab } from './components/tabs/LiveTab.tsx';
import { ReviewTab } from './components/tabs/ReviewTab.tsx';
import { useEquitySamples } from './hooks/useEquitySamples.ts';
import { useLedger } from './hooks/useLedger.ts';
import {
  feedView,
  type LiveFeed,
  type UseSnapshotOptions,
  useSnapshot,
} from './hooks/useSnapshot.ts';
import {
  resolveDashboardToken,
  stripTokenParam,
  type TokenStorage,
} from './lib/dashboard-token.ts';
import type { Selection } from './lib/resolve-trace.ts';
import './App.css';

function isTab(value: string): value is Tab {
  return TABS.some((entry) => entry.id === value);
}

/**
 * `ARMS` is `Rail.tsx`'s own list — imported rather than re-listed here, so
 * this and the rail's selector read the same two arms (`contracts/snapshot.ts:78`
 * warns "widen both sides together" about exactly this class of duplication)
 */
function isArm(value: string | undefined): value is TradingArmWire {
  return value !== undefined && ARMS.some((entry) => entry.id === value);
}

/**
 * The hash's two segments (#1593): `#<tab>` or `#<tab>/control`. Live carries
 * no second segment at all — not `#<tab>/live` — so every existing bare-hash
 * assertion (`#live`, `#review`, e2e/boot.spec.ts) keeps matching unchanged,
 * and a fresh open or an unrecognised second segment both fall through to the
 * same default `armFromHash` returns.
 */
function hashSegments(): [tab: string, arm: string | undefined] {
  const raw = window.location.hash.replace(/^#/, '');
  const [tab = '', arm] = raw.split('/');
  return [tab, arm];
}

/** The tab named by `location.hash`, so a tab survives a reload and can be linked */
function tabFromHash(): Tab {
  const [tab] = hashSegments();
  return isTab(tab) ? tab : 'glance';
}

/**
 * The arm named by `location.hash`'s second segment. Absent or unrecognised
 * both read as `'live'` (AC: "an unknown hash arm reads as Live") — there is
 * no third state here, unlike `FeedStatus`'s cold-start machinery, because a
 * bad arm segment is not a diagnosis worth surfacing, just a link that named
 * the default.
 */
function armFromHash(): TradingArmWire {
  const [, arm] = hashSegments();
  return isArm(arm) ? arm : 'live';
}

/** The hash a given tab/arm pair writes — the inverse of the two readers above */
function hashFor(tab: Tab, arm: TradingArmWire): string {
  return arm === 'control' ? `#${tab}/control` : `#${tab}`;
}

/**
 * Two independent throw sites, both guarded: `window.sessionStorage`'s
 * PROPERTY ACCESS throws `SecurityError` where site data is blocked
 * (Safari's Block All Cookies, some Chrome privacy settings, some
 * extensions); separately, `getItem`/`setItem` THEMSELVES can throw once the
 * property access has already succeeded (Safari private browsing,
 * `QuotaExceededError`). This runs inside `useState`'s lazy initializer
 * (#1038 round 2 finding A), so either throw reaching the caller unguarded
 * would blow up render with no error boundary to catch it — a white screen,
 * not a degraded dashboard.
 */
function safeSessionStorage(): TokenStorage {
  let store: TokenStorage;
  try {
    store = window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
  return {
    getItem: (key) => {
      try {
        return store.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        store.setItem(key, value);
      } catch {
        // Swallowed: `resolveDashboardToken` still returns the just-read URL
        // token to the caller even when persisting it fails (round 2 finding
        // B) — an unreachable store must cost the NEXT reload its token, not
        // this one's first poll
      }
    },
  };
}

interface DashboardProps {
  live: LiveFeed;
  arm: TradingArmWire;
  onArm: (next: TradingArmWire) => void;
  tab: Tab;
  onTab: (next: Tab) => void;
  onOpenTrace: (selection: Selection) => void;
  liveSelection: Selection | null;
  onSelectLive: (selection: Selection) => void;
  reviewKey: string | null;
  onSelectReview: (key: string | null) => void;
}

/**
 * Everything downstream of the cold-start gate (#1520). The snapshot-derived
 * hooks live here rather than in `App` so they take a non-null `WireSnapshot`
 * — `App` could only hand them `WireSnapshot | null`, which would put the
 * null test the gate exists to remove back into three more places.
 *
 * Nothing is lost by mounting them late: both accumulate ACROSS polls, and
 * there is nothing to accumulate before the first snapshot. This mounts on
 * the poll that ends the cold start and, because the feed never clears a
 * snapshot it has accepted, never unmounts — so neither accumulator is reset
 * by a later stale or mismatched poll. Which tab is open and what it has
 * selected stay in `App`, above the gate, for the same reason they always
 * did.
 *
 * The Control banner renders here, OUTSIDE the three `tab === …` branches
 * below (#1593), so it is on screen for every tab rather than being one
 * tab's furniture — the AC's "on every tab" is a structural fact about where
 * this sits in the tree, not a per-tab prop threaded three times.
 */
function Dashboard(props: DashboardProps) {
  const {
    live,
    arm,
    onArm,
    tab,
    onTab,
    onOpenTrace,
    liveSelection,
    onSelectLive,
    reviewKey,
    onSelectReview,
  } = props;
  const { snapshot } = live;
  const isControl = arm === 'control';

  const ledger = useLedger(snapshot);
  const equitySamples = useEquitySamples(snapshot);
  const verdictsByTrace = useMemo(
    () => new Map<string, VerdictRow>(snapshot.verdicts.map((v) => [v.trace_id, v])),
    [snapshot],
  );

  return (
    <div className={isControl ? 'app-shell app-control' : 'app-shell'}>
      {isControl && (
        <div className="control-banner" role="status" data-field="control-banner">
          CONTROL ARM — simulated fills, no money
        </div>
      )}
      <div className={`app app-${tab}`}>
        <Rail feed={live} tab={tab} onTab={onTab} arm={arm} onArm={onArm} />
        <main id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'glance' && (
            <GlanceTab
              snapshot={snapshot}
              equitySamples={equitySamples}
              ledger={ledger}
              verdictsByTrace={verdictsByTrace}
              onOpenTrace={onOpenTrace}
            />
          )}
          {tab === 'live' && (
            <LiveTab snapshot={snapshot} selection={liveSelection} onSelect={onSelectLive} />
          )}
          {tab === 'review' && (
            <ReviewTab snapshot={snapshot} selectedKey={reviewKey} onSelect={onSelectReview} />
          )}
        </main>
      </div>
    </div>
  );
}

interface ArmViewProps {
  arm: TradingArmWire;
  onArm: (next: TradingArmWire) => void;
  authToken: string | null;
  snapshotOptions: UseSnapshotOptions | undefined;
  tab: Tab;
  onTab: (next: Tab) => void;
  onOpenTrace: (selection: Selection) => void;
  liveSelection: Selection | null;
  onSelectLive: (selection: Selection) => void;
  reviewKey: string | null;
  onSelectReview: (key: string | null) => void;
}

/**
 * Owns the poll for ONE arm (#1593). `key={arm}` on its call site in `App`
 * below is what makes this do its job: React remounts a keyed component
 * rather than re-rendering it when the key changes, so switching arms tears
 * this whole subtree down and rebuilds it from `useSnapshot`'s own initial
 * state — the previous arm's snapshot cannot be shown as current because
 * nothing about it survives the remount, not even transiently. That is a
 * stronger guarantee than clearing a field would be, and asks nothing of
 * `useSnapshot` itself, which stays ignorant of arms being switched under it.
 *
 * Which tab is open and what it has selected are NOT reset by this remount —
 * those live one level up, in `App`, deliberately outside this component.
 */
function ArmView(props: ArmViewProps) {
  const { arm, onArm, authToken, snapshotOptions, ...rest } = props;
  // `arm` after the spread: the rail's selected arm must win over a
  // caller-supplied `snapshotOptions.arm`, not the other way round — no
  // caller does this today, but `arm` is a public `UseSnapshotOptions` field
  const feed = useSnapshot({ authToken, ...snapshotOptions, arm });

  // The one place the client asks whether a snapshot exists (#1520), now
  // scoped to the currently-selected arm's own feed
  const view = feedView(feed);
  if (view.kind === 'cold') return <ColdStart feed={view.feed} />;

  return <Dashboard live={view.feed} arm={arm} onArm={onArm} {...rest} />;
}

export interface AppProps {
  snapshotOptions?: UseSnapshotOptions;
}

export function App({ snapshotOptions }: AppProps = {}) {
  // Resolved synchronously in useState's lazy initializer, not an effect:
  // useSnapshot's poll effect reads `optionsRef.current.authToken` — set
  // during render — the instant it mounts, so an effect-deferred resolution
  // loses that race and sends the FIRST poll unauthenticated whenever a
  // token is resolvable (#1038 round 2 finding A). StrictMode double-invokes
  // this initializer, but that is idempotent (same value, same URL) and not
  // a reason to move it back into an effect. `safeSessionStorage()` guards
  // every storage access this can reach, so nothing here throws out of
  // render (finding B)
  const [authToken] = useState<string | null>(() =>
    resolveDashboardToken(window.location.search, safeSessionStorage()),
  );
  useEffect(() => {
    // Scrubs `?token=...` off the address bar: keeps the token out of the
    // poll's referrer and out of the URL visible after first paint — it
    // does not keep the token off the browser history entry the initial
    // navigation already committed, or out of same-origin subresource
    // `Referer` headers the HTML shell sent before this ran
    // (dashboard-token.ts's header). Preserves `pathname`/`hash` —
    // `tabFromHash` above reads the hash directly off `location`, and
    // rewriting it away here would silently reset whichever tab a shared
    // link pointed at
    const nextSearch = stripTokenParam(window.location.search);
    if (nextSearch !== window.location.search) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${nextSearch}${window.location.hash}`,
      );
    }
  }, []);

  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [arm, setArm] = useState<TradingArmWire>(armFromHash);
  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setArm(armFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const openTab = useCallback(
    (next: Tab) => {
      setTab(next);
      const nextHash = hashFor(next, arm);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    },
    [arm],
  );
  const openArm = useCallback(
    (next: TradingArmWire) => {
      setArm(next);
      const nextHash = hashFor(tab, next);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    },
    [tab],
  );

  const [liveSelection, setLiveSelection] = useState<Selection | null>(null);
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const openTrace = useCallback(
    (selection: Selection) => {
      setLiveSelection(selection);
      openTab('live');
    },
    [openTab],
  );

  return (
    <ArmView
      key={arm}
      arm={arm}
      onArm={openArm}
      authToken={authToken}
      snapshotOptions={snapshotOptions}
      tab={tab}
      onTab={openTab}
      onOpenTrace={openTrace}
      liveSelection={liveSelection}
      onSelectLive={setLiveSelection}
      reviewKey={reviewKey}
      onSelectReview={setReviewKey}
    />
  );
}
