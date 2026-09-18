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
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
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
