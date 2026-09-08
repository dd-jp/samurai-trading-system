/**
 * #1355 — the `serveStatic` rejection handler in `server.ts` (`void
 * serveStatic(urlPath, res).catch((err) => { … })`) renders the caught value
 * with `err instanceof Error ? err.message : '…'` inside the `.catch()`
 * itself. A hostile `err.message` throwing there has no further handler:
 * the `.catch()` callback is on a `void`-ed promise, so a throw out of it is
 * an unhandled rejection.
 *
 * Getting a hostile value to that specific `.catch()` needs a real
 * `serveStatic` rejection to originate BEFORE any response header is
 * written — the handler's own `if (res.headersSent) { res.end(); return; }`
 * guard already covers every rejection that happens after a successful
 * `writeHead` (see server.ts's `respondNotFound`/inner-`readFile`-catch,
 * which funnel ordinary "no file to serve" failures through `respondNotFound`
 * without ever reaching this `.catch()` at all). Two calls in that path are
 * NOT wrapped in a try/catch of their own and are both reached BEFORE
 * `respondNotFound`'s `writeHead`: `bundleDiagnostic`'s own `resolvePath(root)`
 * and its `join(resolvedRoot, 'index.html')`. This test drives the second —
 * it mocks `node:path`'s `join` to throw a hostile error for exactly that
 * call, leaving every other `join` call (this file's own temp-path setup
 * included) untouched.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryQueryStore } from './fixture-store.js';
import { createDashboardServer, type DashboardServer } from './server.js';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  const hostileJoin = (...args: Parameters<typeof actual.join>) => {
    if (args[1] === 'index.html') {
      const err = new Error('placeholder');
      Object.defineProperty(err, 'message', {
        get(): string {
          throw new Error('render boom');
        },
        configurable: true,
      });
      throw err;
    }
    return actual.join(...args);
  };
  return { ...actual, join: hostileJoin, default: { ...actual, join: hostileJoin } };
});

describe('dashboard server — serveStatic rejection handler guard (#1355)', () => {
  let server: DashboardServer;
  let parent: string;

  beforeAll(async () => {
    // Deliberately empty, no `index.html` written — GET / then misses in
    // `serveStatic`'s `readFile`, is caught internally, and calls
    // `respondNotFound`, whose `bundleDiagnostic` call is where the mocked
    // `join` throws — before `respondNotFound`'s own `writeHead` runs, so
    // `res.headersSent` is still false when the throw reaches the outer
    // `.catch()` and the vulnerable render is what actually executes.
    parent = await mkdtemp(join(tmpdir(), 'samurai-dashboard-hostile-static-'));
    const bundleRoot = join(parent, 'client');
    server = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new InMemoryQueryStore(),
      bundleRoot,
      mode: 'paper',
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await rm(parent, { recursive: true, force: true });
  });

  it('does not let a hostile err.message become an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // A short abort, not the test's own timeout: before the fix the
      // request never completes at all (the render throws before the
      // vulnerable `writeHead` call ever runs, so no response — not even a
      // hang-until-proxy-timeout like `:303` — is ever written), and the
      // primary assertion below must still run instead of the whole test
      // failing on the fetch alone.
      const result = await fetch(`${server.url}/`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2_000),
      }).then(
        async (r) => ({
          completed: true as const,
          status: r.status,
          body: (await r.json()) as { error: string },
        }),
        (error: unknown) => ({ completed: false as const, error }),
      );
      // An unhandled rejection surfaces on a later turn than the response
      // (or the abort) itself — give the event loop room to raise it
      // before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Asserted first, and unconditionally: this is the property #1355
      // is actually about. A red run without the guard fails right here
      // with the captured hostile error, before either assertion below
      // ever runs.
      expect(unhandled).toEqual([]);
      // Asserted second, and NOT hidden behind `if (result.completed)`:
      // green must prove the guarded render actually fired and answered
      // the request, not merely that nothing threw. If the mock ever stops
      // matching `bundleDiagnostic`'s call (e.g. that call stops using
      // `join`), this line — not a silently-skipped block — is what fails.
      expect(result.completed).toBe(true);
      if (result.completed) {
        expect(result.status).toBe(500);
        expect(result.body.error).toBe('[unrenderable error]');
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 10_000);
});
