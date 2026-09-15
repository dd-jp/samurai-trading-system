/**
 * The suite's `test` object: stock Playwright plus one always-on fixture that
 * makes the "zero external network calls" acceptance criterion (#544) an
 * assertion rather than a claim.
 *
 * Every request the page issues is inspected. Same-origin requests fall
 * through to whatever the test registered (and then to the harness server);
 * anything else is aborted, recorded, and fails the test at teardown — a font
 * CDN, an analytics beacon or a provider API reached from the bundle all
 * surface as a named failure instead of a silent dependency on the machine
 * having internet.
 *
 * **Installed at fixture setup, not in a test body** — for coverage, not
 * precedence. Either order routes correctly: Playwright runs the most recently
 * registered handler first, and this guard's same-origin branch calls
 * `route.fallback()`, which chains back to earlier-registered handlers. What a
 * late registration loses is every request the page has ALREADY made — the
 * bundle, its fonts, the first poll — and those are exactly where an
 * off-origin dependency would hide, so it would turn "zero external network
 * calls" from an assertion into a sample.
 */
import { test as base, expect } from '@playwright/test';

/** Schemes a page may use without touching the network */
const LOCAL_SCHEMES = ['data:', 'blob:', 'about:'];

/**
 * May the page fetch this URL without reaching the network?
 *
 * Exported so the rule can be asserted directly. It is the whole guard — a
 * mistake here does not fail a test, it silently permits the traffic the suite
 * exists to forbid — and driving it through a page reaches only part of it:
 * `fetch()` refuses to construct a request from a credentialed URL at all, so
 * the vector below arrives only by navigation.
 *
 * **Parsed, never prefix-matched.** `url.startsWith(origin)` also accepts
 * `http://127.0.0.1:8788@example.com/x`, where the "origin" is USERINFO and the
 * host is somebody else's — the exact request this guard is for. It equally
 * accepts `http://127.0.0.1:8788.example.com/`, which is not a parseable URL at
 * all. `new URL(url).origin` asks about the host, which is the actual question.
 *
 * **Unparseable fails closed.** A URL this cannot parse is recorded as
 * off-origin rather than waved through: a guard that opens when it is confused
 * is not a guard.
 */
export function isLocalUrl(url: string, origin: string): boolean {
  // Scheme first, and a prefix check is right HERE: these carry no host, and
  // `new URL('data:…').origin` is the string "null", so an origin comparison
  // would reject the very URLs that never touch the network
  if (LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme))) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export const test = base.extend<{ offOriginRequests: string[] }>({
  /** Every off-origin URL the page asked for. Must still be empty at teardown. */
  offOriginRequests: [
    async ({ page, baseURL }, use) => {
      // Named rather than left to `new URL(undefined)`'s bare "Invalid URL":
      // without an origin this guard cannot tell a local request from a remote
      // one, so it must fail pointing at the setting that is missing
      if (baseURL === undefined) {
        throw new Error('the off-origin guard needs `use.baseURL` in playwright.config.ts');
      }
      const origin = new URL(baseURL).origin;
      const offOrigin: string[] = [];
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (isLocalUrl(url, origin)) {
          await route.fallback();
          return;
        }
        offOrigin.push(url);
        await route.abort('blockedbyclient');
      });
      await use(offOrigin);
      expect(offOrigin, 'the dashboard must make no off-origin request').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
