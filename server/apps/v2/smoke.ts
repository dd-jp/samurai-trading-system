import { pathToFileURL } from 'node:url';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { createVenueRouter, macroGate } from './data/index.js';
import { composeV2Root } from './index.js';
import {
  assertArm2RunsBesideDebate,
  bookSpecsFor,
  CapitalConfigStore,
  positionSizeShares,
} from './risk/index.js';
import {
  ALL_PINS,
  ARM2_ENTRY_THRESHOLDS,
  ARM2_SLEEVE_ID,
  CFD_BORROW_MODEL,
  CFD_COST_MODEL,
  CFD_FINANCING_MODEL,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  CFD_SPREAD_MODEL,
  cfdEntryRefusal,
  DEBATE_SLEEVE_ID,
  DEBATE_SLEEVE_SPEC,
  DECLARED_PARAMETERS,
  isSet,
  LSE_LIQUIDITY_SCREEN,
  type Parameter,
  RECONCILE_CASH_TOLERANCE_GBP,
  SqliteMonthlySpendCap,
} from './signal/index.js';

const CFD_COST_PARAMETERS: readonly Parameter<unknown>[] = [
  CFD_COST_MODEL,
  CFD_SPREAD_MODEL,
  CFD_FINANCING_MODEL,
  CFD_BORROW_MODEL,
];
const SET_PARAMETERS: readonly Parameter<unknown>[] = [
  ARM2_ENTRY_THRESHOLDS,
  LSE_LIQUIDITY_SCREEN,
  ...CFD_COST_PARAMETERS,
];
const STILL_UNSET_PARAMETERS = DECLARED_PARAMETERS.filter(
  (parameter) => !SET_PARAMETERS.includes(parameter),
);
// The cash tolerance blocks live entries only (David 2026-09-29, #1872), so a paper or dry-run
// cycle never journals it
const PAPER_REFUSED_PARAMETERS = STILL_UNSET_PARAMETERS.filter(
  (parameter) => parameter !== RECONCILE_CASH_TOLERANCE_GBP,
);

export interface SmokeProbe {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export const SMOKE_TRADING_DATE = '2026-09-23';
const SMOKE_NEXT_DATE = '2026-09-24';
const SMOKE_START_CAPITAL_GBP = 2_000;
const SMOKE_LOSS_CAP_GBP = 1_500;
const SMOKE_CLOCK = new SimulatedClock(new Date(`${SMOKE_TRADING_DATE}T07:00:00.000Z`));

function seededSmokeStore(): StoreHandle {
  const db = openSharedStore(':memory:');
  new CapitalConfigStore(db, SMOKE_CLOCK).setYear(
    Number(SMOKE_TRADING_DATE.slice(0, 4)),
    SMOKE_START_CAPITAL_GBP,
    SMOKE_LOSS_CAP_GBP,
  );
  return db;
}

function midYearLooseningRefused(): boolean {
  const db = seededSmokeStore();
  try {
    new CapitalConfigStore(db, SMOKE_CLOCK).tighten(SMOKE_TRADING_DATE, SMOKE_LOSS_CAP_GBP + 1);
    return false;
  } catch (error) {
    return error instanceof Error && /loosening mid-year is refused/.test(error.message);
  } finally {
    db.close();
  }
}

function probe(name: string, passed: boolean, detail: string): SmokeProbe {
  return { name, passed, detail };
}

function staticProbes(): SmokeProbe[] {
  const size = {
    equityGbp: SMOKE_START_CAPITAL_GBP,
    riskFraction: DEBATE_SLEEVE_SPEC.sizing.riskFraction,
    priceGbp: 10,
    atrGbp: 0.25,
    stopAtrMultiple: DEBATE_SLEEVE_SPEC.sizing.stopAtrMultiple,
    sizeMultiplier: 1,
    volumeCapShares: Number.POSITIVE_INFINITY,
  };
  const fullSize = positionSizeShares({ ...size, macroDay: false });
  const halfSize = positionSizeShares({ ...size, macroDay: true });
  const db = openSharedStore(':memory:');
  const clock = new SimulatedClock(new Date('2026-09-25T00:00:00.000Z'));
  db.prepare(
    `INSERT INTO llm_spend (trace_id, stage, model, input_tokens, output_tokens, cost_usd, latency_ms, timestamp)
     VALUES ('smoke', 'debate', 'anthropic/claude-sonnet-5', 1, 1, 30, 1, '2026-09-02T00:00:00.000Z')`,
  ).run();
  const cap = new SqliteMonthlySpendCap(db, clock).check();
  db.close();
  const declaredBooks = bookSpecsFor([{ id: 'debate', spec: DEBATE_SLEEVE_SPEC }]);
  return [
    probe(
      'model pins are dated or bare product ids and never a Fable model',
      ALL_PINS.every((pin) => !/fable/.test(pin.wire)),
      ALL_PINS.map((pin) => pin.wire).join(', '),
    ),
    probe('monthly LLM cap refuses at $30', !cap.admitted, JSON.stringify(cap)),
    probe(
      'macro day halves position size',
      halfSize * 2 === fullSize,
      `${fullSize} -> ${halfSize}`,
    ),
    probe(
      'FOMC day is a macro day',
      macroGate('2026-09-16').macroDay,
      macroGate('2026-09-16').reason,
    ),
    probe(
      'a mid-year loosening of the loss cap is refused',
      midYearLooseningRefused(),
      `tighten £${SMOKE_LOSS_CAP_GBP} to £${SMOKE_LOSS_CAP_GBP + 1}`,
    ),
    probe(
      'CFD shorts fail closed: the unverified resting stop refuses, then no catalogue refuses',
      shortRefusal(cfdEntryRefusal) === 'cfd_resting_stop_unverified' &&
        shortRefusal(() => undefined) === 'no_catalogue',
      `${shortRefusal(cfdEntryRefusal)}, ${shortRefusal(() => undefined)}`,
    ),
    probe(
      'the four CFD cost models are set from the sourced Saxo tariff (#1850)',
      CFD_COST_PARAMETERS.every((parameter) => isSet(parameter)),
      CFD_COST_PARAMETERS.map((parameter) => parameter.name).join(', '),
    ),
    probe(
      'every still-open David-owned parameter is unset',
      STILL_UNSET_PARAMETERS.every((parameter) => !isSet(parameter)),
      STILL_UNSET_PARAMETERS.map((parameter) => parameter.name).join(', '),
    ),
    probe(
      'arm 2 entry thresholds are approved and resolved (#1773)',
      isSet(ARM2_ENTRY_THRESHOLDS),
      JSON.stringify(ARM2_ENTRY_THRESHOLDS.value),
    ),
    probe(
      'LSE liquidity screen is resolved at 750k GBP (#1774)',
      isSet(LSE_LIQUIDITY_SCREEN) && LSE_LIQUIDITY_SCREEN.value === 750_000,
      String(LSE_LIQUIDITY_SCREEN.value),
    ),
    probe(
      'G18 shadows are declared but not instantiated',
      ['debate/no-sentiment', 'debate/no-social', 'debate/large-cap-only'].every((id) =>
        declaredBooks.some((spec) => spec.id === id && !spec.instantiated),
      ),
      declaredBooks.map((spec) => `${spec.id}${spec.instantiated ? '' : ' (declared)'}`).join(', '),
    ),
    probe(
      'no debate-sleeve paper trade until arm 2 runs beside it (#1773 kill line)',
      killLineEnforced(),
      'assertArm2RunsBesideDebate([debate]) refused without arm2',
    ),
  ];
}

function shortRefusal(entryRefusal: () => string | undefined): string | undefined {
  const choice = createVenueRouter({
    catalogue: undefined,
    entryRefusal,
    maxBorrowRatePerYear: CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  }).route('AAPL', 'alpaca', 'short', SMOKE_TRADING_DATE);
  return 'refusal' in choice ? choice.refusal : undefined;
}

function killLineEnforced(): boolean {
  try {
    assertArm2RunsBesideDebate(
      [{ id: DEBATE_SLEEVE_ID, spec: DEBATE_SLEEVE_SPEC }],
      DEBATE_SLEEVE_ID,
      ARM2_SLEEVE_ID,
    );
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      /no debate-sleeve paper trade until arm 2 runs beside it/.test(error.message)
    );
  }
}

function keylessPaperRunRefused(): boolean {
  try {
    composeV2Root({ tradingDate: SMOKE_TRADING_DATE, dryRun: false, storePath: ':memory:' });
    return false;
  } catch (error) {
    return error instanceof Error && /without NOUS_BASE_URL and a Nous key/.test(error.message);
  }
}

function unaffordableEntries(store: StoreHandle): number {
  const row = store
    .prepare(
      `SELECT COUNT(*) AS n FROM v2_orders
       WHERE leg = 'entry' AND trading_date = ? AND outcome = 'rejected'
         AND json_extract(payload, '$.detail') = 'insufficient_cash'`,
    )
    .get(SMOKE_TRADING_DATE) as { n: number };
  return row.n;
}

function settledEntries(store: StoreHandle): { filled: number; cancelled: number } {
  return store
    .prepare(
      `SELECT
         SUM(EXISTS (SELECT 1 FROM v2_fills f WHERE f.client_order_id = o.client_order_id)) AS filled,
         SUM(o.outcome = 'cancelled') AS cancelled
       FROM v2_orders o WHERE o.leg = 'entry' AND o.trading_date = ?`,
    )
    .get(SMOKE_TRADING_DATE) as { filled: number; cancelled: number };
}

export async function runV2Smoke(): Promise<{ probes: SmokeProbe[]; passed: boolean }> {
  const probes = staticProbes();
  const store = seededSmokeStore();
  const dryRunOn = (tradingDate: string) =>
    composeV2Root({
      tradingDate,
      dryRun: true,
      store,
      clock: new SimulatedClock(new Date(`${tradingDate}T07:00:00.000Z`)),
      logger: { log: () => {} },
    });
  const root = dryRunOn(SMOKE_TRADING_DATE);
  try {
    const report = await root.run();
    const unaffordable = unaffordableEntries(store);
    const llmCalls = root.scriptedTransports.reduce(
      (n, transport) => n + transport.calls.length,
      0,
    );
    const spendRows = root.db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get() as { n: number };
    probes.push(
      probe(
        'registry holds the debate sleeve and arm 2, beside each other',
        root.registry.ids().join(',') === 'debate,arm2',
        root.registry.ids().join(','),
      ),
      probe(
        'dry run submitted zero orders',
        report.submitted_orders === 0,
        `submitted=${report.submitted_orders} refused=${report.dry_run_refusals} entries=${report.entries}`,
      ),
      probe(
        'dry run debated the liquidity core',
        report.decisions > 0,
        `${report.decisions} decisions`,
      ),
      probe(
        'every LLM call is journalled',
        llmCalls > 0 && spendRows.n === llmCalls,
        `${llmCalls} calls, ${spendRows.n} llm_spend rows`,
      ),
      probe(
        'debate and arm 2 each have their own paper books',
        root.books.ids().join(',') === 'debate/primary,debate/no-macro-gate,arm2/technical-only',
        root.books.ids().join(', '),
      ),
      probe(
        'every still-open parameter is journalled as a refusal',
        PAPER_REFUSED_PARAMETERS.every((parameter) =>
          report.refusals.some((refusal) => refusal.includes(parameter.name)),
        ),
        report.refusals.join(' | '),
      ),
      probe(
        'entries reach the dry-run broker and every one is refused or turned away for cash',
        report.entries > 0 &&
          report.dry_run_refusals > 0 &&
          report.rejected_orders === unaffordable,
        `entries=${report.entries} refused=${report.dry_run_refusals} simulated=${report.simulated_orders} unaffordable=${unaffordable}`,
      ),
      probe(
        'dry run fills nothing on the day it enters',
        report.fills === 0,
        `${report.fills} fills`,
      ),
      probe(
        'a paper run without LLM keys is refused for that reason',
        keylessPaperRunRefused(),
        'composeV2Root threw /without NOUS_BASE_URL and a Nous key/',
      ),
    );
    const next = await dryRunOn(SMOKE_NEXT_DATE).run();
    const { filled, cancelled } = settledEntries(store);
    probes.push(
      probe(
        'every affordable entry fills or is cancelled on the next bar, and fills reach the books',
        filled > 0 &&
          filled + cancelled + unaffordable === report.entries &&
          next.books.some((b) => b.positions > 0),
        `${filled} filled, ${cancelled} cancelled of ${report.entries}; ${next.books
          .map((book) => `${book.book_id}: ${book.positions} positions`)
          .join(', ')}`,
      ),
    );
  } finally {
    root.close();
  }
  return { probes, passed: probes.every((entry) => entry.passed) };
}

export function printSmoke(
  result: { probes: readonly SmokeProbe[]; passed: boolean },
  write: (line: string) => void,
): number {
  for (const entry of result.probes) {
    write(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.name} — ${entry.detail}\n`);
  }
  write(`v2 smoke: ${result.passed ? 'GREEN' : 'RED'}\n`);
  return result.passed ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runV2Smoke()
    .then((result) => process.exit(printSmoke(result, (line) => process.stdout.write(line))))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    });
}
