/**
 * #1355 — `serveStatic`'s rejection handler (`void serveStatic(urlPath,
 * res).catch((err) => { … })`) renders the caught value inside its own
 * `.catch()` on a void-ed promise; a throw there is unhandled.
 *
 * Reaching that render needs a rejection that occurs before any header is
 * sent — the handler's own `if (res.headersSent) { … }` guard covers every
 * rejection after. Two calls on that path are unwrapped and reached before
 * `respondNotFound`'s own `writeHead`: `bundleDiagnostic`'s
 * `resolvePath(root)` and its `join(resolvedRoot, 'index.html')`. This test
 * drives the second, mocking `node:path`'s `join` to throw only for that
 * call — every other `join` (this file's own temp-path setup included)
 * passes through.
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
    // `.catch()` and the vulnerable render is what actually executes
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
      // A short abort, not the test's own timeout: before the fix,
      // `res.writeHead(500, ...)` still runs first (setting `res.headersSent`
      // and buffering the header block, same order as `:303`) — it's
      // evaluating `.end`'s argument that throws, so `.end()` is never
      // reached and nothing flushes to the socket. The request hangs the
      // same way `:303` does, and the primary assertion below must still run
      // instead of the whole test failing on the fetch alone
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
      // No promise-gate exists for this: the property is an absence (no
      // `unhandledRejection` fired), not the completion of any event this
      // test's own code produces, so there's nothing to `await` that the
      // fast side resolves (docs/coding-standards.md's gate-don't-race
      // rule). It isn't a wall-clock bet either: Node's own unhandled-
      // rejection check runs within a tick of the render throwing — orders
      // of magnitude faster than either branch of `result` above, which
      // already settles no sooner than that (green: after the guarded
      // render + a real response round-trip; red: only after the fetch's
      // own 2s abort). By the time `result` exists, the rejection (if any)
      // has already fired. This flushes exactly one deferred macrotask —
      // not a magnitude-tuned duration — so any check still queued behind
      // it runs before the assertion
      await new Promise((resolve) => setImmediate(resolve));

      // Asserted first, and unconditionally: this is the property #1355
      // is actually about. A red run without the guard fails right here
      // with the captured hostile error, before either assertion below
      // ever runs
      expect(unhandled).toEqual([]);
      // Asserted second, and NOT hidden behind `if (result.completed)`:
      // green must prove the guarded render actually fired and answered
      // the request, not merely that nothing threw. If the mock ever stops
      // matching `bundleDiagnostic`'s call (e.g. that call stops using
      // `join`), this line — not a silently-skipped block — is what fails
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
