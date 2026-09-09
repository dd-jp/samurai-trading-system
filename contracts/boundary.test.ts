/**
 * The one test that makes `contracts/` mean something.
 *
 * The directory's whole purpose is to be importable by both runtimes, which
 * requires that it import from neither. That property is invisible to
 * `tsc`: an `import type { AssetClass } from '../orchestrator/index.js'` in
 * here type-checks perfectly green while quietly pulling the entire server
 * module graph back into the browser's TypeScript program — which is the
 * exact defect this directory was created to remove. Nothing else in the
 * build would notice.
 *
 * So it is asserted mechanically, on the source text, rather than trusted to
 * review.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The one contracts/ -> server/ import in this directory. Safe only because
// it's in a `.test.ts` file: `sourceFiles()` below excludes test files from
// the scan this suite runs, and `tsconfig.build.json` excludes `**/*.test.ts`
// from what ships — neither mechanism polices what a test file itself
// imports, so this line relies on staying a test file, not on being checked.
import { stripComments } from '../server/shared/strip-comments.js';

const CONTRACTS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Every form that can name a module, because a check that covers only one of
 * them fails OPEN — the import it misses is exactly the one that reintroduces
 * the coupling, and nothing else in the build would object.
 *
 * Deliberately regex over source text rather than an AST walk: the property
 * being checked is "does this string escape the directory", which is a
 * property of the specifier itself, and a dependency-free check cannot drift
 * from the parser the build uses.
 */
const SPECIFIER_PATTERNS = [
  /** `import x from 'm'`, `import type { X } from 'm'`, `export { X } from 'm'`. */
  /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g,
  /**
   * `import 'm'` — a side-effect import, which has no `from` clause at all.
   * It names no binding, so it is the one form a reader skims past, and it
   * pulls in the module graph just as completely as a named import does.
   */
  /(?:^|[;}])\s*import\s+['"]([^'"]+)['"]/gm,
  /**
   * `await import('m')` — deferred, but still a dependency, and one that a
   * bundler resolves at build time into the same graph.
   */
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function sourceFiles(): string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

/**
 * Lines inside a block comment whose `/*` opened at the start of its own
 * line (only whitespace before it) — real commented-out code (`export
 * interface Old {}`) or unprefixed prose can legitimately start a line with
 * `import`/`export` there, and that's not what `assertNoVanishedImportLine`
 * exists to catch. A `/*` that follows other code on the same line (`const
 * re = /a\/*b/;`) never gets this protection — that shape is exactly the
 * regex-literal misparse the check exists to catch. Line-based rather than
 * quote-aware like `stripComments` itself: cheaper, and the gap it leaves
 * (treating a `/*`-shaped token at line start inside a multi-line string as
 * a real comment opener) can't actually make an import vanish, since
 * `stripComments` never touches template-literal content in the first
 * place.
 */
function lineStartBlockCommentInteriors(raw: string): Set<number> {
  const lines = raw.split('\n');
  const interior = new Set<number>();
  let openedAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openedAt === -1) {
      if (/^\s*\/\*/.test(lines[i]) && !lines[i].includes('*/')) openedAt = i;
      continue;
    }
    interior.add(i);
    if (lines[i].includes('*/')) openedAt = -1;
  }
  return interior;
}

/**
 * `stripComments` can mistake a regex literal for a comment opener and, when
 * a later real comment in the same file supplies the `*\/` it's missing,
 * silently swallow everything between — including a real import — with no
 * throw (see its doc comment). That failure mode is invisible to any check
 * on `stripComments`'s output alone, so this checks the property
 * `specifiersOf` actually depends on: a static `import`/`export` starting
 * its own line before stripping must still start that line after. It does
 * not cover `await import(...)` (never at line start — always inside an
 * expression) or a `from` clause after other code on the same physical
 * line; those would need `stripComments` to report which comment swallowed
 * what, not just a stripped string. Unreachable today — no contracts/*.ts
 * file has a regex literal, a dynamic import, or a static import/export
 * that isn't its own line — but a real gap in this check, not a false one.
 */
function assertNoVanishedImportLine(raw: string, stripped: string, file: string): void {
  const importOrExport = /^\s*(?:import|export)\b/;
  const rawLines = raw.split('\n');
  const strippedLines = stripped.split('\n');
  const protectedLines = lineStartBlockCommentInteriors(raw);
  for (let i = 0; i < rawLines.length; i++) {
    if (protectedLines.has(i)) continue;
    if (importOrExport.test(rawLines[i]) && !importOrExport.test(strippedLines[i] ?? '')) {
      throw new Error(
        `${file}:${i + 1}: looked like an import/export before stripping comments and ` +
          `doesn't after — stripComments likely misread a regex literal as a comment opener. ` +
          `Raw line: ${JSON.stringify(rawLines[i])}`,
      );
    }
  }
}

// Run through `stripComments` first — a doc comment describing an import
// (`contracts/pipeline.ts`'s module doc names `AssetClass`'s import in
// prose, exactly the shape this must not misread) must not read as one.
function specifiersOf(file: string, dir: string = CONTRACTS_DIR): string[] {
  const raw = readFileSync(join(dir, file), 'utf8');
  const text = stripComments(raw);
  assertNoVanishedImportLine(raw, text, file);
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1] as string),
  );
}

describe('contracts boundary', () => {
  it('has source files to check', () => {
    // Guards the assertions below against silently passing on an empty glob.
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it.each(sourceFiles())('%s imports nothing outside contracts/', (file) => {
    for (const specifier of specifiersOf(file)) {
      // A relative specifier that climbs out of this directory is the failure.
      // `./x.js` is fine; `../anything` is not.
      expect(
        specifier.startsWith('../'),
        `${file} imports "${specifier}", which escapes contracts/. ` +
          'Wire types must not reference server or client modules — inline the ' +
          'shape here and have the other side import it from contracts instead.',
      ).toBe(false);
    }
  });

  it.each(sourceFiles())('%s imports no runtime package', (file) => {
    for (const specifier of specifiersOf(file)) {
      // Bare specifiers mean a node_modules dependency. The contract is
      // consumed by a browser bundle and a Node process with exactly one
      // runtime dependency; neither can afford this directory acquiring more.
      expect(
        specifier.startsWith('.'),
        `${file} imports the package "${specifier}". contracts/ must stay ` +
          'dependency-free so both runtimes can consume it unchanged.',
      ).toBe(true);
    }
  });

  it('declares no Date-carrying field', () => {
    // The boundary rule, checked rather than documented: anything with a
    // `Date` is pre-serialization and belongs to the runtime that owns it.
    // ISO strings cross the wire; `Date` objects do not survive JSON.
    //
    // Matches `Date` ANYWHERE in a type position, not just `: Date` — the
    // narrow form let `Date[]`, `readonly Date[]`, `Map<string, Date>` and
    // `Date | null` through, and a guard that admits the container forms while
    // rejecting the bare one fails open exactly where a real contract would
    // reach for a collection.
    for (const file of sourceFiles()) {
      const text = readFileSync(`${CONTRACTS_DIR}${file}`, 'utf8');
      const declarations = text
        .split('\n')
        .filter((line) => /\bDate\b/.test(line) && !line.trimStart().startsWith('*'));
      expect(
        declarations,
        `${file} declares a Date field. Serialize it to an ISO string at the ` +
          'boundary and keep the Date-carrying shape server-side.',
      ).toEqual([]);
    }
  });
});

describe('specifiersOf strips comments before matching (#1398)', () => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'boundary-fixtures-'));

  afterAll(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  it('a specifier that only appears inside a comment is not treated as an import', () => {
    const file = 'comment-only-import.ts';
    writeFileSync(
      join(fixturesDir, file),
      [
        '/**',
        " * Mirrors the shape `import type { X } from '../server/shared/index.js'`",
        ' * pulls in server-side.',
        ' */',
        'export interface Placeholder {',
        "  // import { X } from '../server/shared/index.js';",
        "  // import '../server/shared/index.js';",
        "  // await import('../server/shared/index.js');",
        '  kind: string;',
        '}',
        '',
      ].join('\n'),
    );
    const specifiers = specifiersOf(file, fixturesDir);
    expect(specifiers).toEqual([]);
    // Same predicate `it.each(sourceFiles())('%s imports nothing outside
    // contracts/'` uses above — proves a commented-out import can't trip it.
    expect(specifiers.some((s) => s.startsWith('../'))).toBe(false);
  });

  it('a real import escaping contracts/ is still detected', () => {
    const file = 'real-import.ts';
    writeFileSync(join(fixturesDir, file), "import type { X } from '../server/shared/index.js';\n");
    const specifiers = specifiersOf(file, fixturesDir);
    expect(specifiers).toEqual(['../server/shared/index.js']);
    // Same predicate, inverted — proves stripComments doesn't also swallow a
    // real escaping import.
    expect(specifiers.some((s) => s.startsWith('../'))).toBe(true);
  });

  it('throws instead of silently dropping an import when a regex literal opens a phantom comment that a later real comment closes', () => {
    const file = 'regex-literal-swallows-import.ts';
    writeFileSync(
      join(fixturesDir, file),
      [
        'const re = /a\\/*b/;',
        "import type { Bad } from '../server/shared/index.js';",
        '/**',
        ' * a real doc comment further down the file',
        ' */',
        'export interface X {',
        '  kind: string;',
        '}',
        '',
      ].join('\n'),
    );
    expect(() => specifiersOf(file, fixturesDir)).toThrow(/vanished|import.*after/i);
  });

  it('does not throw on a real commented-out import inside a line-start block comment', () => {
    const file = 'commented-out-import.ts';
    writeFileSync(
      join(fixturesDir, file),
      [
        '/*',
        "import { X } from '../server/shared/index.js';",
        '*/',
        'export const kind = 1;',
        '',
      ].join('\n'),
    );
    expect(() => specifiersOf(file, fixturesDir)).not.toThrow();
  });

  it('does not throw on real commented-out code that starts a line with export', () => {
    const file = 'commented-out-export.ts';
    writeFileSync(
      join(fixturesDir, file),
      ['/*', 'export interface Old {}', '*/', 'export const kind = 1;', ''].join('\n'),
    );
    expect(() => specifiersOf(file, fixturesDir)).not.toThrow();
  });
});

/**
 * The outbound suite above proves `contracts/` imports nothing external. It
 * does not prove anything routes *into* it correctly — a file elsewhere that
 * reaches past `contracts/index.ts` straight into `contracts/pipeline.ts`
 * type-checks green and passes every test above (#1158). This is that other
 * half: nothing outside `contracts/` may name a `contracts/*.ts` file other
 * than `index.ts`.
 *
 * Two more barrels get the same check rather than a general sweep of every
 * barrel in the repo: `shared/store/sqlite-utils.ts` and
 * `shared/safe-log.ts`, each already exported by an existing barrel.
 */
describe('inbound routing: nothing bypasses a barrel (#1158)', () => {
  const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

  function walkSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        out.push(...walkSourceFiles(join(dir, entry.name)));
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  const REPO_SOURCE_FILES = ['server', 'client', 'e2e']
    .map((d) => join(REPO_ROOT, d))
    .flatMap((root) => walkSourceFiles(root));

  interface ImportStatement {
    readonly specifier: string;
    /** A statement starting `import type` (named, default, or namespace) — see coding-standards.md's carve-out. */
    readonly isBareImportType: boolean;
  }

  function importStatementsOf(absPath: string): ImportStatement[] {
    const raw = readFileSync(absPath, 'utf8');
    const text = stripComments(raw);
    // Same failure mode `specifiersOf` above guards against: a regex literal
    // misread as a comment opener can swallow a real import line before this
    // scan ever sees it. Without this call the inbound suite fails open on
    // exactly the import it exists to catch.
    assertNoVanishedImportLine(raw, text, absPath);
    const statements: ImportStatement[] = [];
    for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      statements.push({
        specifier: match[1] as string,
        isBareImportType: /^import\s+type\b/.test(match[0].trimStart()),
      });
    }
    for (const match of text.matchAll(/(?:^|[;}])\s*import\s+['"]([^'"]+)['"]/gm)) {
      statements.push({ specifier: match[1] as string, isBareImportType: false });
    }
    for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      statements.push({ specifier: match[1] as string, isBareImportType: false });
    }
    return statements;
  }

  /**
   * `honourImportTypeCarveOut` is false only for `contracts/`: its barrel is
   * dependency-free by enforced construction (the outbound suite above), so
   * the carve-out's reason — routing a type-only need would manufacture a
   * real import path into a module graph nothing else pulls in — cannot
   * arise there, and the carve-out does not reach it.
   */
  function deepImportViolations(
    targetPattern: RegExp,
    isInternalToTarget: (absPath: string) => boolean,
    honourImportTypeCarveOut: boolean,
  ): string[] {
    const violations: string[] = [];
    for (const file of REPO_SOURCE_FILES) {
      if (isInternalToTarget(file)) continue;
      for (const { specifier, isBareImportType } of importStatementsOf(file)) {
        if (!targetPattern.test(specifier)) continue;
        if (honourImportTypeCarveOut && isBareImportType) continue;
        violations.push(`${file}: imports "${specifier}" directly instead of through its barrel`);
      }
    }
    return violations;
  }

  /**
   * Must match a nested directory and a multi-dot filename, not only a flat
   * single-dot name — a charclass that admits neither fails open on exactly
   * the specifier shape a future `contracts/` layout would use. Must also
   * match a `.ts`/`.tsx` tail, not only `.js`: `client/tsconfig.json` and
   * `e2e/tsconfig.json` set `allowImportingTsExtensions`, so a deep import
   * from either tree can legally spell the extension either way.
   */
  const CONTRACTS_DEEP_IMPORT = /\/contracts\/(?!index\.(?:js|ts)$).+\.(?:js|tsx?)$/;

  it('has source files to check', () => {
    // Guards the assertions below against silently passing on an empty glob.
    expect(REPO_SOURCE_FILES.length).toBeGreaterThan(0);
  });

  it('the contracts pattern catches nested and multi-dot specifiers, and only excludes index.js/index.ts', () => {
    expect(CONTRACTS_DEEP_IMPORT.test('../../../contracts/pipeline.js')).toBe(true);
    expect(CONTRACTS_DEEP_IMPORT.test('../../contracts/wire/pipeline.js')).toBe(true);
    expect(CONTRACTS_DEEP_IMPORT.test('../../contracts/pipeline.v2.js')).toBe(true);
    expect(CONTRACTS_DEEP_IMPORT.test('../../contracts/index.js')).toBe(false);
    expect(CONTRACTS_DEEP_IMPORT.test('../../contracts/pipeline.ts')).toBe(true);
    expect(CONTRACTS_DEEP_IMPORT.test('../../contracts/pipeline.tsx')).toBe(true);
    expect(CONTRACTS_DEEP_IMPORT.test('../../contracts/index.ts')).toBe(false);
  });

  it('throws instead of silently dropping a deep import when a regex literal opens a phantom comment that a later real comment closes', () => {
    // Same fixture shape as the outbound suite's equivalent test above
    // (#1398), aimed at `importStatementsOf` instead of `specifiersOf`:
    // without `assertNoVanishedImportLine` in the inbound scan too, this
    // deep import into contracts/ vanishes silently and the suite passes
    // with the violation undetected.
    const dir = mkdtempSync(join(tmpdir(), 'boundary-inbound-fixtures-'));
    try {
      const file = join(dir, 'regex-literal-swallows-import.ts');
      writeFileSync(
        file,
        [
          'const re = /a\\/*b/;',
          "import { PIPELINE_STAGES } from '../../../contracts/pipeline.js';",
          '/**',
          ' * a real doc comment further down the file',
          ' */',
          'export const scratch = { PIPELINE_STAGES };',
          '',
        ].join('\n'),
      );
      expect(() => importStatementsOf(file)).toThrow(/vanished|import.*after/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the carve-out predicate admits named, default and namespace import type forms, not per-specifier or re-export type', () => {
    // Pins isBareImportType (:327) against docs/coding-standards.md's
    // carve-out wording. Finding 2/3 (#1158 round 2) was the doc and the
    // predicate disagreeing; this pins the predicate side of that agreement
    // so a future edit to either one fails a test instead of silently
    // reopening the same drift.
    const dir = mkdtempSync(join(tmpdir(), 'boundary-carve-out-fixtures-'));
    try {
      const file = join(dir, 'carve-out-forms.ts');
      writeFileSync(
        file,
        [
          "import type { Foo } from '../../../contracts/a.js';",
          "import type Bar from '../../../contracts/b.js';",
          "import type * as Baz from '../../../contracts/c.js';",
          "import { type Qux } from '../../../contracts/d.js';",
          "export type { Quux } from '../../../contracts/e.js';",
          '',
        ].join('\n'),
      );
      const bySpecifier = new Map(
        importStatementsOf(file).map((s) => [s.specifier, s.isBareImportType]),
      );
      expect(bySpecifier.get('../../../contracts/a.js')).toBe(true);
      expect(bySpecifier.get('../../../contracts/b.js')).toBe(true);
      expect(bySpecifier.get('../../../contracts/c.js')).toBe(true);
      expect(bySpecifier.get('../../../contracts/d.js')).toBe(false);
      expect(bySpecifier.get('../../../contracts/e.js')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nothing outside contracts/ imports a contracts/*.ts file other than index.ts', () => {
    const violations = deepImportViolations(CONTRACTS_DEEP_IMPORT, () => false, false);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('nothing outside shared/store/ imports shared/store/sqlite-utils.ts directly', () => {
    const violations = deepImportViolations(
      /\/shared\/store\/sqlite-utils\.js$/,
      (file) => file.includes('/shared/store/'),
      true,
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('nothing outside shared/ imports shared/safe-log.ts directly', () => {
    const violations = deepImportViolations(
      /\/shared\/safe-log\.js$/,
      (file) => file.includes('/shared/'),
      true,
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
