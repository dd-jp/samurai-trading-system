import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assignShards,
  breakThresholdOf,
  getAddedLineRanges,
  getChangedFiles,
  INCREMENTAL_FILE,
  isMutableProductionFile,
  isTradingPathFile,
  type LineRange,
  type MutateTarget,
  type MutationGateDeps,
  type MutationReport,
  mutatePattern,
  mutateTargets,
  parseAddedLineRanges,
  parseChangedFiles,
  parseGateArgs,
  partitionChangedFiles,
  resolveMergeBase,
  runMutationGate,
  type StrykerRun,
  scopeShardReports,
  scoreReport,
  shardReportFile,
  TRADING_PATH_PREFIXES,
  testFilesGlob,
} from './mutation-local.js';

describe('isMutableProductionFile', () => {
  it.each([
    ['server/pipeline/risk-manager/breakers.ts', true],
    ['contracts/pipeline.ts', true],
    ['server/pipeline/risk-manager/breakers.test.ts', false],
    ['client/src/App.tsx', false],
    ['server/tools/mutation-local.ts', false],
    ['docs/coding-standards.md', false],
    ['server/pipeline/risk-manager/README', false],
  ])('%s -> %s', (path, expected) => {
    expect(isMutableProductionFile(path)).toBe(expected);
  });
});

describe('isTradingPathFile', () => {
  it.each(TRADING_PATH_PREFIXES)('files under %s are trading-path', (prefix) => {
    expect(isTradingPathFile(`${prefix}index.ts`)).toBe(true);
  });

  it.each([
    'server/pipeline/analysts/index.ts',
    'server/pipeline/debate-engine/index.ts',
    'server/pipeline/feedback-loop/index.ts',
    'server/providers/market-data-service/index.ts',
  ])('%s is not trading-path', (path) => {
    expect(isTradingPathFile(path)).toBe(false);
  });
});

describe('risk, sizing and loss-budget paths', () => {
  it.each([
    'server/apps/v2/risk/position-size.ts',
    'server/apps/v2/cycle.ts',
    'server/apps/v2/split.ts',
    'server/apps/v2/reconcile.ts',
    'server/apps/v2/reconcile-compare.ts',
    'server/pipeline/momentum/loss-budget.ts',
    'server/pipeline/momentum/sizing.ts',
  ])('%s is trading-path', (path) => {
    expect(isTradingPathFile(path)).toBe(true);
  });

  it.each([
    'server/apps/v2/execution/alpaca/alpaca-adapter.ts',
    'server/apps/v2/execution/broker-state/sqlite-broker-state-store.ts',
    'server/apps/v2/execution/saxo/saxo-token-source.ts',
  ])('%s, moved out of server/pipeline/execution, is trading-path', (path) => {
    expect(isTradingPathFile(path)).toBe(true);
  });

  it('leaves the rest of momentum out', () => {
    expect(isTradingPathFile('server/pipeline/momentum/signal.ts')).toBe(false);
  });

  it.each([
    'server/apps/v2/index.ts',
    'server/apps/v2/daily-summary.ts',
    'server/apps/v2/smoke.ts',
    'server/apps/v2/execution/executor.ts',
  ])('leaves %s out of the rest of apps/v2', (path) => {
    expect(isTradingPathFile(path)).toBe(false);
  });
});

describe('testFilesGlob', () => {
  it('globs every test under a directory prefix', () => {
    expect(testFilesGlob('server/apps/v2/risk/')).toBe('server/apps/v2/risk/**/*.test.ts');
  });

  it('names the sibling test of a single-file prefix', () => {
    expect(testFilesGlob('server/pipeline/momentum/sizing.ts')).toBe(
      'server/pipeline/momentum/sizing.test.ts',
    );
  });
});

const GATE = 'server/apps/v2/risk/gate.ts';

function mutant(line: number, status: string, endLine = line) {
  return { status, location: { start: { line, column: 0 }, end: { line: endLine, column: 9 } } };
}

function report(file: string, mutants: readonly ReturnType<typeof mutant>[]): MutationReport {
  return {
    schemaVersion: '2',
    files: { [file]: { language: 'typescript', source: 'src', mutants } },
    testFiles: { [`${file}.test`]: { tests: [] } },
  } as unknown as MutationReport;
}

interface GateFixture {
  readonly changed?: readonly string[];
  readonly ranges?: Readonly<Record<string, readonly LineRange[]>>;
  readonly status?: number | null;
  readonly reports?: Readonly<Record<string, MutationReport>>;
}

function gateDeps({ changed = [], ranges = {}, status = 0, reports = {} }: GateFixture = {}) {
  const lines: string[] = [];
  const baseRefs: string[] = [];
  const runs: StrykerRun[] = [];
  const written = new Map<string, MutationReport>();
  const deps: MutationGateDeps = {
    changedFiles: (baseRef) => {
      baseRefs.push(baseRef);
      return changed;
    },
    addedLines: () => new Map(Object.entries(ranges)),
    stryker: (run) => {
      runs.push(run);
      return { status };
    },
    readReport: (path) => reports[path],
    writeReport: (path, value) => written.set(path, value),
    breakThreshold: 80,
    log: (line) => lines.push(line),
  };
  return { deps, lines, baseRefs, runs, written };
}

describe('parseGateArgs', () => {
  it.each([
    [['--help'], { mode: 'help', baseRef: 'origin/main' }],
    [['-h'], { mode: 'help', baseRef: 'origin/main' }],
    [['--list'], { mode: 'list', baseRef: 'origin/main' }],
    [['--list', 'base'], { mode: 'list', baseRef: 'base' }],
    [[], { mode: 'run', baseRef: 'origin/main' }],
    [['base'], { mode: 'run', baseRef: 'base' }],
    [['--shard', '2/4', 'base'], { mode: 'run', baseRef: 'base', shard: { index: 2, count: 4 } }],
    [
      ['--list', '--shard', '1/1'],
      { mode: 'list', baseRef: 'origin/main', shard: { index: 1, count: 1 } },
    ],
    [['--merge', '4'], { mode: 'merge', baseRef: 'origin/main', mergeCount: 4 }],
  ])('%j parses to %j', (args, expected) => {
    expect(parseGateArgs(args)).toEqual(expected);
  });

  it.each([['0/4'], ['5/4'], ['two/4'], ['1']])('refuses --shard %s', (shard) => {
    expect(() => parseGateArgs(['--shard', shard])).toThrow('--shard wants i/n');
  });

  it.each([['0'], ['1.5'], ['x']])('refuses --merge %s', (count) => {
    expect(() => parseGateArgs(['--merge', count])).toThrow('--merge wants a shard count');
  });
});

describe('parseAddedLineRanges', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -3,0 +4,2 @@ ctx',
    '+x',
    '+y',
    '@@ -9 +11 @@',
    '-old',
    '+new',
    '@@ -12,2 +13,0 @@',
    '-gone',
    '@@ -20,1 +6,1 @@',
    'diff --git a/b.ts b/b.ts',
    '--- /dev/null',
    '+++ b/b.ts',
    '@@ -0,0 +1,3 @@',
    'diff --git a/c.ts b/c.ts',
    '--- a/c.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
  ].join('\n');

  it('turns each added hunk into a line range, merging adjacent ones and dropping deletions', () => {
    expect(parseAddedLineRanges(diff)).toEqual(
      new Map([
        [
          'a.ts',
          [
            { start: 4, end: 6 },
            { start: 11, end: 11 },
          ],
        ],
        ['b.ts', [{ start: 1, end: 3 }]],
      ]),
    );
  });

  it('keeps separate ranges that do not touch', () => {
    const ranges = parseAddedLineRanges('+++ b/a.ts\n@@ -1 +1 @@\n@@ -3 +3 @@');
    expect(ranges.get('a.ts')).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
    ]);
  });

  it('attributes hunks of a renamed file to its new path and ignores a pure rename', () => {
    const renamed = [
      'diff --git a/old/a.ts b/new/a.ts',
      'similarity index 90%',
      'rename from old/a.ts',
      'rename to new/a.ts',
      'index 1111111..2222222 100644',
      '--- a/old/a.ts',
      '+++ b/new/a.ts',
      '@@ -4 +4,2 @@',
      '-x',
      '+y',
      '+z',
      'diff --git a/old/b.ts b/new/b.ts',
      'similarity index 100%',
      'rename from old/b.ts',
      'rename to new/b.ts',
      'diff --git a/c.ts b/c.ts',
      '--- a/c.ts',
      '+++ b/c.ts',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(parseAddedLineRanges(renamed)).toEqual(
      new Map([
        ['new/a.ts', [{ start: 4, end: 5 }]],
        ['c.ts', [{ start: 1, end: 1 }]],
      ]),
    );
  });

  it('ignores hunks before any file header', () => {
    expect(parseAddedLineRanges('@@ -1 +1 @@')).toEqual(new Map());
  });
});

describe('mutateTargets and mutatePattern', () => {
  it('emits one Stryker line-range pattern per range, skipping files with no added lines', () => {
    const targets = mutateTargets(
      ['a.ts', 'b.ts'],
      new Map([
        [
          'a.ts',
          [
            { start: 1, end: 2 },
            { start: 9, end: 9 },
          ],
        ],
      ]),
    );
    expect(targets.map(mutatePattern)).toEqual(['a.ts:1-2', 'a.ts:9-9']);
  });
});

describe('assignShards', () => {
  const target = (file: string, start: number, end: number): MutateTarget => ({
    file,
    range: { start, end },
  });

  it('balances line counts greedily, heaviest first', () => {
    const shards = assignShards(
      [target('a.ts', 1, 100), target('b.ts', 1, 60), target('c.ts', 1, 50), target('d.ts', 1, 10)],
      2,
    );
    expect(shards.map((shard) => shard.map(mutatePattern))).toEqual([
      ['a.ts:1-100', 'd.ts:1-10'],
      ['b.ts:1-60', 'c.ts:1-50'],
    ]);
  });

  it('is deterministic for equal weights and leaves surplus shards empty', () => {
    const shards = assignShards([target('b.ts', 1, 1), target('a.ts', 1, 1)], 3);
    expect(shards.map((shard) => shard.map(mutatePattern))).toEqual([
      ['a.ts:1-1'],
      ['b.ts:1-1'],
      [],
    ]);
  });
});

describe('scopeShardReports and scoreReport', () => {
  it("keeps only mutants wholly inside each shard's own ranges", () => {
    const merged = scopeShardReports([
      {
        targets: [{ file: GATE, range: { start: 10, end: 12 } }],
        report: report(GATE, [
          mutant(10, 'Killed'),
          mutant(12, 'Survived', 13),
          mutant(40, 'Survived'),
        ]),
      },
      {
        targets: [{ file: GATE, range: { start: 40, end: 40 } }],
        report: report(GATE, [mutant(10, 'Survived'), mutant(40, 'Timeout')]),
      },
    ]);
    expect(merged.files[GATE]?.mutants.map((m) => m.status)).toEqual(['Killed', 'Timeout']);
    expect(merged.testFiles).toEqual({ [`${GATE}.test`]: { tests: [] } });
  });

  it('adds no file entry for a target file the report has no mutants for', () => {
    const merged = scopeShardReports([
      {
        targets: [
          { file: GATE, range: { start: 1, end: 1 } },
          { file: 'types.ts', range: { start: 1, end: 3 } },
        ],
        report: report(GATE, [mutant(1, 'Killed')]),
      },
    ]);
    expect(Object.keys(merged.files)).toEqual([GATE]);
    expect(merged.files[GATE]?.source).toBe('src');
  });

  it("rewrites each shard's run-local test ids to one stable key per test", () => {
    const shardReport = (ids: readonly [string, string], killer: string): MutationReport =>
      ({
        files: {
          [GATE]: {
            source: 'src',
            mutants: [{ ...mutant(1, 'Killed'), killedBy: [killer], coveredBy: [ids[0], ids[1]] }],
          },
        },
        testFiles: {
          't.test.ts': {
            tests: [
              { id: ids[0], name: 'first', location: { start: { line: 3 } } },
              { id: ids[1], name: 'second', location: { start: { line: 9 } } },
            ],
          },
        },
      }) as unknown as MutationReport;
    const merged = scopeShardReports([
      {
        targets: [{ file: GATE, range: { start: 1, end: 1 } }],
        report: shardReport(['0', '1'], '0'),
      },
      { targets: [], report: shardReport(['1', '0'], '1') },
    ]);
    expect(merged.files[GATE]?.mutants[0]?.killedBy).toEqual(['t.test.ts#first#3']);
    expect(merged.files[GATE]?.mutants[0]?.coveredBy).toEqual([
      't.test.ts#first#3',
      't.test.ts#second#9',
    ]);
    expect(merged.testFiles?.['t.test.ts']?.tests.map((test) => test.id)).toEqual([
      't.test.ts#first#3',
      't.test.ts#second#9',
    ]);
  });

  it('scores killed and timed-out over every valid mutant, ignoring errors and ignored ones', () => {
    const scored = scoreReport(
      report(GATE, [
        mutant(1, 'Killed'),
        mutant(2, 'Timeout'),
        mutant(3, 'Survived'),
        mutant(4, 'NoCoverage'),
        mutant(5, 'CompileError'),
        mutant(6, 'RuntimeError'),
        mutant(7, 'Ignored'),
      ]),
    );
    expect(scored).toEqual({ detected: 2, undetected: 2, score: 50 });
  });

  it('has no score when nothing valid was mutated', () => {
    expect(scoreReport(report(GATE, [mutant(1, 'Ignored')])).score).toBeUndefined();
  });
});

describe('breakThresholdOf', () => {
  it('reads a numeric break threshold', () => {
    expect(breakThresholdOf({ default: { thresholds: { break: 80 } } })).toBe(80);
  });

  it.each([[null], [undefined], [Number.NaN], ['80']])(
    'refuses a break threshold of %s',
    (value) => {
      expect(() => breakThresholdOf({ default: { thresholds: { break: value } } })).toThrow(
        'thresholds.break must be a number',
      );
    },
  );
});

describe('runMutationGate', () => {
  it('prints help without reading the diff', () => {
    const { deps, lines, baseRefs } = gateDeps();
    expect(runMutationGate(['--help'], deps)).toBe(0);
    expect(lines[0]).toMatch(/^Usage: npm run mutation:local/);
    expect(baseRefs).toEqual([]);
  });

  it('lists the changed trading-path ranges and mutates nothing', () => {
    const { deps, lines, baseRefs, runs } = gateDeps({
      changed: ['server/pipeline/execution/execute.ts', 'server/pipeline/analysts/index.ts'],
      ranges: {
        'server/pipeline/execution/execute.ts': [{ start: 3, end: 5 }],
        'server/pipeline/analysts/index.ts': [{ start: 1, end: 1 }],
      },
    });
    expect(runMutationGate(['--list', 'base'], deps)).toBe(0);
    expect(lines).toEqual(['server/pipeline/execution/execute.ts:3-5']);
    expect(baseRefs).toEqual(['base']);
    expect(runs).toEqual([]);
  });

  it('lists only the asked shard', () => {
    const { deps, lines } = gateDeps({
      changed: [GATE],
      ranges: {
        [GATE]: [
          { start: 1, end: 9 },
          { start: 20, end: 20 },
        ],
      },
    });
    runMutationGate(['--list', '--shard', '2/2'], deps);
    expect(lines).toEqual([`${GATE}:20-20`]);
  });

  it('defaults the base ref to origin/main', () => {
    const { deps, baseRefs } = gateDeps();
    runMutationGate([], deps);
    expect(baseRefs).toEqual(['origin/main']);
  });

  it('skips Stryker when no trading-path file changed', () => {
    const { deps, lines, runs } = gateDeps({ changed: ['server/pipeline/analysts/index.ts'] });
    expect(runMutationGate(['base'], deps)).toBe(0);
    expect(runs).toEqual([]);
    expect(lines.at(-1)).toBe(
      'No trading-path lines changed vs base in this run — mutation gate skipped.',
    );
  });

  it('skips Stryker when a trading-path file only lost lines', () => {
    const { deps, runs } = gateDeps({ changed: [GATE], ranges: {} });
    expect(runMutationGate(['base'], deps)).toBe(0);
    expect(runs).toEqual([]);
  });

  it('mutates the changed ranges into the incremental file and scores only them', () => {
    const { deps, runs, written, lines } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 2 }] },
      reports: {
        [INCREMENTAL_FILE]: report(GATE, [
          mutant(1, 'Killed'),
          mutant(2, 'Killed'),
          mutant(50, 'Survived'),
        ]),
      },
    });
    expect(runMutationGate(['base'], deps)).toBe(0);
    expect(runs).toEqual([{ patterns: [`${GATE}:1-2`], incrementalFile: INCREMENTAL_FILE }]);
    expect(written.get(INCREMENTAL_FILE)?.files[GATE]?.mutants).toHaveLength(2);
    expect(lines.at(-1)).toBe(
      'Mutation score on changed lines: 100.00 (2 / 2 valid mutants), break at 80',
    );
  });

  it('fails below the break threshold', () => {
    const { deps } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 5 }] },
      reports: {
        [INCREMENTAL_FILE]: report(GATE, [
          mutant(1, 'Killed'),
          mutant(2, 'Killed'),
          mutant(3, 'Killed'),
          mutant(4, 'Survived'),
          mutant(5, 'NoCoverage'),
        ]),
      },
    });
    expect(runMutationGate(['base'], deps)).toBe(1);
  });

  it('passes at exactly the break threshold', () => {
    const { deps } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 5 }] },
      reports: {
        [INCREMENTAL_FILE]: report(GATE, [
          mutant(1, 'Killed'),
          mutant(2, 'Killed'),
          mutant(3, 'Killed'),
          mutant(4, 'Timeout'),
          mutant(5, 'Survived'),
        ]),
      },
    });
    expect(runMutationGate(['base'], deps)).toBe(0);
  });

  it('passes when the changed lines hold no valid mutant', () => {
    const { deps } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 1 }] },
      reports: { [INCREMENTAL_FILE]: report(GATE, []) },
    });
    expect(runMutationGate(['base'], deps)).toBe(0);
  });

  it('fails when Stryker leaves no report', () => {
    const { deps, lines } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 1 }] },
    });
    expect(runMutationGate(['base'], deps)).toBe(1);
    expect(lines.at(-1)).toBe(`Missing mutation report(s): ${INCREMENTAL_FILE}`);
  });

  it('returns Stryker’s failing status without scoring', () => {
    const { deps, written } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 1 }] },
      status: 2,
    });
    expect(runMutationGate(['base'], deps)).toBe(2);
    expect(written.size).toBe(0);
  });

  it('fails when Stryker exits without a status', () => {
    const { deps } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 1 }] },
      status: null,
    });
    expect(runMutationGate(['base'], deps)).toBe(1);
  });

  it('rethrows a spawn error', () => {
    const { deps } = gateDeps({ changed: [GATE], ranges: { [GATE]: [{ start: 1, end: 1 }] } });
    const failing: MutationGateDeps = {
      ...deps,
      stryker: () => ({ error: new Error('no stryker'), status: null }),
    };
    expect(() => runMutationGate(['base'], failing)).toThrow('no stryker');
  });

  it('runs one shard into its own report without scoring it', () => {
    const { deps, runs, written } = gateDeps({
      changed: [GATE],
      ranges: {
        [GATE]: [
          { start: 1, end: 9 },
          { start: 20, end: 20 },
        ],
      },
    });
    expect(runMutationGate(['--shard', '2/2', 'base'], deps)).toBe(0);
    expect(runs).toEqual([{ patterns: [`${GATE}:20-20`], incrementalFile: shardReportFile(2) }]);
    expect(written.size).toBe(0);
  });

  it('skips an empty shard', () => {
    const { deps, runs } = gateDeps({
      changed: [GATE],
      ranges: { [GATE]: [{ start: 1, end: 1 }] },
    });
    expect(runMutationGate(['--shard', '3/3'], deps)).toBe(0);
    expect(runs).toEqual([]);
  });

  describe('--merge', () => {
    const ranges = {
      [GATE]: [
        { start: 1, end: 9 },
        { start: 20, end: 20 },
      ],
    };

    it('scores every non-empty shard together and writes the merged incremental file', () => {
      const { deps, written, lines } = gateDeps({
        changed: [GATE],
        ranges,
        reports: {
          [shardReportFile(1)]: report(GATE, [mutant(1, 'Killed'), mutant(20, 'Survived')]),
          [shardReportFile(2)]: report(GATE, [mutant(20, 'Killed'), mutant(1, 'Survived')]),
        },
      });
      expect(runMutationGate(['--merge', '4'], deps)).toBe(0);
      expect(written.get(INCREMENTAL_FILE)?.files[GATE]?.mutants.map((m) => m.status)).toEqual([
        'Killed',
        'Killed',
      ]);
      expect(lines.at(-1)).toBe(
        'Mutation score on changed lines: 100.00 (2 / 2 valid mutants), break at 80',
      );
    });

    it('fails when a shard that had work left no report', () => {
      const { deps, lines } = gateDeps({
        changed: [GATE],
        ranges,
        reports: { [shardReportFile(1)]: report(GATE, [mutant(1, 'Killed')]) },
      });
      expect(runMutationGate(['--merge', '4'], deps)).toBe(1);
      expect(lines.at(-1)).toBe(`Missing mutation report(s): ${shardReportFile(2)}`);
    });

    it('passes with nothing to merge when no trading-path line changed', () => {
      const { deps, lines } = gateDeps();
      expect(runMutationGate(['--merge', '4'], deps)).toBe(0);
      expect(lines.at(-1)).toBe('No trading-path lines changed — mutation gate skipped.');
    });
  });
});

describe('parseChangedFiles', () => {
  it('splits git diff --name-only output, dropping blank lines', () => {
    expect(parseChangedFiles('a.ts\nb.ts\n\n c.ts \n')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns nothing for empty diff output', () => {
    expect(parseChangedFiles('')).toEqual([]);
  });
});

describe('partitionChangedFiles', () => {
  it('separates trading-path files from advisory-only files and drops non-mutable ones', () => {
    const result = partitionChangedFiles([
      'server/pipeline/risk-manager/breakers.ts',
      'server/pipeline/execution/execute.ts',
      'server/pipeline/analysts/index.ts',
      'server/pipeline/risk-manager/breakers.test.ts',
      'client/src/App.tsx',
      'server/tools/mutation-local.ts',
    ]);

    expect(result.tradingPath).toEqual([
      'server/pipeline/risk-manager/breakers.ts',
      'server/pipeline/execution/execute.ts',
    ]);
    expect(result.advisory).toEqual(['server/pipeline/analysts/index.ts']);
  });

  it('is empty in both arms when nothing mutable changed', () => {
    expect(partitionChangedFiles(['README.md', 'docs/adr/0001-x.md'])).toEqual({
      tradingPath: [],
      advisory: [],
    });
  });
});

function gitIn(repo: string, ...args: readonly string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'core.excludesFile=/dev/null', ...args], {
    stdio: 'ignore',
  });
}

function writeIn(repo: string, relPath: string, content: string): void {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('getChangedFiles against a real git repo (#1634)', () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-mutation-')));
    gitIn(repo, 'init', '-q');
    gitIn(repo, 'config', 'user.email', 'test@example.com');
    gitIn(repo, 'config', 'user.name', 'Test');
    writeIn(repo, 'server/pipeline/risk-manager/breakers.ts', 'export const x = 1;\n');
    writeIn(repo, 'server/pipeline/risk-manager/breakers.test.ts', 'it("x", () => {});\n');
    writeIn(repo, 'README.md', 'hello\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'base');
    gitIn(repo, 'branch', 'base-ref');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists only files changed since baseRef, not the whole tree', () => {
    writeIn(repo, 'server/pipeline/risk-manager/breakers.ts', 'export const x = 2;\n');
    writeIn(repo, 'server/pipeline/execution/execute.ts', 'export const y = 1;\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'change');

    const changed = getChangedFiles('base-ref', repo);

    expect(changed).toEqual(
      expect.arrayContaining([
        'server/pipeline/risk-manager/breakers.ts',
        'server/pipeline/execution/execute.ts',
      ]),
    );
    expect(changed).not.toContain('README.md');
  });

  it('excludes a file that was changed then deleted before the diff is read', () => {
    gitIn(repo, 'checkout', '-q', '-b', 'delete-branch', 'base-ref');
    writeIn(repo, 'server/pipeline/verdict/index.ts', 'export const z = 1;\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'add then delete');
    rmSync(join(repo, 'server/pipeline/verdict/index.ts'));

    const changed = getChangedFiles('base-ref', repo);

    expect(changed).not.toContain('server/pipeline/verdict/index.ts');
  });
});

describe('getChangedFiles resolves the merge-base, not a bare diff against baseRef (#1642 review)', () => {
  let repo: string;
  let headBranch: string;
  let rootSha: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-mutation-mergebase-')));
    gitIn(repo, 'init', '-q');
    gitIn(repo, 'config', 'user.email', 'test@example.com');
    gitIn(repo, 'config', 'user.name', 'Test');
    headBranch = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    writeIn(repo, 'server/pipeline/execution/shared.ts', 'export const shared = "root";\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'root');
    rootSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    gitIn(repo, 'branch', 'base-ref');

    gitIn(repo, 'checkout', '-q', 'base-ref');
    writeIn(repo, 'server/pipeline/execution/shared.ts', 'export const shared = "main-drift";\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'main drift');

    gitIn(repo, 'checkout', '-q', headBranch);
    writeIn(repo, 'server/pipeline/execution/own-change.ts', 'export const own = 1;\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'feature change');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('resolves to the commit baseRef and HEAD last shared, not baseRef itself', () => {
    expect(resolveMergeBase('base-ref', repo)).toBe(rootSha);
  });

  it('excludes a file baseRef modified after the branch point but this branch never touched', () => {
    const changed = getChangedFiles('base-ref', repo);

    expect(changed).toContain('server/pipeline/execution/own-change.ts');
    expect(changed).not.toContain('server/pipeline/execution/shared.ts');
  });

  it('still includes an uncommitted edit to an already-tracked file', () => {
    writeIn(repo, 'server/pipeline/execution/own-change.ts', 'export const own = 2;\n');

    const changed = getChangedFiles('base-ref', repo);

    expect(changed).toContain('server/pipeline/execution/own-change.ts');
  });
});

describe('getAddedLineRanges against a real git repo', () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-mutation-lines-')));
    gitIn(repo, 'init', '-q');
    gitIn(repo, 'config', 'user.email', 'test@example.com');
    gitIn(repo, 'config', 'user.name', 'Test');
    gitIn(repo, 'config', 'diff.noprefix', 'true');
    writeIn(repo, 'server/pipeline/verdict/index.ts', 'a\nb\nc\nd\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'base');
    gitIn(repo, 'branch', 'base-ref');
    writeIn(repo, 'server/pipeline/verdict/index.ts', 'a\nB\nc\nd\ne\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'change');
    writeIn(repo, 'server/pipeline/verdict/index.ts', 'A\nB\nc\nd\ne\n');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns the committed and uncommitted added lines since the merge-base, whatever the diff prefix config', () => {
    expect(getAddedLineRanges('base-ref', repo).get('server/pipeline/verdict/index.ts')).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 5 },
    ]);
  });
});
