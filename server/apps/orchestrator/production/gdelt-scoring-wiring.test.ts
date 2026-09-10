/**
 * The wiring proof for #1086 — the GDELT scoring pass is built by the REAL
 * composition root, against the SAME archive the ingest agent writes and the
 * SAME store the analysts read.
 *
 * A separate file from `gdelt-scoring-pass.test.ts`, the split
 * `mi-refresh-wiring.test.ts` and `rate-limit-wiring.test.ts` make: that file
 * tests what the pass does, this one tests what the composition root does with
 * one. A correct pass constructed nowhere on the shipped path is this repo's
 * dominant defect class, and no unit test can see it.
 *
 * ## The mutations these kill
 *
 * 1. Do not build the pass at all (the pre-#1086 state: the archive half with
 *    no reader). `gdeltScoringPass` is `undefined` and both assertions go red.
 * 2. Build it with a fresh `new MarketIntelligenceStore(clock)` instead of the
 *    root's `marketIntelligence`. The pass still derives, still logs, and the
 *    item reaches a store nothing reads — `gdelt-scoring-pass.test.ts` stays
 *    green throughout, because the store it asserts on is the one it passed
 *    in. Only the analyst-visible read here goes red.
 * 3. Build it with a fresh `new MiArchiveStore()` instead of
 *    `config.miArchive`. The archived history is invisible, the pass refuses
 *    on a cold baseline, and the emitted-item assertion goes red.
 * 4. Derive for every `AssetClass` rather than the universe's. The crypto leg
 *    derives from the same macro-themed seed and logs its own aggregate, so
 *    the no-crypto-GDELT-log assertion below goes red.
 *
 * Mutations 2 and 4 were applied to `production.ts` and observed red, rather
 * than argued: an assertion over an `unknown` payload is exactly the kind that
 * can pass vacuously.
 *
 * ## What this file does NOT cover, and where that is covered
 *
 * That `start()` actually CALLS `run` on its GDELT timer. Driving the real
 * timer here would mean starting the tick loop against these stubs. `yarn
 * smoke` runs the real composition root through `start()` with a seeded
 * archive and asserts an emitted aggregate reaches the store
 * (`SMOKE_GDELT_EXPECTED_AGGREGATES`), which is that half.
 */
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import {
  GDELT_MACRO_ENTITY,
  MI_SOURCES,
  MiArchiveStore,
  PROJECTED_COLUMNS,
  type RawArchiveRow,
} from '../../../providers/market-intelligence/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-09-03T12:34:00Z');
/** `floorToBar(NOW)` on the 1h debate grid. */
const BAR = new Date('2026-09-03T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

function payload(tone: number): string {
  const columns = new Array<string>(27).fill('');
  columns[0] = 'record';
  columns[1] = '20260903120000';
  columns[3] = 'wiring.test';
  columns[4] = 'https://wiring.test/a';
  columns[7] = 'ECON_INTEREST_RATES';
  columns[15] = `${tone},2.0,0.5,2.5,20,0.1,400`;
  return PROJECTED_COLUMNS.map((column) => columns[column] ?? '').join('\t');
}

/** 24 populated baseline buckets at tone 0, then a signal hour at tone 2. */
function seededArchive(): MiArchiveStore {
  const archive = new MiArchiveStore();
  const rows: RawArchiveRow[] = [];
  const push = (at: number, tone: number, id: string): void => {
    rows.push({
      source: MI_SOURCES.gdeltGkg,
      native_id: id,
      updated_at: new Date(at),
      payload: payload(tone),
      ingested_at: new Date(at),
      fidelity: 'live',
    });
  };
  const baselineStart = BAR.getTime() - 25 * HOUR_MS;
  for (let bucket = 0; bucket < 24; bucket += 1) {
    for (let n = 0; n < 2; n += 1) {
      push(baselineStart + bucket * HOUR_MS + n * 60_000, 0, `b${bucket}-${n}`);
    }
  }
  for (let n = 0; n < 5; n += 1) push(BAR.getTime() - HOUR_MS + n * 60_000, 2, `s${n}`);
  archive.write(rows, []);
  return archive;
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

/** The narrowest `ProductionConfig` that builds. Every transport is a stub. */
function stubConfig(db: StoreHandle, overrides: Partial<ProductionConfig>): ProductionConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    alpacaBrokerClient: {
      submitOrder: vi.fn(),
      submitLimitOrder: vi.fn(),
      submitStopLimitOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrder: vi.fn(),
      listOrders: vi.fn(async () => []),
      listFills: vi.fn(async () => []),
    } as unknown as ProductionConfig['alpacaBrokerClient'],
    alpacaDataClient: {
      getBars: vi.fn(async () => []),
      getLatestQuote: vi.fn(async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 })),
    } as unknown as ProductionConfig['alpacaDataClient'],
    accountState: {
      getAccountState: vi.fn(async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      })),
    } as unknown as ProductionConfig['accountState'],
    llmClient: { complete: vi.fn() } as unknown as ProductionConfig['llmClient'],
    polymarketClient: {
      fetchMarket: vi.fn(async () => undefined),
    } as unknown as ProductionConfig['polymarketClient'],
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: makeWiringRiskConfig(),
    verdictConfig: makeWiringVerdictConfig(),
    executionConfig: makeWiringExecutionConfig(),
    correlationConfig: makeWiringCorrelationConfig(),
    breakerConfig: {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.3,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
    } as ProductionConfig['breakerConfig'],
    costConfig: makeWiringCostConfig(),
    ciiConsumerConfig: makeWiringCiiConsumerConfig(),
    ...overrides,
  } as ProductionConfig;
}

describe('GDELT scoring wiring (#1086)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('derives from the roots archive into the store the analysts read', () => {
    const { logger, entries } = recordingLogger();
    const components = buildProductionComponents(
      stubConfig(db, {
        logger,
        miArchive: seededArchive(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      }),
    );

    expect(components.gdeltScoringPass).toBeDefined();
    components.gdeltScoringPass?.run('wiring');

    // The read `fundamental-analyst.ts` performs — entity-scoped, through the
    // store the root handed the analyst step.
    const context = components.marketIntelligence.getContext(
      'stocks',
      24 * HOUR_MS,
      'wiring',
      BAR,
      'SPY',
    );
    expect(context.intel.map((item) => item.entity)).toEqual([GDELT_MACRO_ENTITY]);
    expect(entries.some((entry) => entry.message.includes('derived GDELT macro aggregate'))).toBe(
      true,
    );
  });

  it('derives only for the universes asset classes', () => {
    const { logger, entries } = recordingLogger();
    const components = buildProductionComponents(
      stubConfig(db, {
        logger,
        miArchive: seededArchive(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      }),
    );

    components.gdeltScoringPass?.run('wiring');

    // The seeded archive carries a MACRO theme, which is on BOTH watchlists —
    // so a pass built over every AssetClass would emit a crypto aggregate too.
    // The stocks leg derived, so the pass ran at all…
    expect(entries.some((entry) => entry.message.includes('derived GDELT macro aggregate'))).toBe(
      true,
    );
    // …and no line, emitted or refused, belongs to a leg the universe has no
    // instrument in.
    for (const entry of entries) {
      expect(entry.payload).not.toMatchObject({
        source: MI_SOURCES.gdeltGkg,
        asset_class: 'crypto',
      });
    }
  });

  it('is absent on a run with no MI archive, like the archiver it reads', () => {
    const components = buildProductionComponents(
      stubConfig(db, { universe: [{ asset: 'SPY', asset_class: 'stocks' }] }),
    );

    expect(components.gdeltIngestAgent).toBeUndefined();
    expect(components.gdeltScoringPass).toBeUndefined();
  });
});
