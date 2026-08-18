import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  extractCitations,
  IMMUTABLE_RECORD_DIRS,
  knownRootsOf,
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
    // 3 unmarked resolving citations + 4 marked ones.
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

describe('extraction', () => {
  const extract = (markdown: string) =>
    extractCitations(markdown, { file: 'docs/x.md', knownRoots }).map((c) => c.raw);

  it('ignores a bare top-level directory, which is a concept token not a citation', () => {
    // CLAUDE.md asserts "There is no root `src/`" — demanding it resolve is absurd.
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
    // only by accident.
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
    // add a directory to IMMUTABLE_RECORD_DIRS.
    const report = runCitationCheck({ root: REPO_ROOT });
    expect(report.violations.map((v) => v.message)).toEqual([]);
    expect(report.citationsScanned).toBeGreaterThan(100);
  });
});
