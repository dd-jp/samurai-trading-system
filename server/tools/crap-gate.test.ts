import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BiomeReport,
  type ChangedLines,
  type CoverageReport,
  crapScore,
  evaluateCrap,
  type FileCoverage,
  formatDistribution,
  functionCoverage,
  gateReport,
  gitChangedLines,
  innermostFunction,
  isGated,
  main,
  parseArgs,
  parseBiomeComplexity,
  parseUnifiedDiff,
  percentile,
  reconcileChangedFiles,
  withinScope,
} from './crap-gate.js';

const ROOT = '/repo';
const FILE = '/repo/server/a.ts';

function range(
  startLine: number,
  startColumn: number | null,
  endLine: number,
  endColumn: number | null,
) {
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  };
}

// outer: `function outer() {` on line 1 (name at 0-based column 9), body lines 1–20
// inner: `const inner = () => {` on line 5, body lines 5–8
// method: `method() {` on line 12 at column 2
function fixture(overrides: Partial<FileCoverage> = {}): FileCoverage {
  return {
    path: FILE,
    fnMap: {
      '0': { name: 'outer', decl: range(1, 9, 1, 14), loc: range(1, 17, 20, null) },
      '1': { name: 'inner', decl: range(5, 20, 5, 22), loc: range(5, 23, 8, null) },
      '2': { name: 'method', decl: range(12, 2, 12, 8), loc: range(12, 11, 15, null) },
    },
    f: { '0': 1, '1': 0, '2': 1 },
    statementMap: {
      '0': range(2, 2, 2, 20),
      '1': range(3, 2, 3, 20),
      '2': range(6, 4, 6, 30),
      '3': range(7, 4, 7, 30),
      '4': range(13, 4, 13, 30),
    },
    s: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 3 },
    ...overrides,
  };
}

function diagnostic(path: string, line: number, column: number, complexity: number) {
  return {
    category: 'lint/complexity/noExcessiveCognitiveComplexity',
    message: `Excessive complexity of ${complexity} detected (max: 1).`,
    location: { path, start: { line, column } },
  };
}

describe('parseBiomeComplexity', () => {
  it('reads complexity, resolves the path against the root and keeps the 1-based position', () => {
    expect(
      parseBiomeComplexity({ diagnostics: [diagnostic('server/a.ts', 1, 10, 7)] }, ROOT),
    ).toEqual([{ path: FILE, line: 1, column: 10, complexity: 7 }]);
  });

  it('skips other rules', () => {
    const report: BiomeReport = {
      diagnostics: [{ ...diagnostic('server/a.ts', 1, 10, 7), category: 'lint/style/useConst' }],
    };
    expect(parseBiomeComplexity(report, ROOT)).toEqual([]);
  });

  it.each([
    ['an unparseable message', { ...diagnostic('server/a.ts', 1, 10, 7), message: 'reworded' }],
    [
      'no location',
      {
        category: 'lint/complexity/noExcessiveCognitiveComplexity',
        message: 'Excessive complexity of 3 detected',
      },
    ],
    ['no start', { ...diagnostic('server/a.ts', 1, 10, 7), location: { path: 'server/a.ts' } }],
  ])('throws on a complexity diagnostic with %s rather than dropping it', (_label, entry) => {
    expect(() => parseBiomeComplexity({ diagnostics: [entry] }, ROOT)).toThrow(
      'unreadable complexity diagnostic',
    );
  });

  it('treats a report with no diagnostics as empty and a null column as column 1', () => {
    expect(parseBiomeComplexity({}, ROOT)).toEqual([]);
    const nullColumn = {
      ...diagnostic('server/a.ts', 4, 1, 2),
      location: { path: 'server/a.ts', start: { line: 4, column: null } },
    };
    expect(parseBiomeComplexity({ diagnostics: [nullColumn] }, ROOT)[0]?.column).toBe(1);
  });
});

describe('innermostFunction', () => {
  it('matches the function whose decl starts exactly at the Biome position', () => {
    expect(innermostFunction(fixture(), 1, 10)).toEqual({ kind: 'matched', key: '0' });
    expect(innermostFunction(fixture(), 12, 3)).toEqual({ kind: 'matched', key: '2' });
  });

  it('falls back to the innermost decl-to-end range containing the position', () => {
    expect(innermostFunction(fixture(), 5, 22)).toEqual({ kind: 'matched', key: '1' });
    expect(innermostFunction(fixture(), 10, 1)).toEqual({ kind: 'matched', key: '0' });
  });

  it('reports none outside every function and ambiguous for identical ranges', () => {
    expect(innermostFunction(fixture(), 30, 1)).toEqual({ kind: 'none' });
    const twin = fixture({
      fnMap: {
        '0': { name: 'a', decl: range(1, 9, 1, 14), loc: range(1, 17, 3, null) },
        '1': { name: 'b', decl: range(1, 9, 1, 14), loc: range(1, 17, 3, null) },
      },
    });
    expect(innermostFunction(twin, 1, 10)).toEqual({ kind: 'ambiguous' });
    expect(innermostFunction(twin, 2, 5)).toEqual({ kind: 'ambiguous' });
  });

  it('uses loc when coverage carries no decl', () => {
    const noDecl = fixture({ fnMap: { '0': { name: 'x', loc: range(1, 0, 4, null) } } });
    expect(innermostFunction(noDecl, 2, 1)).toEqual({ kind: 'matched', key: '0' });
  });
});

describe('functionCoverage', () => {
  it('is the share of statements the function itself owns that ran, excluding nested functions', () => {
    expect(functionCoverage(fixture(), '1')).toBe(0);
    expect(functionCoverage(fixture(), '2')).toBe(1);
    expect(functionCoverage(fixture(), '0')).toBe(0.5);
  });

  it('does not let a well-covered nested function raise its parent', () => {
    const covered = fixture({ s: { '0': 0, '1': 0, '2': 5, '3': 5, '4': 5 } });
    expect(functionCoverage(covered, '0')).toBe(0);
  });

  it('falls back to the call count when the body has no statements', () => {
    const empty = fixture({ statementMap: {}, s: {} });
    expect(functionCoverage(empty, '0')).toBe(1);
    expect(functionCoverage(empty, '1')).toBe(0);
  });

  it('throws on an unknown function key', () => {
    expect(() => functionCoverage(fixture(), '9')).toThrow('no function 9');
  });
});

describe('crapScore', () => {
  it('is complexity × (1 − coverage)² + complexity', () => {
    expect(crapScore(10, 0)).toBe(20);
    expect(crapScore(10, 1)).toBe(10);
    expect(crapScore(12, 0.5)).toBe(15);
  });
});

describe('evaluateCrap', () => {
  const coverage: CoverageReport = { [FILE]: fixture() };

  it('scores matched findings worst first and ignores test files outside coverage', () => {
    const result = evaluateCrap(
      [
        { path: FILE, line: 12, column: 3, complexity: 4 },
        { path: FILE, line: 5, column: 22, complexity: 6 },
        { path: '/repo/server/a.test.ts', line: 1, column: 1, complexity: 30 },
      ],
      coverage,
    );
    expect(result.rows.map((row) => [row.name, row.crap])).toEqual([
      ['inner', 12],
      ['method', 4],
    ]);
    expect(result.unmatched).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it('starts the gated span at the declaration when Biome reports below it', () => {
    const [row] = evaluateCrap([{ path: FILE, line: 7, column: 5, complexity: 3 }], coverage).rows;
    expect(row).toMatchObject({ name: 'inner', line: 7, startLine: 5, endLine: 8 });
  });

  it('reports a production file missing from coverage as uncovered', () => {
    const missing = { path: '/repo/server/index.ts', line: 1, column: 1, complexity: 9 };
    expect(evaluateCrap([missing], coverage).uncovered).toEqual([missing]);
  });

  it('separates unmatched and ambiguous findings', () => {
    const twin: CoverageReport = {
      [FILE]: fixture({
        fnMap: {
          '0': { name: 'a', decl: range(1, 9, 1, 14), loc: range(1, 17, 3, null) },
          '1': { name: 'b', decl: range(1, 9, 1, 14), loc: range(1, 17, 3, null) },
        },
      }),
    };
    const result = evaluateCrap(
      [
        { path: FILE, line: 1, column: 10, complexity: 2 },
        { path: FILE, line: 40, column: 1, complexity: 2 },
      ],
      twin,
    );
    expect(result.ambiguous).toHaveLength(1);
    expect(result.unmatched).toHaveLength(1);
    expect(result.rows).toEqual([]);
  });
});

describe('percentile', () => {
  it('uses nearest rank and handles the empty case', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
  });
});

describe('withinScope', () => {
  it('passes everything with no scope and filters by path prefix otherwise', () => {
    expect(withinScope(FILE, ROOT, [])).toBe(true);
    expect(withinScope(FILE, ROOT, ['server/apps'])).toBe(false);
    expect(withinScope(FILE, ROOT, ['server/apps', 'server/a.ts'])).toBe(true);
    expect(withinScope(FILE, ROOT, ['server'])).toBe(true);
    expect(withinScope('/repo/server/apps/x.ts', ROOT, ['server/app'])).toBe(false);
  });
});

describe('formatDistribution', () => {
  it('prints counts, percentiles, threshold tallies and the worst rows', () => {
    const text = formatDistribution(
      {
        rows: [
          {
            path: FILE,
            line: 5,
            startLine: 5,
            endLine: 8,
            name: 'inner',
            complexity: 8,
            coverage: 0,
            crap: 16,
          },
        ],
        unmatched: [],
        ambiguous: [],
        uncovered: [],
      },
      ROOT,
      5,
      [15],
    );
    expect(text).toContain('functions scored:  1');
    expect(text).toContain('above  15:  1');
    expect(text).toContain('server/a.ts:5  inner');
  });
});

describe('parseArgs', () => {
  it('defaults and reads every flag', () => {
    expect(parseArgs([])).toEqual({
      coveragePath: 'coverage/coverage-final.json',
      top: 25,
      scope: [],
      strict: [],
    });
    expect(
      parseArgs([
        '--coverage',
        'c.json',
        '--threshold',
        '15',
        '--top',
        '3',
        '--scope',
        'a',
        '--scope',
        'b',
        '--strict',
        'server/apps/v2',
        '--changed-since',
        'origin/main',
      ]),
    ).toEqual({
      coveragePath: 'c.json',
      threshold: 15,
      top: 3,
      scope: ['a', 'b'],
      strict: ['server/apps/v2'],
      changedSince: 'origin/main',
    });
  });

  it('rejects unknown flags, missing values and non-numeric numbers', () => {
    expect(() => parseArgs(['--nope', 'x'])).toThrow('unknown flag --nope');
    expect(() => parseArgs(['--threshold'])).toThrow('missing value for --threshold');
    expect(() => parseArgs(['--threshold', 'abc'])).toThrow('bad --threshold');
    expect(() => parseArgs(['--top', 'NaN'])).toThrow('bad --top');
  });
});

describe('main', () => {
  function setup(): { root: string; file: string } {
    const root = mkdtempSync(join(tmpdir(), 'crap-gate-test-'));
    const file = join(root, 'server/a.ts');
    writeFileSync(
      join(root, 'coverage.json'),
      JSON.stringify({ [file]: { ...fixture(), path: file } }),
    );
    return { root, file };
  }

  function run(
    argv: string[],
    report: BiomeReport,
    root: string,
    changed: ChangedLines = new Map(),
  ): { code: number; out: string } {
    let out = '';
    const code = main(argv, root, {
      runBiome: () => report,
      changedLines: () => changed,
      write: (text) => {
        out += text;
      },
    });
    return { code, out };
  }

  it('prints the distribution and exits 0 without a threshold', () => {
    const { root } = setup();
    const { code, out } = run(
      ['--coverage', 'coverage.json'],
      { diagnostics: [diagnostic('server/a.ts', 5, 22, 8)] },
      root,
    );
    expect(code).toBe(0);
    expect(out).toContain('functions scored:  1');
  });

  it('fails when a function is above the threshold and passes at or below it', () => {
    const { root } = setup();
    const report = { diagnostics: [diagnostic('server/a.ts', 5, 22, 8)] };
    const failing = run(['--coverage', 'coverage.json', '--threshold', '15'], report, root);
    expect(failing.code).toBe(1);
    expect(failing.out).toContain('CRAP 16.0 > 15  server/a.ts:5  inner');
    expect(failing.out).toContain('1 function(s) above 15 of 1 gated');
    expect(run(['--coverage', 'coverage.json', '--threshold', '16'], report, root).code).toBe(0);
  });

  it('fails closed on a finding it cannot attribute to a covered function', () => {
    const { root } = setup();
    const { code, out } = run(
      ['--coverage', 'coverage.json', '--threshold', '15'],
      { diagnostics: [diagnostic('server/a.ts', 12, 3, 2), diagnostic('server/a.ts', 40, 1, 2)] },
      root,
    );
    expect(code).toBe(1);
    expect(out).toContain('unscored: server/a.ts:40');
  });

  it('under --changed-since gates only touched or strict functions', () => {
    const { root, file } = setup();
    const report = {
      diagnostics: [diagnostic('server/a.ts', 5, 22, 8), diagnostic('server/a.ts', 12, 3, 4)],
    };
    const argv = ['--coverage', 'coverage.json', '--threshold', '7', '--changed-since', 'main'];

    const untouched = run(argv, report, root, new Map([[file, new Set([13])]]));
    expect(untouched.code).toBe(0);
    expect(untouched.out).toContain('0 function(s) above 7 of 1 gated');
    expect(untouched.out).toContain('1 above 7 outside the ratchet');

    expect(run(argv, report, root, new Map([[file, new Set([6])]])).code).toBe(1);
    expect(run([...argv, '--strict', 'server'], report, root).code).toBe(1);
  });

  it('fails closed on a production file missing from coverage', () => {
    const { root } = setup();
    const { code, out } = run(
      ['--coverage', 'coverage.json', '--threshold', '15'],
      {
        diagnostics: [diagnostic('server/a.ts', 12, 3, 2), diagnostic('server/index.ts', 3, 1, 9)],
      },
      root,
    );
    expect(code).toBe(1);
    expect(out).toContain('unscored: server/index.ts:3');
  });

  it('applies --scope before scoring and refuses a run that scores nothing', () => {
    const { root } = setup();
    const report = { diagnostics: [diagnostic('server/a.ts', 5, 22, 8)] };
    const scopedOut = run(
      ['--coverage', 'coverage.json', '--threshold', '15', '--scope', 'contracts'],
      report,
      root,
    );
    expect(scopedOut.code).toBe(1);
    expect(scopedOut.out).toContain('no complexity findings scored');
    expect(
      run(['--coverage', 'coverage.json', '--threshold', '16', '--scope', 'server'], report, root)
        .code,
    ).toBe(0);
  });
});

describe('parseUnifiedDiff', () => {
  it('collects added and modified lines per file, marking pure deletions at their seam', () => {
    const diff = [
      'diff --git a/server/a.ts b/server/a.ts',
      '--- a/server/a.ts',
      '+++ b/server/a.ts',
      '@@ -3,2 +3,3 @@ function outer() {',
      '@@ -10 +11 @@',
      '@@ -20,4 +21,0 @@',
      'diff --git a/server/gone.ts b/server/gone.ts',
      '--- a/server/gone.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
    ].join('\n');
    const changed = parseUnifiedDiff(diff, ROOT);
    expect([...changed.keys()]).toEqual([FILE]);
    expect([...(changed.get(FILE) as Set<number>)]).toEqual([3, 4, 5, 11, 21, 22]);
  });

  it('drops the tab git appends to a path containing a space', () => {
    const diff = ['--- a/server/sp ace.ts\t', '+++ b/server/sp ace.ts\t', '@@ -1 +1 @@'].join('\n');
    expect([...parseUnifiedDiff(diff, ROOT).keys()]).toEqual(['/repo/server/sp ace.ts']);
  });
});

describe('reconcileChangedFiles', () => {
  it('throws when the parse produced a file git did not report', () => {
    const parsed = new Map<string, Set<number> | 'all'>([['/repo/erver/a.ts', new Set([1])]]);
    expect(() => reconcileChangedFiles(parsed, [FILE])).toThrow('diff parse disagrees');
  });

  it('gates a reported file the parse missed in full', () => {
    const parsed = new Map<string, Set<number> | 'all'>([[FILE, new Set([1])]]);
    const result = reconcileChangedFiles(parsed, [FILE, '/repo/server/mode-only.ts']);
    expect(result.get('/repo/server/mode-only.ts')).toBe('all');
    expect(result.get(FILE)).toEqual(new Set([1]));
  });
});

describe('gitChangedLines', () => {
  function gitIn(dir: string, ...args: string[]): string {
    return execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    );
  }

  it('reads modified, spaced, non-ASCII, renamed and untracked files despite hostile diff config', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'crap-gate-git-')));
    gitIn(dir, 'init', '-q');
    mkdirSync(join(dir, 'server'));
    const body = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    for (const name of ['kept.ts', 'sp ace.ts', 'café.ts', 'moved.ts']) {
      writeFileSync(join(dir, 'server', name), `${body}\n`);
    }
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '--no-verify', '-m', 'base');
    gitIn(dir, 'tag', 'base');
    gitIn(dir, 'config', 'diff.noprefix', 'true');
    gitIn(dir, 'config', 'diff.mnemonicPrefix', 'true');

    writeFileSync(join(dir, 'server', 'kept.ts'), 'a\nB\nc\nd\ne\nf\n');
    writeFileSync(join(dir, 'server', 'sp ace.ts'), 'a\nb\nc\nD\ne\nf\n');
    writeFileSync(join(dir, 'server', 'café.ts'), 'a\nb\nc\nd\ne\nF\n');
    renameSync(join(dir, 'server', 'moved.ts'), join(dir, 'server', 'renamed.ts'));
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '--no-verify', '-m', 'change');
    writeFileSync(join(dir, 'server', 'new.ts'), 'x\n');

    const changed = gitChangedLines(join(dir, 'server'), 'base');
    expect(changed.get(join(dir, 'server/kept.ts'))).toEqual(new Set([2]));
    expect(changed.get(join(dir, 'server/sp ace.ts'))).toEqual(new Set([4]));
    expect(changed.get(join(dir, 'server/café.ts'))).toEqual(new Set([6]));
    expect(changed.get(join(dir, 'server/renamed.ts'))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(changed.get(join(dir, 'server/new.ts'))).toBe('all');
    expect(changed.has(join(dir, 'server/moved.ts'))).toBe(false);
  });
});

describe('isGated', () => {
  const changed: ChangedLines = new Map<string, Set<number> | 'all'>([
    [FILE, new Set([7])],
    ['/repo/server/new.ts', 'all'],
  ]);

  it('gates everything when no ratchet is set', () => {
    expect(isGated({ root: ROOT, strict: [] }, '/repo/server/x.ts', 1, 2)).toBe(true);
  });

  it('gates strict prefixes, touched spans and new files only', () => {
    const policy = { root: ROOT, strict: ['contracts'], changed };
    expect(isGated(policy, '/repo/contracts/x.ts', 1, 2)).toBe(true);
    expect(isGated(policy, FILE, 5, 8)).toBe(true);
    expect(isGated(policy, FILE, 8, 9)).toBe(false);
    expect(isGated(policy, '/repo/server/new.ts', 1, 1)).toBe(true);
    expect(isGated(policy, '/repo/server/x.ts', 1, 99)).toBe(false);
    expect(isGated({ root: ROOT, strict: [], changed }, '/repo/contracts/x.ts', 1, 2)).toBe(false);
  });
});

describe('gateReport', () => {
  const row = {
    path: FILE,
    line: 5,
    startLine: 5,
    endLine: 8,
    name: 'inner',
    complexity: 8,
    coverage: 0,
    crap: 16,
  };

  it('refuses an empty run', () => {
    const result = gateReport({ rows: [], unmatched: [], ambiguous: [], uncovered: [] }, 7, {
      root: ROOT,
      strict: [],
    });
    expect(result.code).toBe(1);
  });

  it('ignores unscored findings outside the ratchet and fails on gated ones', () => {
    const lost = { path: '/repo/server/b.ts', line: 3, column: 1, complexity: 9 };
    const evaluation = { rows: [], unmatched: [], ambiguous: [], uncovered: [lost] };
    const withRow = { ...evaluation, rows: [{ ...row, crap: 5 }] };
    const outside = gateReport(withRow, 7, { root: ROOT, strict: [], changed: new Map() });
    expect(outside.code).toBe(0);
    const inside = gateReport(withRow, 7, {
      root: ROOT,
      strict: ['server/b.ts'],
      changed: new Map(),
    });
    expect(inside.code).toBe(1);
    expect(inside.text).toContain('unscored: server/b.ts:3');
  });
});
