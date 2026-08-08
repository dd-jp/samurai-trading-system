/**
 * `prefers-reduced-motion` as React state (issue #538; Motion rule 5).
 *
 * Read in JS as well as in CSS because the rule is not purely presentational:
 * under reduced motion the walk plan itself must degrade to snaps, and a media
 * query cannot tell the planner that. The CSS half (suppressing bob, shimmer,
 * power-on and stamp) lives in `App.css`; this is the half the hooks consume.
 *
 * `matchMedia` is feature-detected rather than assumed: it is absent in jsdom,
 * where every component test runs, and a page whose chips only render when a
 * browser API exists is a page that renders empty in the environment that
 * tests it.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(QUERY);
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // `addEventListener` on a MediaQueryList is the modern spelling; the
    // deprecated `addListener` is not polyfilled here because the deployment
    // target is one operator's current browser on one MacBook.
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
