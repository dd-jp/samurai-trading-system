/**
 * The fetch boundary's validation (PR #597 review). `toWireSnapshot` is the
 * ONE place a payload off the network is checked and `mode` is narrowed, so
 * every consumer downstream can read `snapshot.mode` and trust it.
 *
 * Pure — no DOM, no fetch, no timers. The polling behaviour around it is
 * covered by the component tests in `App.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import { makeMetrics, makeSnapshot } from '../test-fixtures.ts';
import { RECOGNISED_MODES, snapshotUrl, toWireSnapshot } from './useSnapshot.ts';

/** A payload as it comes off `response.json()`: untyped, possibly wrong */
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

    // Not `undefined`: the type says `ServerMode | null`, and a consumer that
    // reads this field must find the value the type promises
    expect(snapshot?.mode).toBeNull();
  });

  it.each([['staging'], [''], ['PAPER'], [' live'], [42], [null], [{ mode: 'live' }]])(
    'narrows the unrecognised mode %o to null',
    (mode) => {
      expect(toWireSnapshot(raw({ mode }))?.mode).toBeNull();
    },
  );

  it('never coerces an unknown mode toward "paper"', () => {
    // The asymmetric failure this whole field exists to prevent: a page that
    // says "paper" while real money is at risk
    for (const mode of [undefined, 'staging', 'live-ish', 0]) {
      expect(toWireSnapshot(raw({ mode }))?.mode).not.toBe('paper');
    }
  });

  it('keeps the rest of the payload when mode is unusable', () => {
    // A bad `mode` must not throw away positions, verdicts and the pipeline —
    // the rail has an honest rendering for an unknown mode, and blanking a
    // live-money screen over one field would be the worse failure
    const body = raw({ mode: 'staging' });
    const snapshot = toWireSnapshot(body);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.positions.length).toBeGreaterThan(0);
    expect(snapshot?.verdicts.length).toBeGreaterThan(0);
    expect(snapshot?.pipeline).toBeDefined();
  });

  it('keeps the payload when the spend summary is null, and narrows it to null', () => {
    // #606 item 2: the rail's LLM cap block renders a named empty state for exactly this
    // value and the burn meter renders "meter not drawable", so rejecting the
    // body froze every OTHER panel — positions, verdicts, the whole pipeline —
    // to spare the one panel built to degrade
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
    // A scalar where an object belongs is the proxy/older-server case, and it
    // must not reach the LLM cap block as something it will dereference
    expect(toWireSnapshot(raw({ llm_spend: 'unavailable' }))?.llm_spend).toBeNull();
    expect(toWireSnapshot(raw({ llm_spend: 0 }))?.llm_spend).toBeNull();
  });

  it('narrows a spend summary the panel could not render to null', () => {
    // PR #607 review round 1: `typeof [] === 'object'`, so the first version of
    // this narrowing cast an array to `LlmSpendSummary` and the spend block threw
    // on `spend.all_time.per_debate` — a white screen, since `main.tsx` mounts
    // `<App/>` with no error boundary. Admitting a wrong shape is worse than
    // rejecting a null: the panel exists to say "the read failed", and it can
    // only say it if the boundary hands it `null`
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

  // Review round 2, MINOR 3: rejecting the WHOLE summary over one malformed
  // scalar neither consumer dereferences into would throw away three valid
  // spend windows (the 24h/7d/all-time footnote) over a fault in an unrelated
  // field — the exact `mode` mistake `toWireSnapshot`'s doc comment says this
  // file exists to avoid, one level deeper. Each malformed cap field
  // degrades to `null`/`undefined` on its own; the windows always survive
  //
  // A malformed `cap_usd` degrades to `undefined`, NOT `null` (review round
  // 3's MAJOR): `null` is reserved for the wire EXPLICITLY saying so, and
  // collapsing a malformed value into it let an intact `cap_armed_at` on the
  // same payload render "deliberately uncapped" — an affirmative claim
  // manufactured from noise
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

  // `undefined` (the field entirely absent) is the mixed-version case — an
  // older server that predates #1196 — not a malformed one, and at THIS
  // boundary must not be rejected: the rest of the summary is still real and
  // rendered, unlike a structurally bad window (`per_debate` missing etc.),
  // which voids the whole summary
  //
  // That does not mean an absent field renders any differently from a
  // malformed one, though: `normalizeCapUsd(undefined)` and
  // `normalizeCapUsd('50')` both return `undefined`, and so do
  // `normalizeCapArmedAt`'s absent- and malformed-input cases — "no version
  // info" and "corrupt version info" are different facts about WHY the
  // client cannot read a field, but the same fact about whether it can be
  // trusted, so `Rail.tsx` renders both the same way per field (`'unreadable'`
  // for `cap_usd`, folded into `'ambiguous'` for `cap_armed_at` — review
  // round 3's MAJOR)
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
    // `CONTRACT_VERSION` hashes only `DashboardSnapshot`'s own top-level field
    // names (`contracts/snapshot.ts`), so a rename nested inside
    // `PnlHeadlineWire.overall`/`.today` moves nothing there and lands here
    // structurally "known good" but missing the field `PnlCard` dereferences
    // straight into with no error boundary — the same shape `llm_spend`'s
    // `all_time`/`per_debate` check above guards
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
    // Parses, has a mode, but carries no pipeline lanes — an empty lane matrix
    // would read as "the system went quiet"
    const body = raw();
    delete body.pipeline;
    expect(toWireSnapshot(body)).toBeNull();
  });

  describe('profit_factor normalization (#1270 review round 1, MAJOR)', () => {
    // `hasWireShape` only checks that `metrics` is a non-null object — it
    // never looks inside at `profit_factor` — so a pre-#1270 server's
    // payload reaches this boundary structurally valid. Without
    // normalization, ReviewTab's `switch (pf.kind)` throws on these, and
    // `main.tsx` mounts with no error boundary: a white screen, not a
    // degraded tile

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

    // Each row is wrapped in its own 1-tuple: `it.each` spreads a row that is
    // itself an array as a MULTI-argument call rather than a single `%o`
    // argument, so the bare `[]` case below would otherwise vanish as a
    // zero-argument invocation (silently duplicating the `undefined` case
    // instead of ever exercising an array input) — caught by re-running this
    // block with `--reporter=verbose` and finding two identically-named
    // "undefined" cases instead of one "[]" and one "undefined"
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

/**
 * #1593: the URL a poll actually fetches. `undefined` and `'live'` must be
 * the SAME request as before this option existed — a byte-for-byte identical
 * string, not merely an equivalent one the server happens to answer the same
 * way — because the default, no-arm-selected dashboard must not change its
 * request shape at all.
 */
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
