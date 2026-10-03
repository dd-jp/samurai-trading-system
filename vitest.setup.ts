import { afterAll } from 'vitest';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

const escapedToNetwork = new Set<string>();

const realFetch = globalThis.fetch;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const hostname = hostnameOf(requestUrl(input));
  if (LOOPBACK_HOSTNAMES.has(hostname)) return realFetch(input, init);

  const escaped = hostname === '' ? '<unparseable URL>' : hostname;
  escapedToNetwork.add(escaped);
  throw new Error(
    `offline: the test suite must not reach ${escaped}. Inject an offline client or install a ` +
      'file-local `globalThis.fetch` ' +
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
