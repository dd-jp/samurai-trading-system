/**
 * The mode-derived Alpaca endpoint guard (#293). These tests are the only
 * thing standing between a `paper` process and real money if someone points
 * `ALPACA_BASE_URL` at the live host.
 */
import { buildDefaultAlpacaBrokerClient } from './production.js';
import type { LogEntry, Logger } from './types.js';

/**
 * Spelled out rather than imported from `production.ts`. The constants there
 * are module-private, but that is not the only reason: asserting a value
 * against the constant that produced it proves the code is self-consistent,
 * not that `paper` reaches the paper host. These literals are the actual
 * claim, and a typo in either constant fails here.
 */
const PAPER_HOST = 'https://paper-api.alpaca.markets';
const LIVE_HOST = 'https://api.alpaca.markets';

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

describe('buildDefaultAlpacaBrokerClient', () => {
  const savedBaseUrl = process.env.ALPACA_BASE_URL;
  const savedKey = process.env.ALPACA_API_KEY;
  const savedSecret = process.env.ALPACA_API_SECRET;

  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    delete process.env.ALPACA_BASE_URL;
  });

  afterEach(() => {
    restore('ALPACA_BASE_URL', savedBaseUrl);
    restore('ALPACA_API_KEY', savedKey);
    restore('ALPACA_API_SECRET', savedSecret);
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  it.each([
    ['paper', PAPER_HOST],
    ['backtest', PAPER_HOST],
    ['live', LIVE_HOST],
  ] as const)('derives the %s endpoint from mode, not from a default', (mode, expected) => {
    const logger = makeLogger();

    buildDefaultAlpacaBrokerClient(mode, logger);

    expect(logger.entries[0]?.payload).toMatchObject({ mode, baseUrl: expected });
  });

  it('warns loudly when it builds a live client', () => {
    const logger = makeLogger();

    buildDefaultAlpacaBrokerClient('live', logger);

    // The one signal that this process spends real money.
    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.message).toContain('real money');
  });

  it('does not warn for paper', () => {
    const logger = makeLogger();

    buildDefaultAlpacaBrokerClient('paper', logger);

    expect(logger.entries[0]?.level).toBe('info');
  });

  it.each([
    'paper',
    'backtest',
  ] as const)('refuses a live ALPACA_BASE_URL override in %s mode', (mode) => {
    process.env.ALPACA_BASE_URL = LIVE_HOST;

    // The accident #293 exists to prevent: an override silently upgrading a
    // non-live process to real money.
    expect(() => buildDefaultAlpacaBrokerClient(mode, makeLogger())).toThrow('Refusing to start');
  });

  it('allows a live override when mode is genuinely live', () => {
    process.env.ALPACA_BASE_URL = LIVE_HOST;

    expect(() => buildDefaultAlpacaBrokerClient('live', makeLogger())).not.toThrow();
  });

  it('allows a non-live override (staging/mock) from paper mode', () => {
    process.env.ALPACA_BASE_URL = 'http://localhost:9999';
    const logger = makeLogger();

    buildDefaultAlpacaBrokerClient('paper', logger);

    expect(logger.entries[0]?.payload).toMatchObject({ baseUrl: 'http://localhost:9999' });
  });
});
