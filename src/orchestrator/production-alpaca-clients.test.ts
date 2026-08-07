/**
 * The mode-derived Alpaca endpoint guard (#293). These tests are the only
 * thing standing between a `paper` process and real money if someone points
 * `ALPACA_BASE_URL` at the live host.
 */
import { buildDefaultAlpacaBrokerClient } from './production.js';
import type { LogEntry, Logger } from './types.js';

/**
 * Spelled out rather than imported. The hosts now live in the execution
 * module's client (#293) and are not exported at all — but that is not the
 * only reason: asserting a value against the constant that produced it proves
 * the code is self-consistent, not that `paper` reaches the paper host. These
 * literals are the actual claim, and a typo in either constant fails here.
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
  const savedLiveKey = process.env.ALPACA_LIVE_API_KEY;
  const savedLiveSecret = process.env.ALPACA_LIVE_API_SECRET;

  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_API_SECRET = 'test-secret';
    // #511: live mode reads its own pair. Stubs, never real credentials.
    process.env.ALPACA_LIVE_API_KEY = 'test-live-key';
    process.env.ALPACA_LIVE_API_SECRET = 'test-live-secret';
    delete process.env.ALPACA_BASE_URL;
  });

  afterEach(() => {
    restore('ALPACA_BASE_URL', savedBaseUrl);
    restore('ALPACA_API_KEY', savedKey);
    restore('ALPACA_API_SECRET', savedSecret);
    restore('ALPACA_LIVE_API_KEY', savedLiveKey);
    restore('ALPACA_LIVE_API_SECRET', savedLiveSecret);
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

  /**
   * A string-prefix comparison is case- and whitespace-sensitive; DNS is
   * neither. Each of these is the live trading host, and each one bypassed the
   * original `startsWith` check (#293 follow-up).
   */
  it.each([
    'https://API.ALPACA.MARKETS',
    'https://Api.Alpaca.Markets/',
    ' https://api.alpaca.markets',
    'https://api.alpaca.markets:443',
  ])('refuses the live host spelled as %s in paper mode', (override) => {
    process.env.ALPACA_BASE_URL = override;

    expect(() => buildDefaultAlpacaBrokerClient('paper', makeLogger())).toThrow(
      /Refusing to start/,
    );
  });

  // The reverse mismatch: an operator who set live mode but is silently
  // filling paper orders is running on a false picture of their own risk.
  //
  // `AlpacaHttpBrokerClient.resolveBaseUrl` has always refused this pairing, so
  // the DIRECTION is not new in #511. What is new is who says so: the
  // composition root now names the two things that actually disagree —
  // `ALPACA_BASE_URL` and `SAMURAI_MODE` — which the client cannot, because by
  // the time it sees the override it is an argument with no provenance. The
  // client's guard stays behind it as the backstop.
  it('refuses a paper-host override when mode is live', () => {
    process.env.ALPACA_BASE_URL = PAPER_HOST;

    expect(() => buildDefaultAlpacaBrokerClient('live', makeLogger())).toThrow(
      /ALPACA_BASE_URL.*PAPER.*SAMURAI_MODE/s,
    );
  });

  it.each([
    'https://PAPER-API.ALPACA.MARKETS',
    ' https://paper-api.alpaca.markets',
    'https://paper-api.alpaca.markets:443',
  ])('refuses the paper host spelled as %s in live mode', (override) => {
    // Same classifier as the paper-mode direction above, so the same spellings
    // that bypass a `startsWith` comparison are covered on both sides.
    process.env.ALPACA_BASE_URL = override;

    expect(() => buildDefaultAlpacaBrokerClient('live', makeLogger())).toThrow(/Refusing to start/);
  });

  describe('live credentials (#511)', () => {
    it.each([
      'ALPACA_LIVE_API_KEY',
      'ALPACA_LIVE_API_SECRET',
    ])('refuses to build a live client when %s is absent, rather than using the paper pair', (name) => {
      delete process.env[name];

      // The paper pair is still set, so a fallback would silently succeed and
      // authenticate the wrong account — which is the failure this refuses.
      expect(() => buildDefaultAlpacaBrokerClient('live', makeLogger())).toThrow(name);
    });

    it.each([
      '',
      '   ',
    ])('treats a live key set to %j as absent, matching the credential pre-flight', (value) => {
      process.env.ALPACA_LIVE_API_KEY = value;

      expect(() => buildDefaultAlpacaBrokerClient('live', makeLogger())).toThrow(
        'ALPACA_LIVE_API_KEY',
      );
    });

    it('never puts a credential value in the refusal', () => {
      process.env.ALPACA_LIVE_API_SECRET = '';
      process.env.ALPACA_API_KEY = 'paper-key-value';
      process.env.ALPACA_API_SECRET = 'paper-secret-value';

      try {
        buildDefaultAlpacaBrokerClient('live', makeLogger());
        expect.unreachable('expected a refusal');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('paper-key-value');
        expect(message).not.toContain('paper-secret-value');
        expect(message).not.toContain('test-live-key');
      }
    });

    it.each([
      'paper',
      'backtest',
    ] as const)('never reads the live pair in %s mode, so a malformed live key cannot break the boot', (mode) => {
      delete process.env.ALPACA_LIVE_API_KEY;
      delete process.env.ALPACA_LIVE_API_SECRET;

      expect(() => buildDefaultAlpacaBrokerClient(mode, makeLogger())).not.toThrow();
    });

    it('does not log a credential when it builds the live client', () => {
      const logger = makeLogger();

      buildDefaultAlpacaBrokerClient('live', logger);

      expect(JSON.stringify(logger.entries)).not.toContain('test-live-key');
      expect(JSON.stringify(logger.entries)).not.toContain('test-live-secret');
    });
  });

  it('refuses an empty ALPACA_BASE_URL rather than falling back to a default', () => {
    process.env.ALPACA_BASE_URL = '';

    expect(() => buildDefaultAlpacaBrokerClient('paper', makeLogger())).toThrow(/baseUrl/);
  });

  // The log line is the operator's only readout of which host is in play, so
  // it must not be emitted by a build that then throws.
  it('does not log a host it failed to build a client for', () => {
    process.env.ALPACA_BASE_URL = PAPER_HOST;
    const logger = makeLogger();

    expect(() => buildDefaultAlpacaBrokerClient('live', logger)).toThrow();
    expect(logger.entries).toHaveLength(0);
  });

  it('allows a non-live override (staging/mock) from paper mode', () => {
    process.env.ALPACA_BASE_URL = 'http://localhost:9999';
    const logger = makeLogger();

    buildDefaultAlpacaBrokerClient('paper', logger);

    expect(logger.entries[0]?.payload).toMatchObject({ baseUrl: 'http://localhost:9999' });
  });
});
