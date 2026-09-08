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

// Run through `stripComments` first — a doc comment describing an import
// (`contracts/pipeline.ts`'s module doc names `AssetClass`'s import in
// prose, exactly the shape this must not misread) must not read as one.
// #1398 traces this to PR #1385's round-1 review; the specific wording that
// review reacted to isn't recoverable from git history (checked — see this
// PR's body), so treat that origin as unverified, not as fact.
function specifiersOf(file: string, dir: string = CONTRACTS_DIR): string[] {
  const text = stripComments(readFileSync(join(dir, file), 'utf8'));
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
  const fixturesDir = `${mkdtempSync(join(tmpdir(), 'boundary-fixtures-'))}/`;

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
    // Mirrors the predicate `it.each(sourceFiles())('%s imports nothing
    // outside contracts/'` above asserts on: no specifier here would fail it.
    expect(specifiers.some((s) => s.startsWith('../'))).toBe(false);
  });

  it('a real import escaping contracts/ is still detected', () => {
    const file = 'real-import.ts';
    writeFileSync(join(fixturesDir, file), "import type { X } from '../server/shared/index.js';\n");
    const specifiers = specifiersOf(file, fixturesDir);
    expect(specifiers).toEqual(['../server/shared/index.js']);
    // Same predicate as above, the other way: this specifier DOES fail it —
    // proving stripComments doesn't also swallow real escaping imports.
    expect(specifiers.some((s) => s.startsWith('../'))).toBe(true);
  });
});
