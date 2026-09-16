/**
 * The e2e suite's one port source (#1298). `playwright.config.ts` calls
 * `resolveE2ePort` — never `acquireFreePort` directly — and derives both
 * `use.baseURL` and `webServer.url` from the result, then passes the same
 * number to the fixture server via `webServer.env.PORT`. No other file holds
 * a port number.
 *
 * Before this, the suite bound a fixed `8788`, so two checkouts running
 * `npm run e2e` at once collided outright: the second run's `webServer` found the
 * port already answering and refused to start (Playwright's own
 * `reuseExistingServer:false` behaviour), which reads exactly like a real e2e
 * failure. See #1298 for the reproduction.
 */
import { createServer } from 'node:net';

/**
 * Binds to port 0 on `host`, reads back whatever port the OS assigned, then
 * releases it — the standard "ask the OS, then let go" pattern for finding a
 * free port to hand to a process that binds it itself only much later: the
 * consumer's `webServer.command` is `npm run build && node …`, and the adjacent
 * `webServer.timeout` in `playwright.config.ts` is 300s because the 60s
 * default is not enough for a cold `tsc` + `vite build`. The release-to-bind
 * gap here is tens of seconds to minutes, not a moment.
 *
 * This does **not** make two runs unable to collide: the port is free at the
 * instant this resolves, not for the lifetime of the run, and nothing holds
 * it open between the release here and the fixture server's own `listen()`.
 * What it buys is that each concurrent `npm run e2e` draws its own port
 * independently from the OS's full ephemeral range, instead of every run
 * contending for the same fixed number — which is what turned a rare race
 * into a guaranteed collision before this change.
 *
 * The residual risk this leaves — another process claiming the port during
 * that window — fails in a distinguishable way: `webServer.stdout`/`.stderr`
 * are piped in `playwright.config.ts`, so a bind failure there surfaces as
 * Node's own `EADDRINUSE` error naming the port, not as an unexplained e2e
 * test failure — exactly the confusion #1298 exists to remove.
 */
function acquireFreePort(host: string): Promise<number> {
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
 * The env var one `npm run e2e` invocation uses to make its port choice
 * idempotent across process boundaries.
 *
 * On a green run `playwright.config.ts` is evaluated exactly twice: the root
 * process, which draws the port, and the one worker fork (`workers: 1`),
 * which reads it back — every worker is a `child_process.fork` of the root
 * that inherits `process.env` at fork time and then re-`require`s the config
 * file itself (`ProcessHost.startRunner` and `deserializeConfig` in
 * `node_modules/playwright/lib/runner/index.js` and `lib/common/index.js`).
 * A bare `await acquireFreePort(host)` at module scope would draw a fresh
 * port on each of those loads instead of reusing the root's — the webServer
 * bound one port, and the worker's own `baseURL` pointed at a different one
 * it had drawn for itself, so every test saw `ECONNREFUSED`.
 *
 * Observed empirically before this constant existed, on a 9-test run with
 * `workers: 1`: the running server logged one port while 9 of the 9 test
 * failures cited 9 distinct other ports, each a few numbers apart from the
 * last (#1298) — 1 root + 9 workers, every one a fork of the root. The
 * trigger is Playwright's dispatcher, not a reload per test in the
 * abstract: a failed test makes the dispatcher stop that worker
 * (`worker.stop(true)` on `result.didFail`, same file) and fork a brand-new
 * one for the very next test, so with all 9 tests failing, every single one
 * ran in a worker forked fresh for it, and every fresh fork reloaded the
 * config from scratch — 1 root draw + 9 worker draws, confirmed by
 * re-running this exact 9-test shape with forced failures and logging each
 * load's pid/ppid/inherited env: one root load with no inherited port, and
 * nine worker loads, each a child of the root pid and each already carrying
 * the root's port.
 */
const PORT_ENV_VAR = 'SAMURAI_E2E_PORT';

/**
 * Resolves this `npm run e2e` invocation's one port: picks it via
 * `acquireFreePort` the first time any process in the invocation calls this
 * (the root process, always first), stashes it in `process.env[PORT_ENV_VAR]`,
 * and every later call — including from a forked worker, which inherits the
 * parent's environment at fork time — reads that value back instead of
 * drawing a new one.
 *
 * Also honored as an external override: `SAMURAI_E2E_PORT=<port> npm run e2e`
 * binds that port directly instead of drawing one, because this function has
 * no way to tell "the root process stashed this two calls ago" apart from "a
 * shell had this exported already" — both are just a valid integer in the
 * same variable, and only unparseable values are rejected. Nothing exports
 * it today, so this is not exercised in practice, and setting it externally
 * would reinstate the exact fixed-port collision risk #1298 removed — this
 * is accepted, not recommended. Left as a deliberate escape hatch rather
 * than tightened, because any check that told the two cases apart would
 * need a second, internal-only marker threaded through the same handoff
 * this variable already does — more mechanism than the low-likelihood risk
 * (a stale exported value silently reinstating a fixed port) justifies.
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
