import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BiomeReport,
  type CoverageReport,
  crapScore,
  evaluateCrap,
  type FileCoverage,
  formatDistribution,
  functionCoverage,
  innermostFunction,
  main,
  parseArgs,
  parseBiomeComplexity,
  percentile,
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

// outer: `function outer() {` on line 1 (name at 0-based column 9), body lines 1–20.
// inner: `const inner = () => {` on line 5, body lines 5–8.
// method: `method() {` on line 12 at column 2.
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

  it('skips other rules, unparseable messages and diagnostics without a location', () => {
    const report: BiomeReport = {
      diagnostics: [
        { ...diagnostic('server/a.ts', 1, 10, 7), category: 'lint/style/useConst' },
        { ...diagnostic('server/a.ts', 1, 10, 7), message: 'something else' },
        {
          category: 'lint/complexity/noExcessiveCognitiveComplexity',
          message: 'Excessive complexity of 3 detected',
        },
        { ...diagnostic('server/a.ts', 1, 10, 7), location: { path: 'server/a.ts' } },
      ],
    };
    expect(parseBiomeComplexity(report, ROOT)).toEqual([]);
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
  it('is the share of statements inside the function body that ran', () => {
    expect(functionCoverage(fixture(), '1')).toBe(0);
    expect(functionCoverage(fixture(), '2')).toBe(1);
    expect(functionCoverage(fixture(), '0')).toBe(0.4);
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

  it('scores matched findings worst first and ignores files outside coverage', () => {
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
    expect(withinScope(FILE, ROOT, ['server/apps', 'server/a'])).toBe(true);
  });
});

describe('formatDistribution', () => {
  it('prints counts, percentiles, threshold tallies and the worst rows', () => {
    const text = formatDistribution(
      {
        rows: [{ path: FILE, line: 5, name: 'inner', complexity: 8, coverage: 0, crap: 16 }],
        unmatched: [],
        ambiguous: [],
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
      ]),
    ).toEqual({ coveragePath: 'c.json', threshold: 15, top: 3, scope: ['a', 'b'] });
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

  function run(argv: string[], report: BiomeReport, root: string): { code: number; out: string } {
    let out = '';
    const code = main(
      argv,
      root,
      () => report,
      (text) => {
        out += text;
      },
    );
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
    expect(run(['--coverage', 'coverage.json', '--threshold', '16'], report, root).code).toBe(0);
  });

  it('fails closed on a finding it cannot attribute to a covered function', () => {
    const { root } = setup();
    const { code, out } = run(
      ['--coverage', 'coverage.json', '--threshold', '15'],
      { diagnostics: [diagnostic('server/a.ts', 40, 1, 2)] },
      root,
    );
    expect(code).toBe(1);
    expect(out).toContain('unscored: server/a.ts:40');
  });

  it('applies --scope before scoring', () => {
    const { root } = setup();
    const report = { diagnostics: [diagnostic('server/a.ts', 5, 22, 8)] };
    expect(
      run(
        ['--coverage', 'coverage.json', '--threshold', '15', '--scope', 'contracts'],
        report,
        root,
      ).code,
    ).toBe(0);
  });
});
