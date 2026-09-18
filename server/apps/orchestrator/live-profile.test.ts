
import { DEFAULT_TRADER_CONFIG } from '../../pipeline/trader/index.js';
import { startingProfileForMode } from './index.js';
import {
  LIVE_MONEY_GATE_SUMMARY,
  LIVE_MONEY_GATES,
  LIVE_MONEY_GATES_RECHECK_COMMAND,
  LIVE_MONEY_GATES_VERIFIED_ON,
} from './live-money-gates.js';
import {
  LIVE_MAX_CAPITAL_ENV_VAR,
  liveStartingProfile,
  minLiveCapitalCeilingUsd,
  resolveLiveCapitalCeilingUsd,
} from './live-profile.js';
import {
  LIVE_BOOK_GBP,
  LIVE_BOOK_SIZING_USD,
  paperStartingProfile,
  RISK_CAP_EQUITY_FRACTIONS,
} from './paper-profile.js';
import type { LogEntry, Logger } from './types.js';

const CEILING = 2_000;

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

describe('resolveLiveCapitalCeilingUsd', () => {
  it('accepts a positive finite figure', () => {
    expect(resolveLiveCapitalCeilingUsd('2000')).toBe(2000);
    expect(resolveLiveCapitalCeilingUsd(' 2500.50 ')).toBe(2500.5);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses a %s ceiling by name, with no default to fall back to', (_label, raw) => {
    expect(() => resolveLiveCapitalCeilingUsd(raw)).toThrow(LIVE_MAX_CAPITAL_ENV_VAR);
  });

  it.each(['0', '-1', '-0.01', 'abc', 'NaN', 'Infinity', '2000abc', ''])(
    'refuses %j rather than coercing it',
    (raw) => {
      expect(() => resolveLiveCapitalCeilingUsd(raw)).toThrow(/cannot start/);
    },
  );

  it("refuses '2000abc' instead of silently reading 2000 out of it", () => {
    expect(() => resolveLiveCapitalCeilingUsd('2000abc')).toThrow(/positive, finite number/);
  });

  it('refuses a ceiling too small to place a trade rather than booting a run that never trades', () => {
    const floor = minLiveCapitalCeilingUsd();

    expect(floor).toBeGreaterThan(0);
    expect(() => resolveLiveCapitalCeilingUsd(String(floor - 1))).toThrow(/never trade/);
    expect(resolveLiveCapitalCeilingUsd(String(floor))).toBe(floor);
  });

  it('reads the environment variable when no argument is given', () => {
    const saved = process.env[LIVE_MAX_CAPITAL_ENV_VAR];
    try {
      process.env[LIVE_MAX_CAPITAL_ENV_VAR] = '1234';
      expect(resolveLiveCapitalCeilingUsd()).toBe(1234);
    } finally {
      if (saved === undefined) delete process.env[LIVE_MAX_CAPITAL_ENV_VAR];
      else process.env[LIVE_MAX_CAPITAL_ENV_VAR] = saved;
    }
  });
});

describe('liveStartingProfile', () => {
  it('is live, and carries the ceiling it was built against', () => {
    const profile = liveStartingProfile(CEILING);

    expect(profile.mode).toBe('live');
    expect(profile.capitalCeilingUsd).toBe(CEILING);
  });

  it("shares the paper profile's equity-relative caps verbatim, except the account-level book ceiling — the CEILING ARGUMENT no longer touches riskConfig (#886)", () => {
    const live = liveStartingProfile(CEILING);
    const paper = paperStartingProfile('paper');

    expect(live.riskConfig).toEqual({
      ...paper.riskConfig,
      live_book_ceiling: { book: LIVE_BOOK_GBP, refuse_above_tolerance: expect.any(Number) },
    });
    expect(paper.riskConfig.live_book_ceiling).toBeUndefined();
  });

  it('produces the identical riskConfig regardless of which ceiling it is built with', () => {
    const small = liveStartingProfile(CEILING);
    const large = liveStartingProfile(CEILING * 1_000);

    expect(small.riskConfig).toEqual(large.riskConfig);
    expect(small.capitalCeilingUsd).not.toBe(large.capitalCeilingUsd);
  });

  it('keeps every cap at or under 1x equity — no leverage, independent of the ceiling (#886)', () => {
    expect(
      liveStartingProfile(CEILING).riskConfig.portfolio_gross_cap_fraction_of_equity,
    ).toBeLessThanOrEqual(1);
  });

  it('keeps the cap ladder monotonic, so no cap is unreachable', () => {
    const { riskConfig } = liveStartingProfile(CEILING);

    expect(riskConfig.max_position_size_fraction_of_equity).toBeLessThanOrEqual(
      riskConfig.per_asset_cap_fraction_of_equity,
    );
    expect(riskConfig.per_asset_cap_fraction_of_equity).toBeLessThanOrEqual(
      riskConfig.per_asset_class_cap_fraction_of_equity.crypto,
    );
    expect(riskConfig.per_asset_cap_fraction_of_equity).toBeLessThanOrEqual(
      riskConfig.per_asset_class_cap_fraction_of_equity.stocks,
    );
    expect(riskConfig.per_asset_class_cap_fraction_of_equity.crypto).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap_fraction_of_equity,
    );
    expect(riskConfig.per_asset_class_cap_fraction_of_equity.stocks).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap_fraction_of_equity,
    );
  });

  it('derives the ceiling floor from the fraction and the dust floor, not a magic number', () => {
    const floor = minLiveCapitalCeilingUsd();

    expect(floor).toBeCloseTo(
      DEFAULT_TRADER_CONFIG.min_viable_notional /
        RISK_CAP_EQUITY_FRACTIONS.max_position_size_fraction_of_equity,
      10,
    );
  });

  it("re-anchors the Feedback Loop's guardrail band with the caps, so no dial bounds a cap that does not exist", () => {
    const { feedback, riskConfig } = liveStartingProfile(CEILING);
    const dial = feedback?.config.risk_thresholds?.max_position_size_fraction_of_equity;

    expect(dial?.ceiling).toBe(riskConfig.max_position_size_fraction_of_equity);
    expect(dial?.floor).toBeLessThan(riskConfig.max_position_size_fraction_of_equity);
  });

  it('inherits the untuned dials verbatim — the retune is #238’s, not this ticket’s', () => {
    const live = liveStartingProfile(CEILING);
    const paper = paperStartingProfile('paper');

    expect(live.breakerConfig).toEqual(paper.breakerConfig);
    expect(live.verdictConfig).toEqual(paper.verdictConfig);
    expect(live.tickIntervalMs).toBe(paper.tickIntervalMs);
    expect(live.llmBudgetUsd).toBe(paper.llmBudgetUsd);
    expect(live.universe).toEqual(paper.universe);
  });

  it('returns a fresh copy per call, so one run cannot mutate another', () => {
    const first = liveStartingProfile(CEILING);
    const second = liveStartingProfile(CEILING);

    expect(first.riskConfig).not.toBe(second.riskConfig);
    expect(first.riskConfig).toEqual(second.riskConfig);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an injected ceiling of %j rather than trusting a programmatic caller',
    (ceiling) => {
      expect(() => liveStartingProfile(ceiling)).toThrow(/cannot start/);
    },
  );

  it('warns, naming the live-money gates and the ceiling, before anything is constructed', () => {
    const logger = makeLogger();

    liveStartingProfile(CEILING, logger);

    const entry = logger.entries[0];
    expect(entry?.level).toBe('warn');
    expect(entry?.message).toContain('real money');
    expect(entry?.message).toContain(LIVE_MONEY_GATE_SUMMARY);
    expect(entry?.payload).toMatchObject({ capital_ceiling_usd: CEILING });
  });

  it('does not require a logger', () => {
    expect(() => liveStartingProfile(CEILING)).not.toThrow();
  });
});

describe('liveStartingProfile — unconverted-book plausibility warning (#1441)', () => {

  it('warns when the declared ceiling is the GBP book’s bare number, unconverted', () => {
    const logger = makeLogger();

    liveStartingProfile(LIVE_BOOK_GBP, logger);

    const entry = logger.entries.find((e) => e.event === 'live_capital_ceiling_looks_unconverted');
    expect(entry?.level).toBe('warn');
    expect(entry?.message).toContain(String(LIVE_BOOK_GBP));
    expect(entry?.message).toContain(LIVE_MAX_CAPITAL_ENV_VAR);
    expect(entry?.message).toContain('1441');
  });

  it('stays silent for the correctly converted book figure (1,270)', () => {
    const logger = makeLogger();

    liveStartingProfile(LIVE_BOOK_SIZING_USD, logger);

    expect(
      logger.entries.find((e) => e.event === 'live_capital_ceiling_looks_unconverted'),
    ).toBeUndefined();
  });

  it('stays silent for a ceiling clearly unrelated to the book', () => {
    const logger = makeLogger();

    liveStartingProfile(CEILING, logger);

    expect(
      logger.entries.find((e) => e.event === 'live_capital_ceiling_looks_unconverted'),
    ).toBeUndefined();
  });

  it('does not throw when no logger is supplied, even on the unconverted figure', () => {
    expect(() => liveStartingProfile(LIVE_BOOK_GBP)).not.toThrow();
  });
});

describe('LIVE_MONEY_GATES', () => {
  it('gives every cited issue a claim, so no bare number can accumulate', () => {
    for (const gate of LIVE_MONEY_GATES) {
      expect(Number.isInteger(gate.issue)).toBe(true);
      expect(gate.gap.trim().length).toBeGreaterThan(20);
    }
  });

  it('leads with the reason that does not depend on a bug number', () => {
    expect(LIVE_MONEY_GATE_SUMMARY).toContain('#238');
    expect(LIVE_MONEY_GATE_SUMMARY).toContain('has not run');
    expect(LIVE_MONEY_GATE_SUMMARY).toMatch(/as of 2026-\d\d-\d\d/i);
  });

  it('cites no issue that was closed when this list was verified', () => {
    const closed = [
      526, 519, 548, 549, 550, 551, 562, 384, 375, 333, 525, 798, 800, 826, 894, 886, 888, 925, 932,
    ];

    for (const gate of LIVE_MONEY_GATES) {
      expect(closed).not.toContain(gate.issue);
    }
    for (const issue of closed) {
      expect(LIVE_MONEY_GATE_SUMMARY).not.toContain(`#${issue}`);
    }
  });

  it('cites the gates that are open today, by number (#868)', () => {
    expect(LIVE_MONEY_GATES.map((gate) => gate.issue)).toEqual([895, 900]);
  });

  it('hands the reader a command instead of only telling them to re-check', () => {
    expect(LIVE_MONEY_GATE_SUMMARY).toContain(LIVE_MONEY_GATES_RECHECK_COMMAND);
    expect(LIVE_MONEY_GATE_SUMMARY).toContain(LIVE_MONEY_GATES_VERIFIED_ON);
    expect(LIVE_MONEY_GATE_SUMMARY).toContain('not a live');
  });
});

describe('the live-boot warning as an operator actually receives it', () => {
  function liveBootWarning(): string {
    const logger = makeLogger();
    vi.stubEnv(LIVE_MAX_CAPITAL_ENV_VAR, String(CEILING));
    try {
      startingProfileForMode('live', logger);
    } finally {
      vi.unstubAllEnvs();
    }
    const warn = logger.entries.find((entry) => entry.level === 'warn');
    if (warn === undefined)
      throw new Error('a live boot must emit a warn before anything is built');
    return warn.message;
  }

  it('names every gate that is open, at the boot path', () => {
    const message = liveBootWarning();

    for (const issue of [895, 900]) {
      expect(message).toContain(`#${issue}`);
    }
    expect(message).toContain('#238');
  });

  it('names no gate that has closed, at the boot path', () => {
    const message = liveBootWarning();

    for (const issue of [
      526, 519, 548, 549, 550, 551, 562, 798, 800, 826, 894, 886, 888, 925, 932,
    ]) {
      expect(message).not.toContain(`#${issue}`);
    }
  });

  it('tells the operator how to re-verify the list they are being shown', () => {
    expect(liveBootWarning()).toContain(LIVE_MONEY_GATES_RECHECK_COMMAND);
  });

  it('also warns on the unconverted-book figure at the real boot path (#1441)', () => {
    const logger = makeLogger();
    vi.stubEnv(LIVE_MAX_CAPITAL_ENV_VAR, String(LIVE_BOOK_GBP));
    try {
      startingProfileForMode('live', logger);
    } finally {
      vi.unstubAllEnvs();
    }

    const entry = logger.entries.find((e) => e.event === 'live_capital_ceiling_looks_unconverted');
    expect(entry?.level).toBe('warn');
    expect(entry?.message).toContain(String(LIVE_BOOK_SIZING_USD));
  });
});
