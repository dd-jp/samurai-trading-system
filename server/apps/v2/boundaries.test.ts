import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const V2 = join(REPO, 'server/apps/v2');
const RULE = 'no-restricted-imports';

interface OxlintConfig {
  rules: Record<string, unknown>;
  overrides: { files: string[]; rules?: Record<string, unknown> }[];
}

function importRulesOnly(): OxlintConfig {
  const real = JSON.parse(readFileSync(join(REPO, '.oxlintrc.json'), 'utf8')) as OxlintConfig;
  return {
    rules: { [RULE]: real.rules[RULE] },
    overrides: real.overrides
      .filter((override) => override.rules?.[RULE] !== undefined)
      .map((override) => ({ files: override.files, rules: { [RULE]: override.rules?.[RULE] } })),
  };
}

const FIXTURES: Record<string, string> = {
  'risk/imports-signal.ts': "export { SleeveRegistry } from '../signal/index.js';",
  'risk/imports-v1-broker.ts':
    "export type { BrokerAdapter } from '../../../pipeline/execution/index.js';",
  'risk/deep-execution.ts': "export { V2OrderExecutor } from '../execution/executor.js';",
  'data/imports-risk.ts': "export { PaperBooks } from '../risk/index.js';",
  'journal/imports-data.ts': "export { macroGate } from '../data/index.js';",
  'data/via-v2-dir.ts': "export { PaperBooks } from '../../v2/risk/index.js';",
  'data/via-dot-segment.ts': "export { PaperBooks } from '.././risk/index.js';",
  'journal/via-apps-dir.ts': "export { macroGate } from '../../../apps/v2/data/index.js';",
  'execution/imports-signal.ts': "export { SleeveRegistry } from '../signal/index.js';",
  'signal/imports-execution.ts': "export { createOrderExecutor } from '../execution/index.js';",
  'cycle.ts': "export { V2RiskGate } from './risk/index.js';",
  'risk/clean.ts': "export { macroGate } from '../data/index.js';",
  'signal/clean.ts': "export { STOP_ATR_MULTIPLE } from '../risk/index.js';",
  'execution/clean.ts':
    "export type { BrokerAdapter } from '../../../pipeline/execution/index.js';\nexport { consumeApproval } from '../risk/index.js';",
  'index.ts': "export { createOrderExecutor } from './execution/index.js';",
};

let root: string;
let byFile: Map<string, string[]>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'v2-boundaries-'));
  writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify(importRulesOnly()));
  for (const [path, source] of Object.entries(FIXTURES)) {
    const file = join(root, 'server/apps/v2', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${source}\n`);
  }
  const run = spawnSync(join(REPO, 'node_modules/.bin/oxlint'), ['-f', 'json', 'server/apps/v2'], {
    cwd: root,
    encoding: 'utf8',
  });
  const report = JSON.parse(run.stdout) as {
    diagnostics: { filename: string; help?: string }[];
  };
  byFile = new Map();
  for (const diagnostic of report.diagnostics) {
    const file = relative('server/apps/v2', diagnostic.filename);
    byFile.set(file, [...(byFile.get(file) ?? []), diagnostic.help ?? '']);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('v2 module boundaries (oxlint)', () => {
  it.each([
    ['risk/imports-signal.ts', 'v2 risk may not import v2 signal'],
    ['risk/imports-v1-broker.ts', 'only server/apps/v2/execution may reach the v1 broker adapters'],
    ['risk/deep-execution.ts', 'v2 risk may not import v2 execution'],
    ['risk/deep-execution.ts', 'reach server/apps/v2/execution only via its index.ts barrel'],
    ['data/imports-risk.ts', 'v2 data may not import v2 risk'],
    ['journal/imports-data.ts', 'v2 journal may not import v2 data'],
    ['data/via-v2-dir.ts', 'v2 data may not import v2 risk'],
    ['data/via-dot-segment.ts', 'v2 data may not import v2 risk'],
    ['journal/via-apps-dir.ts', 'v2 journal may not import v2 data'],
    ['execution/imports-signal.ts', 'v2 execution may not import v2 signal'],
    ['signal/imports-execution.ts', 'v2 signal may not import v2 execution'],
    ['cycle.ts', 'v2 cycle may not import v2 risk'],
  ])('%s fails with "%s"', (file, message) => {
    expect(byFile.get(file) ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining(message)]),
    );
  });

  it('passes the allowed edges', () => {
    for (const file of ['risk/clean.ts', 'signal/clean.ts', 'execution/clean.ts', 'index.ts']) {
      expect(byFile.get(file), file).toBeUndefined();
    }
  });
});

function productionSources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(directory, name))
    .sort();
}

describe('RiskApprovedOrder provenance', () => {
  it('is minted or cast only inside the risk module', () => {
    const offenders = productionSources(V2)
      .filter((file) => !relative(V2, file).startsWith('risk/'))
      .filter((file) => /mintApproval|as RiskApprovedOrder/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });
});

const CAPITAL_LITERAL =
  /\b(\w*(?:capital|CAPITAL|Capital|lossCap|LOSS_CAP|_CAP_GBP|CapGbp)\w*)\s*[:=]\s*-?\d[\d_]*(?:\.\d+)?\b/g;
const ALLOWED_CAPITAL_LITERALS = new Set([
  'server/apps/v2/risk/loss-budget.ts:DAILY_CAP_FRACTION_OF_START_CAPITAL',
  'server/apps/v2/signal/parameters.ts:minimumCapitalGbp',
  'server/apps/v2/smoke.ts:SMOKE_START_CAPITAL_GBP',
  'server/apps/v2/smoke.ts:SMOKE_LOSS_CAP_GBP',
  'server/apps/v2/backtest-verdict.ts:CAPITAL_CEILING_DRAWDOWN_MULTIPLE',
]);

describe('capital literals', () => {
  it('appear nowhere in v2 or contracts outside the capital config', () => {
    const found: string[] = [];
    for (const file of [...productionSources(V2), ...productionSources(join(REPO, 'contracts'))]) {
      for (const match of readFileSync(file, 'utf8').matchAll(CAPITAL_LITERAL)) {
        found.push(`${relative(REPO, file)}:${match[1]}`);
      }
    }
    expect(found.filter((entry) => !ALLOWED_CAPITAL_LITERALS.has(entry))).toEqual([]);
    expect([...ALLOWED_CAPITAL_LITERALS].filter((entry) => !found.includes(entry))).toEqual([]);
  });

  it('the scan catches a start-capital constant', () => {
    expect('export const START_CAPITAL_GBP = 1_000;'.match(CAPITAL_LITERAL)).toHaveLength(1);
    expect('{ startCapitalGbp: 2000, lossCapGbp: 1500 }'.match(CAPITAL_LITERAL)).toHaveLength(2);
  });
});
