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

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

function specifiersOf(file: string): string[] {
  const text = readFileSync(`${CONTRACTS_DIR}${file}`, 'utf8');
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
