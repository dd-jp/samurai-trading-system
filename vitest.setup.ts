/**
 * Suite-wide guard: no unit test may reach a host off this machine.
 *
 * ## The incident
 *
 * `startup.test.ts` already argues this case in its own file-local fence
 * (#701): a vendor client whose read API needs no credentials has NOTHING else
 * gating it, so a composition root that constructs it by default will make live
 * calls from a unit suite and every gate stays green. That fence was written
 * for GDELT, extended for Polymarket, and it only ever covered one file.
 *
 * `production.test.ts` calls `orchestrator.start()` 29 times and had no fence.
 * Measured on 2026-08-17 with a DNS-level interceptor (`dns.lookup` /
 * `net.Socket.prototype.connect`, deliberately BELOW `fetch` so a fetch-level
 * fence cannot be measured by itself), on the #504 branch before this file
 * existed:
 *
 *     NETWORK_ESCAPE gamma-api.polymarket.com
 *     NETWORK_ESCAPE clob.polymarket.com
 *     Test Files  1 passed (1)   Tests  92 passed (92)
 *
 * Ninety-two passing tests, two live vendors. It passed because the agent is
 * fired as `void refresh(...)` and `refresh` never throws by contract, so the
 * failure was swallowed into a `warn` nobody reads.
 *
 * ## Why this is global rather than a second copy of the file-local fence
 *
 * Per-file injection of an offline stub is a rule a new test can forget, and
 * `startup.test.ts` records one that already did. Copying its fence into
 * `production.test.ts` would close today's hole and leave the next writer — and
 * the next keyless vendor — to rediscover the same thing a third time. The
 * hazard is a property of the suite, so the guard belongs to the suite.
 *
 * ## Why it records AND throws
 *
 * The throw alone proves nothing, for the reason above: a caller that swallows
 * rejections turns a refused fetch into a passing test. So every refused host
 * is accumulated and re-raised from an `afterAll`, where no application code
 * can catch it and vitest has to report it. `setupFiles` runs once per test
 * FILE, so the `afterAll` registered here is that file's last hook and the
 * report names the file that escaped.
 *
 * ## What is allowed through
 *
 * Loopback only, matched on the parsed hostname and never on a substring —
 * `service-api/server.test.ts` binds an ephemeral `127.0.0.1` port and
 * legitimately fetches it. A substring test would also match a
 * loopback-looking string inside some other host's path or query and hand that
 * host a free pass.
 *
 * A test that needs a specific remote host ANSWERED installs its own
 * `globalThis.fetch` in a `beforeAll`, which overrides this for that file only
 * — `startup.test.ts` does exactly that, and its own accounting is stricter
 * than this one. That is the supported escape hatch; reaching the real network
 * is not.
 */
import { afterAll } from 'vitest';

/**
 * SCOPE, so a green suite is not misread as proof of zero network: this fences
 * `globalThis.fetch` ONLY. `node:http` / `node:https`, `undici.request` and
 * WebSocket clients go straight past it. That is precisely why the incident
 * above was measured at the resolver (`dns.lookup`, `net.Socket.connect`)
 * rather than here — a fetch-level fence cannot measure itself, and cannot see
 * a transport that does not go through it.
 */

/** Hosts a test may talk to: this machine, and nothing else. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Hosts this file was refused, accumulated for the `afterAll` below. */
const escapedToNetwork = new Set<string>();

const realFetch = globalThis.fetch;

/**
 * The parsed hostname of `url` — port stripped, and `''` when it will not
 * parse. Never the full URL: market-data vendors commonly carry the API key in
 * the query string, and this value reaches CI logs.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  // Each argument shape read explicitly. `String(new Request(url))` is the
  // useless '[object Request]', which carries no host and would walk straight
  // past a fence that only stringified — a backstop a caller can route around
  // by passing a different-but-equivalent argument type is not a backstop.
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : String(input);

  const hostname = hostnameOf(url);
  if (LOOPBACK_HOSTNAMES.has(hostname)) return realFetch(input, init);

  const escaped = hostname === '' ? '<unparseable URL>' : hostname;
  escapedToNetwork.add(escaped);
  throw new Error(
    `offline: the test suite must not reach ${escaped}. Inject an offline client (see ` +
      '`offlinePolymarketClient` in startup.test.ts) or install a file-local `globalThis.fetch` ' +
      'that answers this host without leaving the process.',
  );
}) as typeof fetch;

afterAll(() => {
  if (escapedToNetwork.size === 0) return;
  const hosts = [...escapedToNetwork].sort().join(', ');
  escapedToNetwork.clear();
  throw new Error(
    `This test file tried to reach the network: ${hosts}. The request was refused, but the ` +
      'refusal is reported here rather than at the call site because a swallowed rejection ' +
      '(`void agent.refresh(...)`) leaves every test passing — which is how live vendor calls ' +
      'from a unit suite stayed invisible until 2026-08-17. Inject an offline client for the ' +
      'vendor named above.',
  );
});
