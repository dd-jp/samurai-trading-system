import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  codeFilesIn,
  createIndexResolver,
  extractCitations,
  extractCodeCitations,
  IMMUTABLE_RECORD_DIRS,
  knownRootsFromPaths,
  knownRootsOf,
  listIndexedPaths,
  markdownFilesIn,
  type Report,
  runCitationCheck,
  type Violation,
} from './check-path-citations.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const FIXTURES = 'server/tools/__fixtures__/path-citations';
const knownRoots = knownRootsOf(REPO_ROOT);

function check(files: readonly string[]) {
  return runCitationCheck({ root: REPO_ROOT, files, knownRoots });
}

function kinds(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.kind}@${v.citation.line}:${v.citation.raw}`);
}

describe('the known-good fixture', () => {
  const report = check([`${FIXTURES}/known-good.md`]);

  it('produces no violations at all', () => {
    expect(kinds(report.violations)).toEqual([]);
  });

  it('counts one exemption of each reason', () => {
    expect(report.exemptByMarker).toEqual({
      foreign: 1,
      historical: 1,
      planned: 1,
      untracked: 1,
    });
  });

  it('scans the unmarked citations rather than skipping the file', () => {
    // 3 unmarked resolving citations + 4 marked ones
    expect(report.citationsScanned).toBe(7);
  });
});

describe('the known-bad fixture', () => {
  const report = check([`${FIXTURES}/known-bad.md`]);

  it('flags every case exactly once, and nothing else', () => {
    expect(kinds(report.violations)).toEqual([
      'missing-path@7:server/pipeline/verdict/no-such-file.ts',
      'line-beyond-eof@9:server/tools/check-path-citations.ts:99999',
      'line-on-directory@11:server/tools/:12',
      'stale-planned-exemption@13:server/tools/check-path-citations.ts',
      'malformed-exemption@15:server/pipeline/verdict/gone.ts',
      'malformed-exemption@17:server/pipeline/verdict/also-gone.ts',
    ]);
  });

  it('names the file and line of the citation, not just the path', () => {
    const first = report.violations[0];
    expect(first?.message).toContain(`${FIXTURES}/known-bad.md:`);
    expect(first?.message).toContain('server/pipeline/verdict/no-such-file.ts');
  });

  it('counts nothing as exempt — a bad marker never buys silence', () => {
    expect(report.exemptByMarker).toEqual({
      foreign: 0,
      historical: 0,
      planned: 0,
      untracked: 0,
    });
  });
});

describe('the known-good code fixture (#1345)', () => {
  const report = check([`${FIXTURES}/known-good.ts`]);

  it('produces no violations at all', () => {
    expect(kinds(report.violations)).toEqual([]);
  });

  it('counts one exemption of each reason, plus one extra historical (marker inside a block comment)', () => {
    expect(report.exemptByMarker).toEqual({
      foreign: 1,
      historical: 2,
      planned: 1,
      untracked: 1,
    });
  });

  it('scans citations out of // and /* */ comments, never out of a string or template literal', () => {
    // 4 unmarked resolving citations (a `//` directory, a `//` file, a `//` file:line, and
    // one from a `/** */` block comment) + 5 marked ones (one of each of the 4 exempt
    // reasons via `//`, plus a `historical` marker inside a `/** */` block comment,
    // proving the marker binds the same way there — round-2 review item 4). The string
    // and template-literal lines each carry a path-shaped token too, and neither counts
    expect(report.citationsScanned).toBe(9);
  });
});

describe('the known-bad code fixture (#1345)', () => {
  const report = check([`${FIXTURES}/known-bad.ts`]);

  it('flags every case exactly once, and nothing else', () => {
    expect(kinds(report.violations)).toEqual([
      'missing-path@7:server/pipeline/verdict/no-such-file.ts',
      'line-beyond-eof@9:server/tools/check-path-citations.ts:99999',
      'line-on-directory@11:server/tools/:12',
      'stale-planned-exemption@13:server/tools/check-path-citations.ts',
      'malformed-exemption@15:server/pipeline/verdict/gone.ts',
      'malformed-exemption@17:server/pipeline/verdict/also-gone.ts',
    ]);
  });

  it('counts nothing as exempt — a bad marker never buys silence', () => {
    expect(report.exemptByMarker).toEqual({
      foreign: 0,
      historical: 0,
      planned: 0,
      untracked: 0,
    });
  });
});

describe('mutation: a deliberately bad in-code citation (#1345)', () => {
  // The AC this satisfies: a checker over comments must actually catch one. Neither
  // direction is meaningful alone — a checker that always fails would pass the first
  // test, one that never runs would pass the second
  const badSource = '// see `server/pipeline/verdict/gone-for-good.ts` for the mechanism\n';
  const fixedSource = '// see `server/pipeline/execution/reconcile.ts` for the mechanism\n';

  it('fails once a comment cites a path that does not resolve', () => {
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: ['server/synthetic-mutation.ts'],
      knownRoots,
      readMarkdown: () => badSource,
    });
    expect(kinds(report.violations)).toEqual([
      'missing-path@1:server/pipeline/verdict/gone-for-good.ts',
    ]);
  });

  it('passes once the same citation is corrected to a path that resolves', () => {
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: ['server/synthetic-mutation.ts'],
      knownRoots,
      readMarkdown: () => fixedSource,
    });
    expect(report.violations).toEqual([]);
    expect(report.citationsScanned).toBe(1);
  });
});

describe('stringDelim resets per line, not carried across the file (#1375 review)', () => {
  // An unmatched `'`, `"`, or backtick on one line (a regex literal, JSX text — none of
  // these is a real multi-line string in valid TS, and a regex literal is not a template
  // literal even when it contains a backtick) used to leave `stringDelim` set entering
  // the next line, blanking every comment after it for the rest of the file. Every
  // delimiter now resets unconditionally at end-of-line — a real template literal's
  // continuation lines carry no `//` or `/*` of their own, so resetting and re-scanning
  // them from a clean state blanks them harmlessly rather than losing protection

  it('an apostrophe inside a regex literal does not swallow the next line’s citation', () => {
    const source =
      "const re = /it's a test/;\n// see `server/pipeline/verdict/gone-for-good.ts` for it\n";
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: ['server/synthetic-mutation.ts'],
      knownRoots,
      readMarkdown: () => source,
    });
    expect(kinds(report.violations)).toEqual([
      'missing-path@2:server/pipeline/verdict/gone-for-good.ts',
    ]);
  });

  it('an apostrophe in JSX text does not swallow the next line’s citation', () => {
    const source =
      "const el = <p>It's data</p>;\n// see `server/pipeline/verdict/gone-for-good.ts` for it\n";
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: ['server/synthetic-mutation.tsx'],
      knownRoots,
      readMarkdown: () => source,
    });
    expect(kinds(report.violations)).toEqual([
      'missing-path@2:server/pipeline/verdict/gone-for-good.ts',
    ]);
  });

  it('control: no apostrophe on the first line, the next line’s citation is still seen', () => {
    const source = 'const x = 1;\n// see `server/pipeline/verdict/gone-for-good.ts` for it\n';
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: ['server/synthetic-mutation.ts'],
      knownRoots,
      readMarkdown: () => source,
    });
    expect(kinds(report.violations)).toEqual([
      'missing-path@2:server/pipeline/verdict/gone-for-good.ts',
    ]);
  });

  it('a single backtick inside a regex literal does not swallow the next line’s citation', () => {
    // The regex is not a template literal — it just contains a backtick character — but
    // the naive delimiter tracker cannot tell the difference; this is round-2 review
    // item 1, the same class as the apostrophe cases above, for the third quote type
    const source = 'const re = /`/;\n// see `server/pipeline/verdict/gone-for-good.ts` for it\n';
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: ['server/synthetic-mutation.ts'],
      knownRoots,
      readMarkdown: () => source,
    });
    expect(kinds(report.violations)).toEqual([
      'missing-path@2:server/pipeline/verdict/gone-for-good.ts',
    ]);
  });
});

describe('code-comment extraction', () => {
  const extractCode = (source: string) =>
    extractCodeCitations(source, { file: 'server/x.ts', knownRoots }).map((c) => c.raw);

  it('extracts a citation from a `//` line comment', () => {
    expect(extractCode('// see `server/tools/check-path-citations.ts` for the mechanism')).toEqual([
      'server/tools/check-path-citations.ts',
    ]);
  });

  it('extracts a citation from a `/** */` block comment, including a multi-line one', () => {
    expect(extractCode('/**\n * See `server/tools/check-path-citations.ts` above.\n */\n')).toEqual(
      ['server/tools/check-path-citations.ts'],
    );
  });

  it('never extracts from a string or template literal, even one that looks like a citation', () => {
    expect(extractCode("const x = '`server/tools/check-path-citations.ts`';")).toEqual([]);
    expect(extractCode('const x = `server/tools/check-path-citations.ts`;')).toEqual([]);
  });

  it('does not let a `//` inside a string open a false line comment', () => {
    // Without string-tracking, the `//` in the URL would open a line comment and the
    // trailing backticked path would read as code, not comment, and go unseen
    expect(
      extractCode("const x = 'https://example.com'; // `server/tools/check-path-citations.ts`"),
    ).toEqual(['server/tools/check-path-citations.ts']);
  });

  it('attaches a cite-exempt marker on a code comment line the same way it does on markdown', () => {
    const cites = extractCodeCitations(
      '// `server/a/gone.ts` and `server/b/gone.ts` <!-- cite-exempt: historical — why -->\n// `server/c/gone.ts`',
      { file: 'server/x.ts', knownRoots },
    );
    expect(cites.map((c) => c.exemption?.reason)).toEqual(['historical', 'historical', undefined]);
  });
});

describe('codeFilesIn', () => {
  it('keeps tracked .ts/.tsx, drops .md and anything under a skipped directory', () => {
    // `node_modules` needs no entry here: it is untracked and never reaches this
    // function at all in real use (`git ls-files --cached` never lists it), the same
    // reason `SKIPPED_DIRS`'s own doc gives for dropping it from that set
    const paths = [
      'server/pipeline/reconcile.ts',
      'client/src/App.tsx',
      'docs/notes.md',
      'server/tools/__fixtures__/path-citations/known-good.ts',
      '.claude/agents/reviewer.ts',
    ];
    expect(codeFilesIn(paths)).toEqual(['server/pipeline/reconcile.ts', 'client/src/App.tsx']);
  });
});

describe('extraction', () => {
  const extract = (markdown: string) =>
    extractCitations(markdown, { file: 'docs/x.md', knownRoots }).map((c) => c.raw);

  it('ignores a bare top-level directory, which is a concept token not a citation', () => {
    // CLAUDE.md asserts "There is no root `src/`" — demanding it resolve is absurd
    expect(extract('There is no root `src/`.')).toEqual([]);
  });

  it('ignores non-path tokens that merely contain a slash', () => {
    expect(extract('`application/json`, `req/min`, `crypto/stocks`')).toEqual([]);
  });

  it('ignores templates, globs, anchors and URLs', () => {
    expect(
      extract('`docs/specs/<stage>-spec.md` `server/**/*.ts` `docs/a.md#h` `https://x.dev/a/b`'),
    ).toEqual([]);
  });

  it('ignores a line range rather than mis-parsing it into the path', () => {
    expect(extract('`server/tools/check-path-citations.ts:10-20`')).toEqual([]);
  });

  it('ignores a first segment that is not a real top-level directory', () => {
    expect(extract('`nosuchroot/file.ts`')).toEqual([]);
  });

  it('does not extract from fenced code blocks', () => {
    expect(extract('```ts\n// `server/gone/x.ts`\n```\n')).toEqual([]);
    expect(extract('~~~\n`server/gone/x.ts`\n~~~\n')).toEqual([]);
  });

  it('extracts a path and a path:line, dropping the trailing slash', () => {
    const cites = extractCitations('`server/tools/` and `contracts/index.ts:3`', {
      file: 'docs/x.md',
      knownRoots,
    });
    expect(cites.map((c) => [c.path, c.lineNumber])).toEqual([
      ['server/tools', undefined],
      ['contracts/index.ts', 3],
    ]);
  });

  it('attaches a marker to every citation on the marker line, and no other line', () => {
    const cites = extractCitations(
      '`server/a/gone.ts` and `server/b/gone.ts` <!-- cite-exempt: historical — why -->\n`server/c/gone.ts`',
      { file: 'docs/x.md', knownRoots },
    );
    expect(cites.map((c) => c.exemption?.reason)).toEqual(['historical', 'historical', undefined]);
    expect(cites[0]?.exemption?.note).toBe('why');
  });
});

describe('line counting', () => {
  it('treats a trailing newline as terminating the last line, not starting a new one', () => {
    // Otherwise every citation of a file's final line would be off by one and pass
    // only by accident
    const report = check([`${FIXTURES}/known-good.md`]);
    expect(report.violations).toEqual([]);
    const path = join(REPO_ROOT, FIXTURES, 'known-good.md');
    const text = readFileSync(path, 'utf8');
    const lastLine = text.replace(/\n$/, '').split('\n').length;
    const atEof = runCitationCheck({
      root: REPO_ROOT,
      files: ['docs/synthetic.md'],
      knownRoots,
      readMarkdown: () => `\`${FIXTURES}/known-good.md:${lastLine}\``,
    });
    expect(atEof.violations).toEqual([]);
    const pastEof = runCitationCheck({
      root: REPO_ROOT,
      files: ['docs/synthetic.md'],
      knownRoots,
      readMarkdown: () => `\`${FIXTURES}/known-good.md:${lastLine + 1}\``,
    });
    expect(pastEof.violations.map((v) => v.kind)).toEqual(['line-beyond-eof']);
  });
});

describe('preserved-by-rule directories', () => {
  it('never parses a file under one of them, however dead its citations', () => {
    const report = runCitationCheck({
      root: REPO_ROOT,
      files: [
        'docs/adr/0007-x.md',
        'docs/wayfinder/a.md',
        'docs/research/archive/b.md',
        'docs/reviews/c.md',
      ],
      knownRoots,
      readMarkdown: () => '`src/verdict/index.ts:9999`',
    });
    expect(report.violations).toEqual([]);
    expect(report.filesScanned).toBe(0);
    expect(report.filesSkippedByRule).toBe(4);
  });

  it('is exactly the four directories the design allows — widening it is the failure mode', () => {
    expect([...IMMUTABLE_RECORD_DIRS]).toEqual([
      'docs/adr/',
      'docs/wayfinder/',
      'docs/research/archive/',
      'docs/reviews/',
    ]);
  });
});

describe('the repository as it stands', () => {
  it('has zero citation violations', () => {
    // The check that gives the tool its meaning: it is wired into CI and green on the
    // real tree, not only on fixtures. A failure here is either a genuinely stale
    // citation (fix the citation) or a marker that needs writing — never a reason to
    // add a directory to IMMUTABLE_RECORD_DIRS
    const report = runCitationCheck({ root: REPO_ROOT });
    expect(report.violations.map((v) => v.message)).toEqual([]);
    // >500, not >100: code-comment scanning (#1345) roughly doubled the citation count
    // over markdown alone. A drop back toward 100 here would mean code scanning silently
    // stopped running, not that the repository got smaller
    expect(report.citationsScanned).toBeGreaterThan(500);
  });
});

/**
 * Helpers for a throwaway git repository, used by the invariance tests below.
 *
 * The repo lives in `os.tmpdir()` and never inside this checkout: `vitest.global-setup.ts`
 * snapshots the inode of `data/` and the store files here, so a test that created a `data/`
 * in the repo root would be tampering with the very thing that guard watches.
 *
 * `realpathSync` because macOS `/var/folders/...` is a symlink to `/private/var/...`, and
 * the checker resolves its root — without it the paths compared would differ by prefix.
 *
 * No commit is ever made. `git ls-files --cached` reads the INDEX, so `git init` plus
 * `git add` is the whole setup, and no `user.name`/`user.email` is needed.
 */
function gitIn(repo: string, ...args: readonly string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'core.excludesFile=/dev/null', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function writeIn(repo: string, relativePath: string, text: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
}

const NOTES_MD = [
  'A resolving file: `server/thing.ts`, and its last line `server/thing.ts:3`.',
  'A runtime store, cited the way README.md cites one: `data/samurai-live.sqlite`.',
  'An ignored artefact under a root the index does know: `docs/out.log`.',
  'A tracked sibling: `docs/keep.md`.',
  '',
].join('\n');

describe('resolution against the git index rather than the working directory (#866)', () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-citations-')));
    writeIn(repo, '.gitignore', '*.sqlite\n*.log\n*.gen.md\n');
    writeIn(repo, 'server/thing.ts', 'one\ntwo\nthree\n');
    writeIn(repo, 'docs/keep.md', 'No citations here.\n');
    writeIn(repo, 'docs/notes.md', NOTES_MD);
    gitIn(repo, 'init', '-q');
    gitIn(repo, 'add', '-A');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** The state a machine is in after `npm run smoke`: gitignored output, and nothing else */
  function createRuntimeArtefacts(): void {
    writeIn(repo, 'data/samurai-live.sqlite', '');
    writeIn(repo, 'data/samurai-backtest.sqlite', '');
    writeIn(repo, 'docs/out.log', 'noise\n');
    writeIn(repo, 'docs/report.gen.md', 'A generated citation: `server/nope.ts`.\n');
  }

  it('reports the same scanned set and the same violations before and after a run produces gitignored state', () => {
    // The property this ticket exists for. Before #866 the same commit answered "261
    // citations, 0 violations" on a clean checkout and "268, 4" on a checkout that had
    // run the system, because a `data/` on disk made `data` a known root and made seven
    // tokens into citations. Here the whole Report is compared, so a movement in ANY
    // field — files scanned, citations, exemption counts, violations — fails
    const clean: Report = runCitationCheck({ root: repo });
    expect(existsSync(join(repo, 'data'))).toBe(false);

    createRuntimeArtefacts();
    expect(existsSync(join(repo, 'data', 'samurai-live.sqlite'))).toBe(true);
    const dirty: Report = runCitationCheck({ root: repo });

    expect(dirty).toEqual(clean);
  });

  it('holds that invariance over a non-empty report, not two empty ones', () => {
    // Guards the test above from passing vacuously. The fixture's "docs/out.log" citation
    // is a violation in BOTH states — it exists on disk in the second, and existing on
    // disk buys nothing
    const report = runCitationCheck({ root: repo });
    // 2 markdown + 1 code (the "server/thing.ts" fixture, no citations of its own — it
    // only ever appears as a citation TARGET, in docs/notes.md)
    expect(report.filesScanned).toBe(3);
    expect(report.citationsScanned).toBe(4);
    expect(kinds(report.violations)).toEqual(['missing-path@3:docs/out.log']);
  });

  it('never learns a top-level root from a directory that exists only as ignored output', () => {
    // The specific mechanism of the flip: `data/samurai-live.sqlite` is not extracted as
    // a citation at all, because nothing in the index puts a `data` root there
    const roots = knownRootsFromPaths(listIndexedPaths(repo));
    expect(roots.has('data')).toBe(false);
    expect(roots.has('docs')).toBe(true);
  });

  it('does not scan an ignored markdown file that a directory walk would have found', () => {
    expect(existsSync(join(repo, 'docs/report.gen.md'))).toBe(true);
    expect(markdownFilesIn(listIndexedPaths(repo))).toEqual(['docs/keep.md', 'docs/notes.md']);
    // And the run agrees: taking the file set from the index is what makes `filesScanned`
    // a repository fact rather than a fact about what tooling has written into the tree
    // 2 markdown + 1 code (the "server/thing.ts" fixture)
    expect(runCitationCheck({ root: repo }).filesScanned).toBe(3);
  });

  it('completes without throwing when an indexed file has been deleted from the working tree', () => {
    // Existence and content now come from different places, so this state exists where it
    // could not before: the index still has the "server/thing.ts" fixture file, the disk
    // does not. Erring toward the false negative — no line violation — beats crashing the
    // whole run
    rmSync(join(repo, 'server/thing.ts'));
    const report = runCitationCheck({ root: repo });
    expect(kinds(report.violations)).toEqual(['missing-path@3:docs/out.log']);
    // Restored for any later test in this file; the index was never touched
    writeIn(repo, 'server/thing.ts', 'one\ntwo\nthree\n');
  });
});

describe('the index resolver, against this repository', () => {
  it('calls a path that exists on disk but is not indexed missing — presence grants nothing', () => {
    // The structural statement of the invariant, as opposed to an instance of it: no
    // amount of gitignored state on this machine can make a path resolve
    const resolver = createIndexResolver(REPO_ROOT, listIndexedPaths(REPO_ROOT));
    expect(existsSync(join(REPO_ROOT, 'node_modules'))).toBe(true);
    expect(resolver.kind('node_modules')).toBe('missing');
    expect(resolver.kind('server/tools/check-path-citations.ts')).toBe('file');
    expect(resolver.kind('server/tools')).toBe('directory');
  });

  it('takes its roots from the index, keeping tracked `.github` and dropping tracked `.claude`', () => {
    // `.claude` is in `.gitignore` and has tracked files anyway, so the index alone
    // would admit it; `SKIPPED_DIRS` is what keeps it out, and it is now the ONLY
    // reason the dotfile special case could be deleted
    //
    // Asserted by membership, never as the full set: pinning the exact list would turn
    // "someone added a top-level directory" into a red citation check, which is the
    // stale-list cost this checker's whole design exists to avoid
    const roots = knownRootsOf(REPO_ROOT);
    expect(roots.has('.github')).toBe(true);
    expect(roots.has('server')).toBe(true);
    expect(roots.has('src')).toBe(true);
    expect(roots.has('.claude')).toBe(false);
  });

  it('refuses to guess outside a git checkout rather than falling back to the filesystem', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'samurai-not-a-repo-')));
    try {
      expect(() => listIndexedPaths(outside)).toThrow(/needs a git checkout/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
