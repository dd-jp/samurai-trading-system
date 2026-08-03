/**
 * Entrypoint tests (#236). The value here is the fail-fast contract: an
 * operator running `npm run orchestrator` against a half-wired environment
 * must get a message naming what is missing, before anything touches a
 * broker — not a process that starts and trades on invented defaults.
 *
 * Importing this module must also be side-effect free (it is the package's
 * export surface as well as the entrypoint); every test below relies on that
 * implicitly, since a top-level start would hang the suite.
 */
import { buildShutdownHandler, REQUIRED_INJECTED_CONFIG, startFromEnvironment } from './index.js';

describe('startFromEnvironment', () => {
  it('refuses to start with nothing wired, naming every missing dependency', async () => {
    await expect(startFromEnvironment()).rejects.toThrow(/cannot start/i);

    const error = await startFromEnvironment().catch((e: unknown) => e as Error);
    for (const key of REQUIRED_INJECTED_CONFIG) {
      expect(error.message).toContain(key);
    }
  });

  it('names only the dependencies that are actually missing', async () => {
    const error = await startFromEnvironment({
      llmClient: {} as never,
      traderConfig: {} as never,
    }).catch((e: unknown) => e as Error);

    expect(error.message).not.toMatch(/\bllmClient\b/);
    expect(error.message).not.toMatch(/\btraderConfig\b/);
    expect(error.message).toContain('heartbeatChannel');
  });

  it('rejects an unrecognised SAMURAI_MODE rather than casting it through', async () => {
    // `backtest` auto-approves every HITL gate and `live` spends real money,
    // so a typo must not reach VerdictImpl/ExecutionImpl as an opaque string.
    const previous = process.env.SAMURAI_MODE;
    process.env.SAMURAI_MODE = 'papper';
    try {
      const wired = Object.fromEntries(REQUIRED_INJECTED_CONFIG.map((key) => [key, {}])) as Record<
        string,
        unknown
      >;
      await expect(startFromEnvironment(wired as never)).rejects.toThrow(/SAMURAI_MODE/);
    } finally {
      if (previous === undefined) delete process.env.SAMURAI_MODE;
      else process.env.SAMURAI_MODE = previous;
    }
  });

  it('lists every transport and stage config as a required injection', () => {
    // Guards against a future field being added to ProductionConfig as a
    // silently-optional dependency: these are the seams with no in-repo
    // implementation, and the list is the contract.
    expect(REQUIRED_INJECTED_CONFIG).toContain('heartbeatChannel');
    expect(REQUIRED_INJECTED_CONFIG).toContain('orphanAlerts');
    expect(REQUIRED_INJECTED_CONFIG).toContain('ciiScoreProvider');
    expect(new Set(REQUIRED_INJECTED_CONFIG).size).toBe(REQUIRED_INJECTED_CONFIG.length);

    // The other half of the contract: a seam that HAS an in-repo
    // implementation must not stay on this list, or the entrypoint keeps
    // demanding something the composition root can build for itself. These
    // three left the list when #273/#286 (Alpaca HTTP clients) and #276
    // (AccountStateProvider) landed.
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('alpacaBrokerClient');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('alpacaDataClient');
    expect(REQUIRED_INJECTED_CONFIG).not.toContain('accountState');
  });
});

describe('buildShutdownHandler', () => {
  /** Records the effects the handler would have had on the real process. */
  function spyEffects() {
    const exits: number[] = [];
    const errors: string[] = [];
    return {
      exits,
      errors,
      effects: {
        exit: (code: number) => {
          exits.push(code);
        },
        stderr: (message: string) => {
          errors.push(message);
        },
      },
    };
  }

  it('exits 0 only after the drain resolves, never before', async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { exits, effects } = spyEffects();

    buildShutdownHandler({ stop: () => drained }, effects)();
    await Promise.resolve();

    // Still draining: exiting here is the mid-pass exit #209 exists to detect.
    expect(exits).toEqual([]);

    release();
    await drained;
    await Promise.resolve();
    expect(exits).toEqual([0]);
  });

  it('still exits — with a non-zero code — when the drain rejects', async () => {
    const { exits, errors, effects } = spyEffects();

    buildShutdownHandler({ stop: () => Promise.reject(new Error('tick blew up')) }, effects)();
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([1]);
    expect(errors.join('')).toMatch(/tick blew up/);
  });

  it('reports the failed drain by message only, never the thrown object', async () => {
    // The startup catch has the same posture: a config-bearing error must not
    // reach stderr, because the config holds API credentials.
    const secretive = Object.assign(new Error('drain failed'), { apiKey: 'sk-live-must-not-leak' });
    const { errors, effects } = spyEffects();

    buildShutdownHandler({ stop: () => Promise.reject(secretive) }, effects)();
    await Promise.resolve();
    await Promise.resolve();

    // Both halves matter: the message must be reported, and only the message.
    expect(errors.join('')).toMatch(/drain failed/);
    expect(errors.join('')).not.toMatch(/sk-live-must-not-leak/);
  });

  it('ignores a second signal rather than exiting through the first drain', async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopCalls = 0;
    const { exits, effects } = spyEffects();
    const shutdown = buildShutdownHandler(
      {
        stop: () => {
          stopCalls++;
          // A re-entrant stop() finds its timers cleared and its loop already
          // released, so it resolves at once — which is exactly how a second
          // Ctrl-C would exit 0 straight through the first, still-running drain.
          return stopCalls === 1 ? drained : Promise.resolve();
        },
      },
      effects,
    );

    shutdown();
    shutdown();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toBe(1);
    expect(exits).toEqual([]);

    release();
    await drained;
    await Promise.resolve();
    expect(exits).toEqual([0]);
  });
});
