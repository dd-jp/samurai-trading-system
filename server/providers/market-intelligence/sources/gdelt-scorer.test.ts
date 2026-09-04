/**
 * The scoring half of #556, as a pure function (#1086).
 *
 * Every case here builds its rows through `projectedPayload`, which lays a
 * 27-column GKG line out and projects it with the client's own
 * `PROJECTED_COLUMNS`. That is deliberate: the archive stores the projection,
 * not the line, so a parser reading the wrong offset would be invisible to a
 * fixture that hand-wrote six fields in the order the parser expects.
 */
import type { RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import { PROJECTED_COLUMNS } from './gdelt-gkg-client.js';
import {
  confidenceFromToneDelta,
  DEFAULT_GDELT_WINDOWS,
  deriveGdeltAggregate,
  GDELT_MACRO_ENTITY,
  MIN_BASELINE_BUCKET_FRACTION,
  MIN_BASELINE_RECORDS_PER_BUCKET,
  MIN_SIGNAL_RECORDS,
  parseGdeltProjection,
} from './gdelt-scorer.js';

const WINDOW_END = new Date('2026-09-03T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const SIGNAL_MS = DEFAULT_GDELT_WINDOWS.signalWindowMs;
const BUCKETS = DEFAULT_GDELT_WINDOWS.baselineWindowMs / SIGNAL_MS;
const BASELINE_START = WINDOW_END.getTime() - SIGNAL_MS - DEFAULT_GDELT_WINDOWS.baselineWindowMs;

function projectedPayload(themes: readonly string[], tone: number): string {
  const columns = new Array<string>(27).fill('');
  columns[0] = 'record-1';
  columns[1] = '20260903120000';
  columns[3] = 'fixture.test';
  columns[4] = 'https://fixture.test/a';
  columns[7] = themes.join(';');
  // V1.5TONE is `tone,positive,negative,polarity,…` — only the first field is
  // the average tone, and the rest are here so a parser that took the whole
  // string fails rather than coincidentally working.
  columns[15] = `${tone},2.0,0.5,2.5,20,0.1,400`;
  return PROJECTED_COLUMNS.map((column) => columns[column] ?? '').join('\t');
}

function row(at: Date, themes: readonly string[], tone: number): RawArchiveRow {
  return {
    source: MI_SOURCES.gdeltGkg,
    native_id: `${at.toISOString()}-${tone}`,
    updated_at: at,
    payload: projectedPayload(themes, tone),
    ingested_at: at,
    fidelity: 'live',
  };
}

/**
 * A baseline that clears every coverage rule: every bucket of the 24h window
 * populated at the per-bucket record minimum, all at `tone`.
 */
function healthyBaseline(tone: number): RawArchiveRow[] {
  const rows: RawArchiveRow[] = [];
  for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
    for (let n = 0; n < MIN_BASELINE_RECORDS_PER_BUCKET; n += 1) {
      rows.push(
        row(
          new Date(BASELINE_START + bucket * SIGNAL_MS + n * 60_000),
          ['ECON_INTEREST_RATES'],
          tone,
        ),
      );
    }
  }
  return rows;
}

function signalRows(tone: number, count = MIN_SIGNAL_RECORDS): RawArchiveRow[] {
  const start = WINDOW_END.getTime() - SIGNAL_MS;
  return Array.from({ length: count }, (_, n) =>
    row(new Date(start + n * 60_000), ['ECON_INTEREST_RATES'], tone),
  );
}

function derive(rows: readonly RawArchiveRow[]) {
  return deriveGdeltAggregate(rows, { asset_class: 'stocks', windowEnd: WINDOW_END });
}

describe('parseGdeltProjection', () => {
  it('reads themes and the leading tone field out of the stored projection', () => {
    const parsed = parseGdeltProjection(projectedPayload(['ECON_INFLATION', 'ECON_DEBT'], -3.25));
    expect(parsed).toEqual({ themes: ['ECON_INFLATION', 'ECON_DEBT'], tone: -3.25 });
  });

  it('refuses a payload whose tone is not a finite number', () => {
    expect(parseGdeltProjection(projectedPayload(['ECON_DEBT'], Number.NaN))).toBeUndefined();
  });
});

describe('confidenceFromToneDelta — the placeholder `f` (#688 calibrates it)', () => {
  it('is zero at zero', () => {
    expect(confidenceFromToneDelta(0)).toBe(0);
  });

  it('is bounded in [0, 1] across the whole tone range and beyond', () => {
    for (const delta of [0, 0.1, 1, 5, 100, 1e6]) {
      const value = confidenceFromToneDelta(delta);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is monotone non-decreasing in |toneDelta|', () => {
    let previous = -1;
    for (let delta = 0; delta <= 20; delta += 0.25) {
      const value = confidenceFromToneDelta(delta);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is pure — the same argument yields the same answer', () => {
    expect(confidenceFromToneDelta(2.5)).toBe(confidenceFromToneDelta(2.5));
  });
});

describe('deriveGdeltAggregate', () => {
  it('emits one class-wide macro item from the signal window against the baseline', () => {
    const result = derive([...healthyBaseline(0), ...signalRows(2)]);

    expect(result.emitted).toBe(true);
    if (!result.emitted) return;
    expect(result.item.entity).toBe(GDELT_MACRO_ENTITY);
    expect(result.item.scope).toBe('asset_class');
    expect(result.item.type).toBe('news');
    expect(result.item.sentiment).toBe(1);
    expect(result.item.timestamp).toEqual(WINDOW_END);
    expect(result.item.confidence).toBeCloseTo(confidenceFromToneDelta(2), 12);
    // Point 4 of #556: the delta is the signal, the tone MEAN rides along.
    expect(result.stats.signal_tone_mean).toBeCloseTo(2, 12);
    expect(result.stats.baseline_tone_mean).toBeCloseTo(0, 12);
    expect(result.stats.tone_delta).toBeCloseTo(2, 12);
  });

  it('signs the item off the delta, not off the absolute tone', () => {
    // Both windows are negative in absolute terms; the signal window is LESS
    // negative, which is bullish news flow.
    const result = derive([...healthyBaseline(-5), ...signalRows(-2)]);
    expect(result.emitted).toBe(true);
    if (!result.emitted) return;
    expect(result.item.sentiment).toBe(1);
  });

  it('emits sentiment 0 with zero confidence when the delta is exactly zero', () => {
    const result = derive([...healthyBaseline(1.5), ...signalRows(1.5)]);
    expect(result.emitted).toBe(true);
    if (!result.emitted) return;
    expect(result.item.sentiment).toBe(0);
    expect(result.item.confidence).toBe(0);
  });

  it('is deterministic — the same rows in any order derive the same item', () => {
    const rows = [...healthyBaseline(0.5), ...signalRows(-1.5)];
    const first = derive(rows);
    const second = derive([...rows].reverse());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('re-derives over the same rows when the window lengths change', () => {
    const rows = [...healthyBaseline(0), ...signalRows(2)];
    const narrower = deriveGdeltAggregate(rows, {
      asset_class: 'stocks',
      windowEnd: WINDOW_END,
      windows: { signalWindowMs: 2 * HOUR_MS, baselineWindowMs: 12 * HOUR_MS },
    });
    expect(narrower.emitted).toBe(true);
    if (!narrower.emitted) return;
    // The 2h signal window now reaches an hour of baseline-toned rows, so the
    // delta is smaller than the 1h read's — same archive, different answer.
    expect(narrower.stats.tone_delta).toBeLessThan(2);
    expect(narrower.stats.tone_delta).toBeGreaterThan(0);
  });

  it('filters by the asset class watchlist, not by the union the fetcher archived', () => {
    const cryptoOnly = [...healthyBaseline(0), ...signalRows(2)].map((raw) => ({
      ...raw,
      payload: raw.payload.replace('ECON_INTEREST_RATES', 'ECON_BITCOIN'),
    }));
    expect(
      deriveGdeltAggregate(cryptoOnly, { asset_class: 'crypto', windowEnd: WINDOW_END }).emitted,
    ).toBe(true);
    // ECON_BITCOIN is not on the stocks watchlist, so the same rows leave the
    // stocks leg with an empty baseline.
    const stocks = deriveGdeltAggregate(cryptoOnly, {
      asset_class: 'stocks',
      windowEnd: WINDOW_END,
    });
    expect(stocks.emitted).toBe(false);
    if (stocks.emitted) return;
    expect(stocks.reason).toBe('baseline_far_end_empty');
  });

  it('refuses a cold archive whose baseline does not reach back a full window', () => {
    // Drop the oldest bucket only: 23 of 24 is still above the density floor.
    const withoutFarEnd = healthyBaseline(0).filter(
      (raw) => raw.updated_at.getTime() >= BASELINE_START + SIGNAL_MS,
    );
    const result = derive([...withoutFarEnd, ...signalRows(2)]);
    expect(result.emitted).toBe(false);
    if (result.emitted) return;
    expect(result.reason).toBe('baseline_far_end_empty');
  });

  it('refuses a baseline with too few populated buckets', () => {
    const keep = Math.ceil(BUCKETS * MIN_BASELINE_BUCKET_FRACTION) - 1;
    // The far end is kept, so that rule is not the one biting; the hole sits
    // in the middle of the window.
    const gapped = healthyBaseline(0).filter((raw) => {
      const bucket = Math.floor((raw.updated_at.getTime() - BASELINE_START) / SIGNAL_MS);
      return bucket === 0 || bucket >= BUCKETS - keep + 1;
    });
    const result = derive([...gapped, ...signalRows(2)]);
    expect(result.emitted).toBe(false);
    if (result.emitted) return;
    expect(result.reason).toBe('baseline_too_sparse');
  });

  it('refuses a baseline that is dense in buckets but thin in records', () => {
    // One record per bucket: every bucket populated, far end included, but
    // under the per-bucket record floor.
    const thin = Array.from({ length: BUCKETS }, (_, bucket) =>
      row(new Date(BASELINE_START + bucket * SIGNAL_MS), ['ECON_INTEREST_RATES'], 0),
    );
    const result = derive([...thin, ...signalRows(2)]);
    expect(result.emitted).toBe(false);
    if (result.emitted) return;
    expect(result.reason).toBe('baseline_too_sparse');
  });

  it('refuses a quiet signal window under its OWN reason, not a coverage one', () => {
    const result = derive([...healthyBaseline(0), ...signalRows(2, MIN_SIGNAL_RECORDS - 1)]);
    expect(result.emitted).toBe(false);
    if (result.emitted) return;
    expect(result.reason).toBe('signal_window_thin');
  });

  it('excludes rows at or after the window end — nothing from the open bar', () => {
    const future = row(new Date(WINDOW_END.getTime() + 60_000), ['ECON_INTEREST_RATES'], 50);
    const withFuture = derive([...healthyBaseline(0), ...signalRows(2), future]);
    const without = derive([...healthyBaseline(0), ...signalRows(2)]);
    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(without));
  });
});
