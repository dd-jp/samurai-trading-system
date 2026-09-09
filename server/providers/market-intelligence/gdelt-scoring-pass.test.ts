/**
 * The GKG scoring pass as the analysts see it (#1086) — what `gdelt-scorer.ts`
 * derives, actually reaching `MarketIntelligenceStore` through a real archive.
 *
 * The archive here is a real `MiArchiveStore`, not a fake: the read this pass
 * depends on (`rawRowsBetween`, indexed by migration 0003) is half of what is
 * being tested, and a hand-rolled row source would leave it unexercised.
 */

import type { LogEntry, Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { MiArchiveStore, type RawArchiveRow } from './archive/mi-archive-store.js';
import { MI_SOURCES } from './archive/mi-sources.js';
import {
  GdeltScoringPass,
  REFUSAL_REPEAT_EVERY,
  shouldLogRefusalAt,
} from './gdelt-scoring-pass.js';
import { MarketIntelligenceStore } from './index.js';
import { PROJECTED_COLUMNS } from './sources/gdelt-gkg-client.js';
import {
  GDELT_MACRO_ENTITY,
  MIN_BASELINE_RECORDS_PER_BUCKET,
  MIN_SIGNAL_RECORDS,
} from './sources/gdelt-scorer.js';

const NOW = new Date('2026-09-03T12:34:00Z');
/** `floorToBar(NOW)` on the 1h debate grid — the window end every derivation uses. */
const BAR = new Date('2026-09-03T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const CONTEXT_WINDOW_MS = 24 * HOUR_MS;

function payload(theme: string, tone: number): string {
  const columns = new Array<string>(27).fill('');
  columns[0] = 'record';
  columns[1] = '20260903120000';
  columns[3] = 'fixture.test';
  columns[4] = 'https://fixture.test/a';
  columns[7] = theme;
  columns[15] = `${tone},2.0,0.5,2.5,20,0.1,400`;
  return PROJECTED_COLUMNS.map((column) => columns[column] ?? '').join('\t');
}

function row(at: Date, tone: number, suffix: string): RawArchiveRow {
  return {
    source: MI_SOURCES.gdeltGkg,
    native_id: `${at.toISOString()}-${suffix}`,
    updated_at: at,
    payload: payload('ECON_INTEREST_RATES', tone),
    ingested_at: at,
    fidelity: 'live',
  };
}

/**
 * 24 populated baseline buckets at `baselineTone` plus a signal hour at
 * `signalTone` — the archive shape that clears every coverage rule.
 */
function seededArchive(baselineTone = 0, signalTone = 2): MiArchiveStore {
  const archive = new MiArchiveStore();
  const rows: RawArchiveRow[] = [];
  const baselineStart = BAR.getTime() - 25 * HOUR_MS;
  for (let bucket = 0; bucket < 24; bucket += 1) {
    for (let n = 0; n < MIN_BASELINE_RECORDS_PER_BUCKET; n += 1) {
      rows.push(
        row(
          new Date(baselineStart + bucket * HOUR_MS + n * 60_000),
          baselineTone,
          `b${bucket}-${n}`,
        ),
      );
    }
  }
  for (let n = 0; n < 5; n += 1) {
    rows.push(row(new Date(BAR.getTime() - HOUR_MS + n * 60_000), signalTone, `s${n}`));
  }
  archive.write(rows, []);
  return archive;
}

/**
 * An archive that stays healthy across `bars` consecutive debate bars: every
 * hour from a full baseline before `BAR` up to the last bar's signal hour
 * carries enough records to clear every coverage rule, with the tone
 * alternating so each bar's delta is non-zero.
 */
function continuousArchive(bars: number): MiArchiveStore {
  const archive = new MiArchiveStore();
  const rows: RawArchiveRow[] = [];
  for (let offset = -25; offset <= bars - 2; offset += 1) {
    const hourStart = BAR.getTime() + offset * HOUR_MS;
    for (let n = 0; n < MIN_SIGNAL_RECORDS; n += 1) {
      rows.push(row(new Date(hourStart + n * 60_000), offset % 2 === 0 ? 0 : 2, `h${offset}-${n}`));
    }
  }
  archive.write(rows, []);
  return archive;
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

function passFor(
  archive: MiArchiveStore,
  store: MarketIntelligenceStore,
  logger?: Logger,
  windows?: { signalWindowMs: number; baselineWindowMs: number },
): GdeltScoringPass {
  return new GdeltScoringPass({
    archive,
    store,
    clock: new SimulatedClock(NOW),
    assetClasses: ['stocks'],
    ...(logger === undefined ? {} : { logger }),
    ...(windows === undefined ? {} : { windows }),
  });
}

describe('GdeltScoringPass', () => {
  it('puts a class-wide macro aggregate in front of an entity-scoped analyst read', () => {
    const store = new MarketIntelligenceStore(new SimulatedClock(NOW));
    passFor(seededArchive(), store).run('trace-1');

    // The read `fundamental-analyst.ts` performs: asset class, 24h, the
    // resolved MI subject for one instrument.
    const context = store.getContext('stocks', CONTEXT_WINDOW_MS, 'trace-1', BAR, 'SPY');
    // #1164: a class-wide item routes to `intel`, not `news`.
    expect(context.news).toHaveLength(0);
    expect(context.intel).toHaveLength(1);
    expect(context.intel[0]?.entity).toBe(GDELT_MACRO_ENTITY);
    expect(context.intel[0]?.sentiment).toBe(1);
  });

  it('does not count as per-ticker coverage, which is the scope boundary #1086 states', () => {
    const store = new MarketIntelligenceStore(new SimulatedClock(NOW));
    passFor(seededArchive(), store).run('trace-1');

    const context = store.getContext('stocks', CONTEXT_WINDOW_MS, 'trace-1', BAR, 'SPY');
    // `hasCoverageFor`'s predicate, restated rather than imported so this
    // file does not depend on the orchestrator: an item covers an instrument
    // only when its entity IS that instrument.
    expect(context.intel.some((news) => news.entity === 'SPY')).toBe(false);
  });

  it('replays an archive to identical items — the same run twice ingests once', () => {
    const archive = seededArchive();
    const first = new MarketIntelligenceStore(new SimulatedClock(NOW));
    const second = new MarketIntelligenceStore(new SimulatedClock(NOW));

    const pass = passFor(archive, first);
    pass.run('trace-1');
    pass.run('trace-2');
    passFor(archive, second).run('trace-3');

    const read = (store: MarketIntelligenceStore) =>
      store.getContext('stocks', CONTEXT_WINDOW_MS, 'trace-x', BAR, 'SPY').intel;
    expect(read(first)).toHaveLength(1);
    expect(JSON.stringify(read(second))).toBe(JSON.stringify(read(first)));
  });

  it('re-derives over the SAME archive when the windows change — no re-fetch', () => {
    const archive = seededArchive();
    const wide = new MarketIntelligenceStore(new SimulatedClock(NOW));
    const narrow = new MarketIntelligenceStore(new SimulatedClock(NOW));

    passFor(archive, wide).run('trace-1');
    passFor(archive, narrow, undefined, {
      signalWindowMs: 2 * HOUR_MS,
      baselineWindowMs: 12 * HOUR_MS,
    }).run('trace-2');

    const wideItem = wide.getContext('stocks', CONTEXT_WINDOW_MS, 't', BAR, 'SPY').intel[0];
    const narrowItem = narrow.getContext('stocks', CONTEXT_WINDOW_MS, 't', BAR, 'SPY').intel[0];
    expect(wideItem).toBeDefined();
    expect(narrowItem).toBeDefined();
    // Same rows, different answer: the 2h signal window swallows an hour of
    // baseline-toned records, so the delta shrinks.
    expect(narrowItem?.confidence).toBeLessThan(wideItem?.confidence ?? 0);
  });

  it('refuses a cold archive, ingests nothing, and says so in the log', () => {
    const archive = new MiArchiveStore();
    archive.write([row(new Date(BAR.getTime() - 30 * 60_000), 4, 'only')], []);
    const store = new MarketIntelligenceStore(new SimulatedClock(NOW));
    const { logger, entries } = recordingLogger();

    passFor(archive, store, logger).run('trace-1');

    expect(store.getContext('stocks', CONTEXT_WINDOW_MS, 't', BAR, 'SPY').intel).toHaveLength(0);
    const refusal = entries.find((entry) => entry.level === 'warn');
    expect(refusal?.stage).toBe('market_intelligence');
    expect(refusal?.message).toContain('baseline');
    expect(refusal?.payload).toMatchObject({
      asset_class: 'stocks',
      reason: 'baseline_far_end_empty',
    });
  });

  it('throttles a persisting refusal first-then-every-Nth', () => {
    const archive = new MiArchiveStore();
    const store = new MarketIntelligenceStore(new SimulatedClock(NOW));
    const { logger, entries } = recordingLogger();
    const pass = passFor(archive, store, logger);

    const polls = REFUSAL_REPEAT_EVERY + 2;
    for (let n = 0; n < polls; n += 1) pass.run(`trace-${n}`);

    const refusals = entries.filter((entry) => entry.level === 'warn');
    // First, then every Nth — the `shouldAlertAt` convention `mi-coverage.ts`
    // sets, so a persistent hole is loud once rather than every poll.
    expect(refusals).toHaveLength(2);
  });

  it('logs a thin signal window at info, not as a coverage failure', () => {
    const archive = seededArchive();
    // A healthy baseline with no signal-window rows at all.
    const trimmed = new MiArchiveStore();
    trimmed.write(
      archive
        .rawRows(MI_SOURCES.gdeltGkg)
        .filter((raw) => raw.updated_at.getTime() < BAR.getTime() - HOUR_MS),
      [],
    );
    const { logger, entries } = recordingLogger();

    passFor(trimmed, new MarketIntelligenceStore(new SimulatedClock(NOW)), logger).run('trace-1');

    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(0);
    const quiet = entries.find((entry) => entry.message.includes('quiet'));
    expect(quiet?.level).toBe('info');
    expect(quiet?.payload).toMatchObject({ reason: 'signal_window_thin' });
  });

  it('never throws when the archive read fails, and logs the failure', () => {
    const archive = seededArchive();
    archive.close();
    const { logger, entries } = recordingLogger();

    expect(() =>
      passFor(archive, new MarketIntelligenceStore(new SimulatedClock(NOW)), logger).run('trace-1'),
    ).not.toThrow();
    expect(entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('leaves the analyst ONE aggregate after a day of bars, and it is the newest', () => {
    // The hazard this pins: the pass emits one item per bar, `ingest` drops a
    // repeat rather than replacing it, and nothing evicts — so without the
    // read-time collapse in `index.ts` a 24h read would hold 24 restatements
    // of one measurement, which `fundamental-analyst.ts` averages unweighted
    // against the 0-1 items an LSE ETP gets from the wire.
    const bars = 12;
    const clock = new SimulatedClock(NOW);
    const store = new MarketIntelligenceStore(clock);
    const pass = new GdeltScoringPass({
      archive: continuousArchive(bars),
      store,
      clock,
      assetClasses: ['stocks'],
    });

    for (let bar = 0; bar < bars; bar += 1) {
      clock.advanceTo(new Date(NOW.getTime() + bar * HOUR_MS));
      pass.run(`trace-${bar}`);
    }

    const lastBar = new Date(BAR.getTime() + (bars - 1) * HOUR_MS);
    const context = store.getContext('stocks', CONTEXT_WINDOW_MS, 'trace-read', lastBar, 'SPY');
    const intel = context.intel;
    expect(intel).toHaveLength(1);
    // `last_updated` answers "did a source speak recently", not "how many
    // items survived the read-time collapse", so it stays on the raw ingest
    // record and must keep reporting the newest emit.
    expect(context.last_updated?.toISOString()).toBe(lastBar.toISOString());
    // WHICH one survives, not merely how many: keeping the FIRST bar's item
    // would satisfy the count and serve a day-old measurement forever.
    expect(intel[0]?.timestamp.toISOString()).toBe(lastBar.toISOString());
    expect(intel[0]?.entity).toBe(GDELT_MACRO_ENTITY);
  });

  it('derives once per asset class per debate bar, not once per poll', () => {
    const archive = seededArchive();
    const store = new MarketIntelligenceStore(new SimulatedClock(NOW));
    const reads = vi.spyOn(archive, 'rawRowsBetween');

    const pass = passFor(archive, store);
    pass.run('trace-1');
    pass.run('trace-2');
    pass.run('trace-3');

    // ~20k rows per read on the paper archive: the bar guard is what keeps
    // the shipped 5-minute poll from paying for it twelve times an hour.
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('reads the bar window ONCE for a two-class run, and not at all once both emitted', () => {
    const archive = seededArchive();
    const store = new MarketIntelligenceStore(new SimulatedClock(NOW));
    const reads = vi.spyOn(archive, 'rawRowsBetween');
    const pass = new GdeltScoringPass({
      archive,
      store,
      clock: new SimulatedClock(NOW),
      assetClasses: ['stocks', 'crypto'],
    });

    pass.run('trace-1');
    // Both legs share (source, window end, windows), so the slice is one read
    // per BAR, not one per class — the whole point of the shared memo.
    expect(reads).toHaveBeenCalledTimes(1);
    // Which class a row belongs to is still decided per class, over the one
    // slice: a shared read must not collapse the two legs into one item.
    const stocks = store.getContext('stocks', CONTEXT_WINDOW_MS, 't', BAR, 'SPY').intel;
    const crypto = store.getContext('crypto', CONTEXT_WINDOW_MS, 't', BAR, 'BTC-USD').intel;
    expect(stocks).toHaveLength(1);
    expect(crypto).toHaveLength(1);

    reads.mockClear();
    pass.run('trace-2');
    // The `#emittedBar` guard runs BEFORE the read, so a bar every class has
    // already emitted for costs no archive read at all.
    expect(reads).toHaveBeenCalledTimes(0);
  });
});

describe('shouldLogRefusalAt', () => {
  it('fires on the first refusal and every Nth after it', () => {
    expect(shouldLogRefusalAt(0)).toBe(false);
    expect(shouldLogRefusalAt(1)).toBe(true);
    expect(shouldLogRefusalAt(2)).toBe(false);
    expect(shouldLogRefusalAt(1 + REFUSAL_REPEAT_EVERY)).toBe(true);
  });
});
