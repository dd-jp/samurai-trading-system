import type { FetchLike } from './saxo/saxo-oauth.js';

export const SAXO_SIM_GATEWAY = 'https://gateway.saxobank.com/sim/openapi';
const SIM_ORIGIN = 'https://gateway.saxobank.com';
const SIM_PATH_PREFIX = '/sim/openapi/';

// doc 43: order bursts drew 429s from Saxo's one-order-request-per-second session limit
const TRADE_SPACING_MS = 1_100;

export type SaxoMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface SaxoReply {
  readonly status: number;
  readonly body: unknown;
}

export class SimOnlyRefusal extends Error {}

export function assertSimGateway(baseUrl: string): void {
  if (baseUrl.replace(/\/+$/, '') !== SAXO_SIM_GATEWAY) {
    throw new SimOnlyRefusal(`sim_only_refusal: ${baseUrl} is not the Saxo SIM gateway`);
  }
}

// The live gateway shares this origin, so a dot-segment in a path would resolve onto it
function simUrl(path: string): string {
  const url = new URL(`${SAXO_SIM_GATEWAY}${path}`);
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    url.origin !== SIM_ORIGIN ||
    !url.pathname.startsWith(SIM_PATH_PREFIX)
  ) {
    throw new SimOnlyRefusal(`sim_only_refusal: ${path.split('?')[0]} is not a SIM gateway path`);
  }
  return url.href;
}

export interface SaxoSimGatewayDeps {
  readonly baseUrl: string;
  readonly accessToken: () => Promise<string>;
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class SaxoSimGateway {
  private lastTradeAt = Number.NEGATIVE_INFINITY;
  private requests = 0;

  constructor(private readonly deps: SaxoSimGatewayDeps) {
    assertSimGateway(deps.baseUrl);
  }

  async send(method: SaxoMethod, path: string, body?: unknown): Promise<SaxoReply> {
    const url = simUrl(path);
    if (method !== 'GET') await this.paceTrade();
    this.requests += 1;
    const token = await this.deps.accessToken();
    const response = await this.deps.fetch(url, {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-request-id': `sim-cfd-stop-drill-${this.deps.now()}-${this.requests}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      throw new Error(
        'saxo_sim_unauthorized: the SIM token is expired or invalid; ask David for a fresh one',
      );
    }
    return { status: response.status, body: await readBody(response) };
  }

  async get(path: string): Promise<unknown> {
    const reply = await this.send('GET', path);
    if (reply.status !== 200) {
      throw new Error(`saxo_sim_read_failed: ${reply.status} on ${path.split('?')[0]}`);
    }
    return reply.body;
  }

  private async paceTrade(): Promise<void> {
    const wait = this.lastTradeAt + TRADE_SPACING_MS - this.deps.now();
    if (wait > 0) await this.deps.sleep(wait);
    this.lastTradeAt = this.deps.now();
  }
}
