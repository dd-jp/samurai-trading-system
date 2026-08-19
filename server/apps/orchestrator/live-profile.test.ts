/**
 * The live starting profile (#511).
 *
 * Every credential in here is a stub string. Nothing in this file reads a real
 * key, and nothing sets `SAMURAI_MODE`.
 */

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
import { PAPER_ACCOUNT_EQUITY_ANCHOR, paperStartingProfile } from './paper-profile.js';
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
    // Fail closed: there is no defensible default for how much money a run may
    // lose, so absence is a refusal rather than a fallback.
    expect(() => resolveLiveCapitalCeilingUsd(raw)).toThrow(LIVE_MAX_CAPITAL_ENV_VAR);
  });

  it.each([
    '0',
    '-1',
    '-0.01',
    'abc',
    'NaN',
    'Infinity',
    '2000abc',
    '',
  ])('refuses %j rather than coercing it', (raw) => {
    expect(() => resolveLiveCapitalCeilingUsd(raw)).toThrow(/cannot start/);
  });

  it("refuses '2000abc' instead of silently reading 2000 out of it", () => {
    // `parseFloat` would return 2000 here and turn a typo into an accepted
    // ceiling; `Number` refuses the whole string.
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

  it('derives every notional cap from the ceiling, not from the paper anchor', () => {
    const live = liveStartingProfile(CEILING);
    const paper = paperStartingProfile('paper');
    const ratio = CEILING / PAPER_ACCOUNT_EQUITY_ANCHOR;

    // The whole point: a $100,000 assumption may not decide a real-money size.
    expect(live.riskConfig.max_position_size).toBeCloseTo(
      paper.riskConfig.max_position_size * ratio,
      10,
    );
    expect(live.riskConfig.per_asset_cap).toBeCloseTo(paper.riskConfig.per_asset_cap * ratio, 10);
    expect(live.riskConfig.per_asset_class_cap.crypto).toBeCloseTo(
      paper.riskConfig.per_asset_class_cap.crypto * ratio,
      10,
    );
    expect(live.riskConfig.per_asset_class_cap.stocks).toBeCloseTo(
      paper.riskConfig.per_asset_class_cap.stocks * ratio,
      10,
    );
    expect(live.riskConfig.portfolio_gross_cap).toBeCloseTo(
      paper.riskConfig.portfolio_gross_cap * ratio,
      10,
    );
    expect(live.riskConfig.concentration.cap).toBeCloseTo(
      paper.riskConfig.concentration.cap * ratio,
      10,
    );
  });

  it('keeps gross exposure inside the declared ceiling', () => {
    // Gross above the ceiling is the run exceeding what was declared, which is
    // the failure the ceiling exists to prevent.
    expect(liveStartingProfile(CEILING).riskConfig.portfolio_gross_cap).toBeLessThanOrEqual(
      CEILING,
    );
  });

  it('keeps the cap ladder monotonic at the live anchor too, so no cap is unreachable', () => {
    const { riskConfig } = liveStartingProfile(CEILING);

    expect(riskConfig.max_position_size).toBeLessThanOrEqual(riskConfig.per_asset_cap);
    expect(riskConfig.per_asset_cap).toBeLessThanOrEqual(riskConfig.per_asset_class_cap.crypto);
    expect(riskConfig.per_asset_cap).toBeLessThanOrEqual(riskConfig.per_asset_class_cap.stocks);
    expect(riskConfig.per_asset_class_cap.crypto).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap,
    );
    expect(riskConfig.per_asset_class_cap.stocks).toBeLessThanOrEqual(
      riskConfig.portfolio_gross_cap,
    );
  });

  it('keeps the per-trade cap above the dust floor at the smallest allowed ceiling', () => {
    // The bound `minLiveCapitalCeilingUsd` exists to guarantee. Below it the
    // run boots, spends LLM budget and never places an order.
    const { riskConfig, traderConfig } = liveStartingProfile(minLiveCapitalCeilingUsd());

    expect(riskConfig.max_position_size).toBeGreaterThanOrEqual(traderConfig.min_viable_notional);
    expect(riskConfig.min_viable_size).toBeLessThanOrEqual(traderConfig.min_viable_notional);
  });

  it("re-anchors the Feedback Loop's guardrail band with the caps, so no dial bounds a cap that does not exist", () => {
    const { feedback, riskConfig } = liveStartingProfile(CEILING);
    const dial = feedback?.config.risk_thresholds?.max_position_size;

    // #433's invariant: the dial's ceiling IS the shipped cap. Left anchored to
    // the paper balance, a live run's dial would permit 50x the cap it bounds.
    expect(dial?.ceiling).toBe(riskConfig.max_position_size);
    expect(dial?.floor).toBeLessThan(riskConfig.max_position_size);
  });

  it('inherits the untuned dials verbatim — the retune is #238’s, not this ticket’s', () => {
    const live = liveStartingProfile(CEILING);
    const paper = paperStartingProfile('paper');

    // Stated as a test rather than only in a comment: if a later change starts
    // diverging these, it should be a decision someone made on purpose.
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

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('refuses an injected ceiling of %j rather than trusting a programmatic caller', (ceiling) => {
    expect(() => liveStartingProfile(ceiling)).toThrow(/cannot start/);
  });

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

describe('LIVE_MONEY_GATES', () => {
  it('gives every cited issue a claim, so no bare number can accumulate', () => {
    // A number with no claim attached is unverifiable by the next reader, which
    // is exactly how the #384/#375/#333 citation went stale unnoticed.
    for (const gate of LIVE_MONEY_GATES) {
      expect(Number.isInteger(gate.issue)).toBe(true);
      expect(gate.gap.trim().length).toBeGreaterThan(20);
    }
  });

  it('leads with the reason that does not depend on a bug number', () => {
    // The numbered list goes stale as issues close; this sentence does not,
    // until the soak actually runs.
    expect(LIVE_MONEY_GATE_SUMMARY).toContain('#238');
    expect(LIVE_MONEY_GATE_SUMMARY).toContain('has not run');
    expect(LIVE_MONEY_GATE_SUMMARY).toMatch(/as of 2026-\d\d-\d\d/i);
  });

  it('cites no issue that was closed when this list was verified', () => {
    // #868: the first seven are the list as it shipped from #566. Every one of
    // them was closed by 2026-08-18 while still being rendered to an operator
    // booting live money, so they are pinned here permanently — a revert of the
    // list, or a copy-paste of the old one, fails on this line rather than on
    // the next operator's read.
    const closed = [526, 519, 548, 549, 550, 551, 562, 384, 375, 333, 525];

    for (const gate of LIVE_MONEY_GATES) {
      expect(closed).not.toContain(gate.issue);
    }
    for (const issue of closed) {
      expect(LIVE_MONEY_GATE_SUMMARY).not.toContain(`#${issue}`);
    }
  });

  it('cites the gates that are open today, by number (#868)', () => {
    // Pinned as literals rather than derived from LIVE_MONEY_GATES: a test that
    // renders the constant and asserts it contains the constant passes for any
    // list, which is why the seven ghosts survived a suite of ~2900 tests.
    expect(LIVE_MONEY_GATES.map((gate) => gate.issue)).toEqual([665, 888, 886, 798, 826]);
  });

  it('hands the reader a command instead of only telling them to re-check', () => {
    // The decay #868 records was not that the list went stale — lists do — but
    // that a reader told to "re-check their state" had seven issues to check by
    // hand and no way to do it, so nobody did. The summary names the one
    // command that settles it, and dates its own claim.
    expect(LIVE_MONEY_GATE_SUMMARY).toContain(LIVE_MONEY_GATES_RECHECK_COMMAND);
    expect(LIVE_MONEY_GATE_SUMMARY).toContain(LIVE_MONEY_GATES_VERIFIED_ON);
    expect(LIVE_MONEY_GATE_SUMMARY).toContain('not a live');
  });
});

describe('the live-boot warning as an operator actually receives it', () => {
  /**
   * Reached through `startingProfileForMode`, the seam `orchestrator/index.ts`
   * takes on `mode === 'live'` — not `liveStartingProfile` directly. The gate
   * list being correct is worth nothing if the branch that renders it is not
   * the branch a live boot takes.
   */
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

    for (const issue of [665, 888, 886, 798, 826]) {
      expect(message).toContain(`#${issue}`);
    }
    expect(message).toContain('#238');
  });

  it('names no gate that has closed, at the boot path', () => {
    const message = liveBootWarning();

    for (const issue of [526, 519, 548, 549, 550, 551, 562, 800]) {
      expect(message).not.toContain(`#${issue}`);
    }
  });

  it('tells the operator how to re-verify the list they are being shown', () => {
    expect(liveBootWarning()).toContain(LIVE_MONEY_GATES_RECHECK_COMMAND);
  });
});
