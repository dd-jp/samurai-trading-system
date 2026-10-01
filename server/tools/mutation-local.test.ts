import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  getChangedFiles,
  isMutableProductionFile,
  isTradingPathFile,
  type MutationGateDeps,
  parseChangedFiles,
  partitionChangedFiles,
  resolveMergeBase,
  runMutationGate,
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
    'server/pipeline/momentum/loss-budget.ts',
    'server/pipeline/momentum/sizing.ts',
  ])('%s is trading-path', (path) => {
    expect(isTradingPathFile(path)).toBe(true);
  });

  it('leaves the rest of momentum out', () => {
    expect(isTradingPathFile('server/pipeline/momentum/signal.ts')).toBe(false);
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

function gateDeps(changed: readonly string[], status: number | null = 0) {
  const lines: string[] = [];
  const baseRefs: string[] = [];
  const mutated: (readonly string[])[] = [];
  const deps: MutationGateDeps = {
    changedFiles: (baseRef) => {
      baseRefs.push(baseRef);
      return changed;
    },
    stryker: (tradingPath) => {
      mutated.push(tradingPath);
      return { error: undefined, status };
    },
    log: (line) => lines.push(line),
  };
  return { deps, lines, baseRefs, mutated };
}

describe('runMutationGate', () => {
  it('prints help without reading the diff', () => {
    const { deps, lines, baseRefs } = gateDeps([]);
    expect(runMutationGate(['--help'], deps)).toBe(0);
    expect(lines[0]).toMatch(/^Usage: npm run mutation:local/);
    expect(baseRefs).toEqual([]);
  });

  it('lists only the trading-path files and mutates nothing', () => {
    const { deps, lines, baseRefs, mutated } = gateDeps([
      'server/pipeline/execution/execute.ts',
      'server/pipeline/analysts/index.ts',
    ]);
    expect(runMutationGate(['--list', 'base'], deps)).toBe(0);
    expect(lines).toEqual(['server/pipeline/execution/execute.ts']);
    expect(baseRefs).toEqual(['base']);
    expect(mutated).toEqual([]);
  });

  it('defaults the base ref to origin/main', () => {
    const { deps, baseRefs } = gateDeps([]);
    runMutationGate([], deps);
    expect(baseRefs).toEqual(['origin/main']);
  });

  it('skips Stryker when no trading-path file changed', () => {
    const { deps, lines, mutated } = gateDeps(['server/pipeline/analysts/index.ts']);
    expect(runMutationGate(['base'], deps)).toBe(0);
    expect(mutated).toEqual([]);
    expect(lines.at(-1)).toBe('No trading-path files changed vs base — mutation gate skipped.');
  });

  it('mutates the trading-path files and returns Stryker’s status', () => {
    const { deps, mutated } = gateDeps(['server/apps/v2/risk/gate.ts'], 2);
    expect(runMutationGate(['base'], deps)).toBe(2);
    expect(mutated).toEqual([['server/apps/v2/risk/gate.ts']]);
  });

  it('fails when Stryker exits without a status', () => {
    const { deps } = gateDeps(['server/apps/v2/risk/gate.ts'], null);
    expect(runMutationGate(['base'], deps)).toBe(1);
  });

  it('rethrows a spawn error', () => {
    const { deps } = gateDeps(['server/apps/v2/risk/gate.ts']);
    const failing: MutationGateDeps = {
      ...deps,
      stryker: () => ({ error: new Error('no stryker'), status: null }),
    };
    expect(() => runMutationGate(['base'], failing)).toThrow('no stryker');
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
