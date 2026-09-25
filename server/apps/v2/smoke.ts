import { pathToFileURL } from 'node:url';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { macroGate } from './data/index.js';
import { composeV2Root } from './index.js';
import { BOOK_SPECS, positionSizeShares } from './risk/index.js';
import {
  ALL_PINS,
  DECLARED_PARAMETERS,
  isSet,
  SHORTS_ENABLED,
  SqliteMonthlySpendCap,
} from './signal/index.js';

export interface SmokeProbe {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export const SMOKE_TRADING_DATE = '2026-09-24';

function probe(name: string, passed: boolean, detail: string): SmokeProbe {
  return { name, passed, detail };
}

function staticProbes(): SmokeProbe[] {
  const size = {
    equityGbp: 1_000,
    riskFraction: 0.005,
    priceGbp: 10,
    atrGbp: 0.25,
    sizeMultiplier: 1,
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
    probe('shorts are off', !SHORTS_ENABLED, String(SHORTS_ENABLED)),
    probe(
      'every David-owned parameter is still unset',
      DECLARED_PARAMETERS.every((parameter) => !isSet(parameter)),
      DECLARED_PARAMETERS.map((parameter) => parameter.name).join(', '),
    ),
    probe(
      'G18 shadows and momentum/no-veto are declared but not instantiated',
      [
        'debate/no-sentiment',
        'debate/no-social',
        'debate/large-cap-only',
        'momentum/no-veto',
      ].every((id) => BOOK_SPECS.some((spec) => spec.id === id && !spec.instantiated)),
      BOOK_SPECS.map((spec) => `${spec.id}${spec.instantiated ? '' : ' (declared)'}`).join(', '),
    ),
  ];
}

function keylessPaperRunRefused(): boolean {
  try {
    composeV2Root({ tradingDate: SMOKE_TRADING_DATE, dryRun: false, storePath: ':memory:' });
    return false;
  } catch (error) {
    return error instanceof Error && /without NOUS_BASE_URL and a Nous key/.test(error.message);
  }
}

export async function runV2Smoke(): Promise<{ probes: SmokeProbe[]; passed: boolean }> {
  const probes = staticProbes();
  const root = composeV2Root({
    tradingDate: SMOKE_TRADING_DATE,
    dryRun: true,
    storePath: ':memory:',
    clock: new SimulatedClock(new Date(`${SMOKE_TRADING_DATE}T07:00:00.000Z`)),
    logger: { log: () => {} },
  });
  try {
    const report = await root.run();
    const llmCalls = root.scriptedTransports.reduce(
      (n, transport) => n + transport.calls.length,
      0,
    );
    const spendRows = root.db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get() as { n: number };
    probes.push(
      probe(
        'registry holds the debate sleeve only',
        root.registry.ids().join(',') === 'debate',
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
        'primary and no-macro-gate each have their own paper book',
        root.books.ids().join(',') === 'debate/primary,debate/no-macro-gate',
        root.books.ids().join(', '),
      ),
      probe(
        'every unset parameter is journalled as a refusal',
        DECLARED_PARAMETERS.every((parameter) =>
          report.refusals.some((refusal) => refusal.includes(parameter.name)),
        ),
        report.refusals.join(' | '),
      ),
      probe(
        'entries reach the dry-run broker and every one is refused',
        report.entries > 0 && report.dry_run_refusals > 0 && report.rejected_orders === 0,
        `entries=${report.entries} refused=${report.dry_run_refusals} simulated=${report.simulated_orders}`,
      ),
      probe(
        'simulated fills reach the books',
        report.fills === report.entries && report.books.every((book) => book.positions > 0),
        report.books.map((book) => `${book.book_id}: ${book.positions} positions`).join(', '),
      ),
      probe(
        'a paper run without LLM keys is refused for that reason',
        keylessPaperRunRefused(),
        'composeV2Root threw /without NOUS_BASE_URL and a Nous key/',
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
