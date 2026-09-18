import { describe, expect, it } from 'vitest';
import { makeMetrics, makeSnapshot } from '../test-fixtures.ts';
import { RECOGNISED_MODES, snapshotUrl, toWireSnapshot } from './useSnapshot.ts';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(makeSnapshot() as unknown as Record<string, unknown>), ...overrides };
}

describe('toWireSnapshot', () => {
  it.each(RECOGNISED_MODES)('passes the recognised mode %s through', (mode) => {
    expect(toWireSnapshot(raw({ mode }))?.mode).toBe(mode);
  });

  it('narrows an ABSENT mode to null rather than leaving it undefined', () => {
    const body = raw();
    delete body.mode;
    const snapshot = toWireSnapshot(body);

    expect(snapshot?.mode).toBeNull();
  });

  it.each([['staging'], [''], ['PAPER'], [' live'], [42], [null], [{ mode: 'live' }]])(
    'narrows the unrecognised mode %o to null',
    (mode) => {
      expect(toWireSnapshot(raw({ mode }))?.mode).toBeNull();
    },
  );

  it('never coerces an unknown mode toward "paper"', () => {
    for (const mode of [undefined, 'staging', 'live-ish', 0]) {
      expect(toWireSnapshot(raw({ mode }))?.mode).not.toBe('paper');
    }
  });

  it('keeps the rest of the payload when mode is unusable', () => {
    const body = raw({ mode: 'staging' });
    const snapshot = toWireSnapshot(body);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.positions.length).toBeGreaterThan(0);
    expect(snapshot?.verdicts.length).toBeGreaterThan(0);
    expect(snapshot?.pipeline).toBeDefined();
  });

  it('keeps the payload when the spend summary is null, and narrows it to null', () => {
    const snapshot = toWireSnapshot(raw({ llm_spend: null }));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.llm_spend).toBeNull();
    expect(snapshot?.positions.length).toBeGreaterThan(0);
    expect(snapshot?.pipeline).toBeDefined();
  });

  it('narrows an ABSENT or non-object spend summary to null', () => {
    const absent = raw();
    delete absent.llm_spend;
    expect(toWireSnapshot(absent)?.llm_spend).toBeNull();
    expect(toWireSnapshot(raw({ llm_spend: 'unavailable' }))?.llm_spend).toBeNull();
    expect(toWireSnapshot(raw({ llm_spend: 0 }))?.llm_spend).toBeNull();
  });

  it('narrows a spend summary the panel could not render to null', () => {
    const summary = makeSnapshot().llm_spend as unknown as Record<string, unknown>;
    const withoutAllTime = { ...summary };
    delete withoutAllTime.all_time;
    const windowWithoutPerDebate = { ...(summary.all_time as Record<string, unknown>) };
    delete windowWithoutPerDebate.per_debate;

    for (const spend of [
      [],
      [summary],
      withoutAllTime,
      { ...summary, all_time: windowWithoutPerDebate },
      { ...summary, last_7d: null },
      { ...summary, last_24h: [] },
      {},
    ]) {
      expect(toWireSnapshot(raw({ llm_spend: spend }))?.llm_spend).toBeNull();
    }
  });

  it('normalizes a malformed cap_usd or cap_armed_at instead of rejecting the whole summary', () => {
    const summary = makeSnapshot().llm_spend as unknown as Record<string, unknown>;

    for (const { spend, wantCapUsd, wantCapArmedAt } of [
      {
        spend: { ...summary, cap_usd: '50' },
        wantCapUsd: undefined,
        wantCapArmedAt: summary.cap_armed_at,
      },
      {
        spend: { ...summary, cap_usd: false },
        wantCapUsd: undefined,
        wantCapArmedAt: summary.cap_armed_at,
      },
      {
        spend: { ...summary, cap_armed_at: '' },
        wantCapUsd: summary.cap_usd,
        wantCapArmedAt: undefined,
      },
      {
        spend: { ...summary, cap_armed_at: 12_345 },
        wantCapUsd: summary.cap_usd,
        wantCapArmedAt: undefined,
      },
      {
        spend: { ...summary, cap_armed_at: 'not-a-timestamp' },
        wantCapUsd: summary.cap_usd,
        wantCapArmedAt: undefined,
      },
    ]) {
      const result = toWireSnapshot(raw({ llm_spend: spend }))?.llm_spend;
      expect(result).not.toBeNull();
      expect(result?.cap_usd).toEqual(wantCapUsd);
      expect(result?.cap_armed_at).toEqual(wantCapArmedAt);
      expect(result?.all_time).toEqual(summary.all_time);
    }
  });

  it('admits a spend summary missing cap_usd or cap_armed_at entirely', () => {
    const summary = makeSnapshot().llm_spend as unknown as Record<string, unknown>;
    const withoutCapArmedAt = { ...summary };
    delete withoutCapArmedAt.cap_armed_at;
    const withoutCapUsd = { ...summary };
    delete withoutCapUsd.cap_usd;

    expect(toWireSnapshot(raw({ llm_spend: withoutCapArmedAt }))?.llm_spend).toEqual(
      withoutCapArmedAt,
    );
    expect(toWireSnapshot(raw({ llm_spend: withoutCapUsd }))?.llm_spend).toEqual(withoutCapUsd);
  });

  it('passes a real spend summary through untouched', () => {
    const body = raw();
    expect(toWireSnapshot(body)?.llm_spend).toEqual(body.llm_spend);
  });

  it('passes a real pnl headline through untouched', () => {
    const body = raw();
    expect(toWireSnapshot(body)?.pnl).toEqual(body.pnl);
  });

  it('narrows an absent, null, or non-object pnl to null (PR #1619 review, finding 1)', () => {
    const absent = raw();
    delete absent.pnl;
    expect(toWireSnapshot(absent)?.pnl).toBeNull();
    expect(toWireSnapshot(raw({ pnl: null }))?.pnl).toBeNull();
    expect(toWireSnapshot(raw({ pnl: 'unavailable' }))?.pnl).toBeNull();
    expect(toWireSnapshot(raw({ pnl: [] }))?.pnl).toBeNull();
  });

  it('narrows a pnl headline missing overall or today to null instead of dereferencing it', () => {
    const headline = makeSnapshot().pnl as unknown as Record<string, unknown>;
    const withoutOverall = { ...headline };
    delete withoutOverall.overall;
    const withoutToday = { ...headline };
    delete withoutToday.today;

    for (const pnl of [withoutOverall, withoutToday, { ...headline, overall: 'x' }, {}]) {
      expect(toWireSnapshot(raw({ pnl }))?.pnl).toBeNull();
    }
  });

  it('rejects a body that is not a snapshot at all', () => {
    expect(toWireSnapshot(null)).toBeNull();
    expect(toWireSnapshot('<html>captive portal</html>')).toBeNull();
    expect(toWireSnapshot({})).toBeNull();
    const body = raw();
    delete body.pipeline;
    expect(toWireSnapshot(body)).toBeNull();
  });

  describe('profit_factor normalization (#1270 review round 1, MAJOR)', () => {
    it('degrades a pre-#1270 null (the value JSON.stringify collapsed Infinity/NaN/-Infinity into) to unreadable, never guessing no_losses', () => {
      const body = raw({ metrics: { ...makeMetrics(), profit_factor: null } });
      expect(toWireSnapshot(body)?.metrics.profit_factor).toEqual({ kind: 'unreadable' });
    });

    it('routes a pre-#1270 bare finite number through toProfitFactorWire, matching what a current server would have sent', () => {
      const body = raw({ metrics: { ...makeMetrics(), profit_factor: 1.24 } });
      expect(toWireSnapshot(body)?.metrics.profit_factor).toEqual({ kind: 'ratio', value: 1.24 });
    });

    it('routes a pre-#1270 bare zero (no closed trades at all) to a real ratio of 0, not unreadable', () => {
      const body = raw({ metrics: { ...makeMetrics(), profit_factor: 0 } });
      expect(toWireSnapshot(body)?.metrics.profit_factor).toEqual({ kind: 'ratio', value: 0 });
    });

    it.each([{ kind: 'ratio', value: 2.5 }, { kind: 'no_losses' }, { kind: 'unreadable' }])(
      "passes today's server shape %o through untouched",
      (shape) => {
        const body = raw({ metrics: { ...makeMetrics(), profit_factor: shape } });
        expect(toWireSnapshot(body)?.metrics.profit_factor).toEqual(shape);
      },
    );

    it.each([
      [{ kind: 'ratio', value: Number.NaN }],
      [{ kind: 'ratio', value: 'not a number' }],
      [{ kind: 'ratio' }],
      [{ kind: 'something-unknown' }],
      [[]],
      ['a string'],
      [undefined],
    ])('degrades a malformed profit_factor %o to unreadable rather than throwing', (malformed) => {
      const body = raw({ metrics: { ...makeMetrics(), profit_factor: malformed } });
      expect(toWireSnapshot(body)?.metrics.profit_factor).toEqual({ kind: 'unreadable' });
    });
  });
});

describe('snapshotUrl', () => {
  it('leaves the URL untouched when arm is undefined', () => {
    expect(snapshotUrl('/api/snapshot')).toBe('/api/snapshot');
  });

  it('leaves the URL untouched when arm is explicitly live', () => {
    expect(snapshotUrl('/api/snapshot', 'live')).toBe('/api/snapshot');
  });

  it('appends ?arm=control only for the control arm', () => {
    expect(snapshotUrl('/api/snapshot', 'control')).toBe('/api/snapshot?arm=control');
  });
});
