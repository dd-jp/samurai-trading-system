/**
 * The e2e suite's one port source (#1298). `playwright.config.ts` calls
 * `resolveE2ePort` — never `acquireFreePort` directly — and derives both
 * `use.baseURL` and `webServer.url` from the result, then passes the same
 * number to the fixture server via `webServer.env.PORT`. No other file holds
 * a port number.
 *
 * Before this, the suite bound a fixed `8788`, so two checkouts running
 * `yarn e2e` at once collided outright: the second run's `webServer` found the
 * port already answering and refused to start (Playwright's own
 * `reuseExistingServer:false` behaviour), which reads exactly like a real e2e
 * failure. See #1298 for the reproduction.
 */
import { createServer } from 'node:net';

/**
 * Binds to port 0 on `host`, reads back whatever port the OS assigned, then
 * releases it — the standard "ask the OS, then let go" pattern for finding a
 * free port to hand to a process that will bind it itself a moment later.
 *
 * This does **not** make two runs unable to collide: the port is free at the
 * instant this resolves, not for the lifetime of the run, and nothing holds
 * it open between the release here and the fixture server's own `listen()`.
 * What it buys is that each concurrent `yarn e2e` draws its own port
 * independently from the OS's full ephemeral range, instead of every run
 * contending for the same fixed number — which is what turned a rare race
 * into a guaranteed collision before this change.
 */
export function acquireFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      probe.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
        } else if (port === null) {
          reject(new Error('acquireFreePort: OS returned no usable port'));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/**
 * The env var one `yarn e2e` invocation uses to make its port choice
 * idempotent across process boundaries.
 *
 * `playwright.config.ts` is not loaded once: Playwright's root process loads
 * it to plan the run and start `webServer`, and it is evaluated again,
 * repeatedly, elsewhere before test bodies run — the exact trigger for each
 * reload was not identified, only that there are many of them. A bare
 * `await acquireFreePort(host)` at module scope therefore drew a fresh port
 * on nearly every load — the webServer bound one port, and most tests' own
 * `baseURL` pointed at a different one each had picked for itself, so those
 * tests saw `ECONNREFUSED`.
 *
 * Observed empirically before this constant existed, on a 9-test run with
 * `workers: 1`: the running server logged one port while 9 of the 9 test
 * failures cited 9 distinct other ports, each a few numbers apart from the
 * last (#1298) — too many distinct values for "once per worker process" or
 * "once per spec file" to explain, and consistent with (though not proof of)
 * a reload per test. Whatever the exact trigger, the config module runs
 * across more than one process and far more than once per invocation.
 */
const PORT_ENV_VAR = 'SAMURAI_E2E_PORT';

/**
 * Resolves this `yarn e2e` invocation's one port: picks it via
 * `acquireFreePort` the first time any process in the invocation calls this
 * (the root process, always first), stashes it in `process.env[PORT_ENV_VAR]`,
 * and every later call — including from a forked worker, which inherits the
 * parent's environment at fork time — reads that value back instead of
 * drawing a new one.
 */
export async function resolveE2ePort(host: string): Promise<number> {
  const existing = process.env[PORT_ENV_VAR];
  if (existing !== undefined && existing !== '') {
    const port = Number(existing);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        `resolveE2ePort: ${PORT_ENV_VAR}="${existing}" is not a valid port; unset it and rerun`,
      );
    }
    return port;
  }
  const port = await acquireFreePort(host);
  process.env[PORT_ENV_VAR] = String(port);
  return port;
}
