import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../server/shared/strip-comments.js';

const CONTRACTS_DIR = fileURLToPath(new URL('.', import.meta.url));

const SPECIFIER_PATTERNS = [
  /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g,
  /(?:^|[;}])\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function sourceFiles(): string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

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
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it.each(sourceFiles())('%s imports nothing outside contracts/', (file) => {
    for (const specifier of specifiersOf(file)) {
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
      expect(
        specifier.startsWith('.'),
        `${file} imports the package "${specifier}". contracts/ must stay ` +
          'dependency-free so both runtimes can consume it unchanged.',
      ).toBe(true);
    }
  });

  it('declares no Date-carrying field', () => {
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
    expect(specifiers.some((s) => s.startsWith('../'))).toBe(false);
  });

  it('a real import escaping contracts/ is still detected', () => {
    const file = 'real-import.ts';
    writeFileSync(join(fixturesDir, file), "import type { X } from '../server/shared/index.js';\n");
    const specifiers = specifiersOf(file, fixturesDir);
    expect(specifiers).toEqual(['../server/shared/index.js']);
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

// CPU-heavy: ~4 s under coverage at load 25
describe('inbound routing: nothing bypasses a barrel (#1158)', { timeout: 15_000 }, () => {
  const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

  function walkSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(dir, entry.name));
    const subdirs = entries.filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name));
    return [...files, ...subdirs.flatMap((entry) => walkSourceFiles(join(dir, entry.name)))];
  }

  const REPO_SOURCE_FILES = ['server', 'client', 'e2e']
    .map((d) => join(REPO_ROOT, d))
    .flatMap((root) => walkSourceFiles(root));

  interface ImportStatement {
    readonly specifier: string;
    readonly isBareImportType: boolean;
  }

  function importStatementsOf(absPath: string): ImportStatement[] {
    const raw = readFileSync(absPath, 'utf8');
    const text = stripComments(raw);
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

  function fileImportViolations(
    file: string,
    targetPattern: RegExp,
    honourImportTypeCarveOut: boolean,
  ): string[] {
    const violations: string[] = [];
    for (const { specifier, isBareImportType } of importStatementsOf(file)) {
      if (!targetPattern.test(specifier)) continue;
      if (honourImportTypeCarveOut && isBareImportType) continue;
      violations.push(`${file}: imports "${specifier}" directly instead of through its barrel`);
    }
    return violations;
  }

  function deepImportViolations(
    targetPattern: RegExp,
    isInternalToTarget: (absPath: string) => boolean,
    honourImportTypeCarveOut: boolean,
  ): string[] {
    return REPO_SOURCE_FILES.filter((file) => !isInternalToTarget(file)).flatMap((file) =>
      fileImportViolations(file, targetPattern, honourImportTypeCarveOut),
    );
  }

  const CONTRACTS_DEEP_IMPORT = /\/contracts\/(?!index\.(?:js|ts)$).+\.(?:js|tsx?)$/;

  it('has source files to check', () => {
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
