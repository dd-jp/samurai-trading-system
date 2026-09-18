import { buildArmComparison, noCostBasisDrops } from '../pipeline/control-arm/index.js';
import type { ClosedTrade, TradingArm } from '../shared/index.js';
import {
  DEFAULT_WINDOW_DAYS,
  formatArmComparison,
  parseWindowDays,
} from './report-arm-comparison.js';

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-30T00:00:00.000Z');

function trade(arm: TradingArm, pnl: number, closedAt: string): ClosedTrade & { arm: TradingArm } {
  return {
    arm,
    idempotency_key: `${arm}-${closedAt}`,
    debate_id: arm === 'control' ? 'control:abc' : 'debate-abc',
    instrument: '3LUS',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 98,
    filled_size: 3,
    realized_pnl_net: pnl,
    fees_total: 0,
    opened_at: FROM,
    closed_at: new Date(closedAt),
    close_reason: 'target',
    modelled_cost_charged: true,
  };
}

function report(): string {
  return formatArmComparison(
    buildArmComparison({
      basis: 1_000,
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      from: FROM,
      to: TO,
      trades: [
        trade('live', 40, '2026-09-02T00:00:00.000Z'),
        trade('live', -10, '2026-09-03T00:00:00.000Z'),
        trade('control', -30, '2026-09-02T12:00:00.000Z'),
        trade('control', 90, '2026-09-04T00:00:00.000Z'),
      ],
    }),
  );
}

describe('formatArmComparison (#753 AC4/AC5)', () => {
  it('prints return AND drawdown for BOTH arms', () => {
    const text = report();

    expect(text).toMatch(/live\s+2\s+30\.00\s+3\.00%\s+1\.00%/);
    expect(text).toMatch(/control\s+2\s+60\.00\s+6\.00%\s+3\.00%/);
  });

  it('emits no line carrying a return without a drawdown beside it', () => {
    const percentages = report()
      .split('\n')
      .map((line) => line.match(/-?\d+\.\d\d%/g) ?? [])
      .filter((matches) => matches.length > 0);

    expect(percentages).toHaveLength(2);
    for (const matches of percentages) {
      expect(matches).toHaveLength(2);
    }
  });

  it('names the shared window and the shared denominator — AC4 is one tape, one basis', () => {
    const text = report();

    expect(text).toContain(FROM.toISOString());
    expect(text).toContain(TO.toISOString());
    expect(text).toContain('basis:  $1000.00 (the same denominator for both arms)');
  });

  it('warns rather than reporting a clean zero when the control closed nothing', () => {
    const text = formatArmComparison(
      buildArmComparison({
        basis: 1_000,
        refused_passes: { live: 0, control: 0 },
        cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
        from: FROM,
        to: TO,
        trades: [trade('live', 40, '2026-09-02T00:00:00.000Z')],
      }),
    );

    expect(text).toContain('the control arm actually ran');
    expect(text).toMatch(/control\s+0\s+0\.00\s+0\.00%\s+0\.00%/);
  });

  it('warns that a zero live count may be the #1121 exclusion, not an idle arm', () => {
    const text = formatArmComparison(
      buildArmComparison({
        basis: 1_000,
        refused_passes: { live: 0, control: 0 },
        cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
        from: FROM,
        to: TO,
        trades: [trade('control', 40, '2026-09-02T00:00:00.000Z')],
      }),
    );

    expect(text).toContain('modelled_cost_charged = 0');
    const flattened = text.replace(/\s+/g, ' ');
    expect(flattened).toContain(
      'every live row closed before #1121 shipped was backfilled to 0, ' +
        'and a row closed since then stamps 0 whenever a covered leg is missing ' +
        'its submit-time cost snapshot (that capture is best-effort)',
    );
    expect(flattened).toContain(
      'a window over pre-#1121 history is EXPECTED to read 0 here — but so can a ' +
        'window of purely recent closes',
    );
    expect(text).toMatch(/live\s+0\s+0\.00\s+0\.00%\s+0\.00%/);
  });

  it('says nothing about the exclusion when the live arm has trades', () => {
    expect(report()).not.toContain('modelled_cost_charged = 0');
  });

  it('prints the refused-pass count per arm', () => {
    const text = formatArmComparison(
      buildArmComparison({
        basis: 1_000,
        refused_passes: { live: 0, control: 6 },
        cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
        from: FROM,
        to: TO,
        trades: [trade('live', 40, '2026-09-02T00:00:00.000Z')],
      }),
    );

    expect(text).toContain('refused passes');
    expect(text).toMatch(/control\s+0\s+0\.00\s+0\.00%\s+0\.00%\s+6/);
    expect(text).toMatch(/live\s+1\s+40\.00\s+4\.00%\s+0\.00%\s+0/);
    expect(text).toContain('REFUSED rather than declined — control: 6 pass(es)');
  });

  it('attributes refused passes to each arm rather than printing a merged total', () => {
    const text = formatArmComparison(
      buildArmComparison({
        basis: 1_000,
        refused_passes: { live: 2, control: 5 },
        cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
        from: FROM,
        to: TO,
        trades: [trade('live', 40, '2026-09-02T00:00:00.000Z')],
      }),
    );

    expect(text).toContain('REFUSED rather than declined — live: 2 pass(es), control: 5 pass(es)');
    expect(text).not.toContain('7 pass(es)');
    expect(text).toMatch(/live\s+1\s+40\.00\s+4\.00%\s+0\.00%\s+2/);
    expect(text).toMatch(/control\s+0\s+0\.00\s+0\.00%\s+0\.00%\s+5/);
  });

  it('reads a zero control count as a refusal, not as an unbound control arm, when refusals exist', () => {
    const text = formatArmComparison(
      buildArmComparison({
        basis: 1_000,
        refused_passes: { live: 0, control: 4 },
        cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
        from: FROM,
        to: TO,
        trades: [trade('live', 40, '2026-09-02T00:00:00.000Z')],
      }),
    );

    expect(text).toContain('It DID run');
    expect(text).not.toContain('the control arm actually ran');
  });

  it('says nothing about refusals when there were none', () => {
    const text = report();

    expect(text).not.toContain('REFUSED rather than declined');
    expect(text).toMatch(/live\s+2\s+30\.00\s+3\.00%\s+1\.00%\s+0/);
  });
});

describe('formatArmComparison — the cost-basis exclusion by exit class (#1546)', () => {
  function reportWith(
    live: Parameters<typeof buildArmComparison>[0]['cost_basis_drops']['live'],
    control: Parameters<typeof buildArmComparison>[0]['cost_basis_drops']['control'],
  ): string {
    return formatArmComparison(
      buildArmComparison({
        basis: 1_000,
        refused_passes: { live: 0, control: 0 },
        cost_basis_drops: { live, control },
        from: FROM,
        to: TO,
        trades: [trade('live', 40, '2026-09-02T00:00:00.000Z')],
      }),
    );
  }

  it('prints each arm each class with its own kept, dropped and drop rate', () => {
    const text = reportWith(
      { protective: { kept: 15, dropped: 5 }, flatten: { kept: 6, dropped: 4 } },
      { protective: { kept: 8, dropped: 0 }, flatten: { kept: 2, dropped: 0 } },
    );

    expect(text).toMatch(/live\s+protective\s+15\s+5\s+25\.00%/);
    expect(text).toMatch(/live\s+flatten\s+6\s+4\s+40\.00%/);
    expect(text).toMatch(/control\s+protective\s+8\s+0\s+0\.00%/);
    expect(text).toMatch(/control\s+flatten\s+2\s+0\s+0\.00%/);
  });

  it('never collapses the two classes into one per-arm rate', () => {
    const text = reportWith(
      { protective: { kept: 15, dropped: 5 }, flatten: { kept: 6, dropped: 4 } },
      noCostBasisDrops(),
    );

    expect(text).not.toContain('30.00%');
  });

  it('prints n/a, not a zero rate, for a class with nothing closed in the window', () => {
    const text = reportWith(
      { protective: { kept: 4, dropped: 1 }, flatten: { kept: 0, dropped: 0 } },
      noCostBasisDrops(),
    );

    expect(text).toMatch(/live\s+flatten\s+0\s+0\s+n\/a/);
  });

  it('prints the table even when every count is zero', () => {
    const text = reportWith(noCostBasisDrops(), noCostBasisDrops());

    expect(text).toContain('COST-BASIS EXCLUSION by exit class');
    expect(text).toMatch(/live\s+protective\s+0\s+0\s+n\/a/);
    expect(text).toMatch(/control\s+flatten\s+0\s+0\s+n\/a/);
  });

  it('names the capture asymmetry in the direction the code has it', () => {
    const flattened = reportWith(noCostBasisDrops(), noCostBasisDrops())
      .split('\n')
      .map((line) => line.trim())
      .join(' ');

    expect(flattened).toContain(
      'a flatten close needs TWO successful captures to be counted here and a ' +
        'protective close needs ONE',
    );
  });
});

describe('parseWindowDays', () => {
  it('defaults when no window is given', () => {
    expect(parseWindowDays([])).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('reads an explicit window', () => {
    expect(parseWindowDays(['--days', '7'])).toBe(7);
  });

  it('refuses a window that would silently produce an empty or reversed report', () => {
    for (const bad of [['--days', '0'], ['--days', '-3'], ['--days', 'soon'], ['--days']]) {
      expect(() => parseWindowDays(bad)).toThrow(/--days must be a positive number of days/);
    }
  });
});
