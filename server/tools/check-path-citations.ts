import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isMainModule } from './cli-entrypoint.js';

export const IMMUTABLE_RECORD_DIRS = [
  'docs/adr/',
  'docs/wayfinder/',
  'docs/research/archive/',
  'docs/reviews/',
] as const;

const SKIPPED_DIRS = new Set(['.claude', '__fixtures__']);

const LEGACY_ROOT = 'src';

export const EXEMPT_REASONS = ['foreign', 'historical', 'planned', 'untracked'] as const;
export type ExemptReason = (typeof EXEMPT_REASONS)[number];

export interface Exemption {
  readonly reason: ExemptReason;
  readonly note: string;
}

export interface Citation {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly path: string;
  readonly lineNumber?: number;
  readonly exemption?: Exemption;
}

export type ViolationKind =
  | 'missing-path'
  | 'line-beyond-eof'
  | 'line-on-directory'
  | 'stale-planned-exemption'
  | 'malformed-exemption';

export interface Violation {
  readonly kind: ViolationKind;
  readonly citation: Citation;
  readonly message: string;
}

export interface Report {
  readonly filesScanned: number;
  readonly filesSkippedByRule: number;
  readonly citationsScanned: number;
  readonly exemptByMarker: Readonly<Record<ExemptReason, number>>;
  readonly violations: readonly Violation[];
}

export interface TreeResolver {
  kind(repoRelativePath: string): 'file' | 'directory' | 'missing';
  lineCount(repoRelativePath: string): number;
}

export function listIndexedPaths(root: string): readonly string[] {
  let stdout: string;
  try {
    stdout = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new Error(
      `check-path-citations resolves citations against the git index, so it needs a git ` +
        `checkout: \`git ls-files\` failed in ${root}. There is deliberately no filesystem ` +
        `fallback — falling back would silently restore the working-tree dependence #866 removed.`,
      { cause },
    );
  }
  return stdout.split('\0').filter((path) => path !== '');
}

export function createIndexResolver(root: string, indexedPaths: readonly string[]): TreeResolver {
  const files = new Set(indexedPaths);
  const directories = new Set<string>();
  for (const path of indexedPaths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/'));
  }
  return {
    kind(path) {
      if (files.has(path)) return 'file';
      return directories.has(path) ? 'directory' : 'missing';
    },
    lineCount(path) {
      let text: string;
      try {
        text = readFileSync(join(root, path), 'utf8');
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
      if (text === '') return 0;
      return text.replace(/\n$/, '').split('\n').length;
    },
  };
}

const MARKER = /<!--\s*cite-exempt:\s*([a-z]+)\s*(?:[—:-]\s*)?([^>]*?)\s*-->/;

function markerOn(line: string): { reason: string; note: string } | null {
  const match = MARKER.exec(line);
  if (!match) return null;
  return { reason: match[1] ?? '', note: (match[2] ?? '').trim() };
}

function stepFence(line: string, fence: string | null): { output: string; fence: string | null } {
  const opener = /^\s*(```+|~~~+)/.exec(line);
  if (fence === null) {
    if (opener) return { output: '', fence: (opener[1] ?? '').slice(0, 3) };
    return { output: line, fence: null };
  }
  const closer = /^\s*(```+|~~~+)\s*$/.exec(line);
  if (closer && (closer[1] ?? '').startsWith(fence)) return { output: '', fence: null };
  return { output: '', fence };
}

function stripFencedBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const step = stepFence(line, fence);
    out.push(step.output);
    fence = step.fence;
  }
  return out;
}

function consumeBlockComment(
  line: string,
  i: number,
): { text: string; i: number; inBlock: boolean } {
  const end = line.indexOf('*/', i);
  if (end === -1) return { text: line.slice(i), i: line.length, inBlock: true };
  return { text: line.slice(i, end), i: end + 2, inBlock: false };
}

function consumeStringChar(
  line: string,
  i: number,
  delim: string,
): { i: number; delim: string | null } {
  const ch = line[i];
  if (ch === '\\') return { i: i + 2, delim };
  if (ch === delim) return { i: i + 1, delim: null };
  return { i: i + 1, delim };
}

function consumeCode(
  line: string,
  i: number,
): { text: string; i: number; inBlock: boolean; delim: string | null } {
  const two = line.slice(i, i + 2);
  if (two === '//') return { text: line.slice(i + 2), i: line.length, inBlock: false, delim: null };
  if (two === '/*') return { text: '', i: i + 2, inBlock: true, delim: null };
  const ch = line[i];
  if (ch === '"' || ch === "'" || ch === '`')
    return { text: '', i: i + 1, inBlock: false, delim: ch };
  return { text: '', i: i + 1, inBlock: false, delim: null };
}

function scanCommentLine(line: string, inBlock: boolean): { output: string; inBlock: boolean } {
  let buf = '';
  let i = 0;
  let stringDelim: string | null = null;
  while (i < line.length) {
    if (inBlock) {
      const step = consumeBlockComment(line, i);
      buf += step.text;
      i = step.i;
      inBlock = step.inBlock;
      continue;
    }
    if (stringDelim) {
      const step = consumeStringChar(line, i, stringDelim);
      i = step.i;
      stringDelim = step.delim;
      continue;
    }
    const step = consumeCode(line, i);
    buf += step.text;
    i = step.i;
    inBlock = step.inBlock;
    stringDelim = step.delim;
  }
  return { output: buf, inBlock };
}

function stripToComments(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const step = scanCommentLine(line, inBlock);
    out.push(step.output);
    inBlock = step.inBlock;
  }
  return out;
}

const CANDIDATE_REJECTION_PATTERNS: readonly RegExp[] = [
  /[\s<>*{}()[\]|#?!,'"$\\~^`]/,
  /:\d+\s*-\s*\d+$/,
  /^[a-z][a-z0-9+.-]*:\/\//i,
];

function parseWithLineSuffix(trimmed: string): {
  rawPath: string;
  lineNumber: number | undefined;
} {
  const withLine = /^(.*?):(\d+)$/.exec(trimmed);
  return {
    rawPath: withLine ? (withLine[1] ?? '') : trimmed,
    lineNumber: withLine ? Number(withLine[2]) : undefined,
  };
}

function resolvedSegments(rawPath: string, knownRoots: ReadonlySet<string>): string[] | null {
  if (rawPath.includes(':')) return null;
  if (!/^[A-Za-z0-9._@/-]+$/.test(rawPath)) return null;
  if (rawPath.startsWith('/') || rawPath.startsWith('.')) return null;

  const segments = rawPath.split('/').filter((s) => s !== '');
  if (segments.length < 2) return null;
  const root = segments[0] ?? '';
  if (!knownRoots.has(root) && root !== LEGACY_ROOT) return null;
  return segments;
}

function parseCandidate(
  token: string,
  knownRoots: ReadonlySet<string>,
): Omit<Citation, 'file' | 'line' | 'raw'> | null {
  const trimmed = token.trim();
  if (trimmed === '' || !trimmed.includes('/')) return null;
  if (CANDIDATE_REJECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;

  const { rawPath, lineNumber } = parseWithLineSuffix(trimmed);
  const segments = resolvedSegments(rawPath, knownRoots);
  if (segments === null) return null;

  const path = segments.join('/');
  return lineNumber === undefined ? { path } : { path, lineNumber };
}

export function knownRootsFromPaths(indexedPaths: readonly string[]): ReadonlySet<string> {
  const roots = new Set<string>([LEGACY_ROOT]);
  for (const path of indexedPaths) {
    const segments = path.split('/');
    if (segments.length < 2) continue;
    const root = segments[0] ?? '';
    if (root === '' || SKIPPED_DIRS.has(root)) continue;
    roots.add(root);
  }
  return roots;
}

export function knownRootsOf(root: string): ReadonlySet<string> {
  return knownRootsFromPaths(listIndexedPaths(root));
}

export interface ExtractOptions {
  readonly file: string;
  readonly knownRoots: ReadonlySet<string>;
}

function citationsOnLine(
  rawLine: string,
  contentLine: string,
  lineNo: number,
  options: ExtractOptions,
): Citation[] {
  const citations: Citation[] = [];
  const inline = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null = inline.exec(contentLine);
  while (match !== null) {
    const parsed = parseCandidate(match[1] ?? '', options.knownRoots);
    if (parsed) {
      const marker = markerOn(rawLine);
      citations.push({
        file: options.file,
        line: lineNo,
        raw: (match[1] ?? '').trim(),
        ...parsed,
        ...(marker
          ? { exemption: { reason: marker.reason as ExemptReason, note: marker.note } }
          : {}),
      });
    }
    match = inline.exec(contentLine);
  }
  return citations;
}

function citationsFromLines(
  rawLines: readonly string[],
  contentLines: readonly string[],
  options: ExtractOptions,
): Citation[] {
  const citations: Citation[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    citations.push(...citationsOnLine(rawLines[i] ?? '', contentLines[i] ?? '', i + 1, options));
  }
  return citations;
}

export function extractCitations(markdown: string, options: ExtractOptions): Citation[] {
  const rawLines = markdown.split('\n');
  return citationsFromLines(rawLines, stripFencedBlocks(rawLines), options);
}

export function extractCodeCitations(source: string, options: ExtractOptions): Citation[] {
  const rawLines = source.split('\n');
  return citationsFromLines(rawLines, stripToComments(rawLines), options);
}

function checkExemptCitation(
  citation: Citation,
  exemption: Exemption,
  tree: TreeResolver,
  where: string,
): Violation | null {
  if (!(EXEMPT_REASONS as readonly string[]).includes(exemption.reason) || exemption.note === '') {
    return {
      kind: 'malformed-exemption',
      citation,
      message:
        `${where}: \`${citation.raw}\` carries a cite-exempt marker that is not usable. ` +
        `Reason must be one of ${EXEMPT_REASONS.join('|')} and must be followed by a written ` +
        `justification, e.g. <!-- cite-exempt: foreign — pybroker's tree, not ours -->. ` +
        `Got reason="${exemption.reason}" note="${exemption.note}".`,
    };
  }
  if (exemption.reason === 'planned' && tree.kind(citation.path) !== 'missing') {
    return {
      kind: 'stale-planned-exemption',
      citation,
      message:
        `${where}: \`${citation.raw}\` is marked \`planned\` but the path now resolves. ` +
        `Remove the marker — this is a live citation and should be checked like one.`,
    };
  }
  return null;
}

function checkResolvedCitation(
  citation: Citation,
  tree: TreeResolver,
  where: string,
): Violation | null {
  const kind = tree.kind(citation.path);
  if (kind === 'missing') {
    return {
      kind: 'missing-path',
      citation,
      message: `${where}: \`${citation.raw}\` does not resolve in the tree.`,
    };
  }
  if (citation.lineNumber === undefined) return null;
  if (kind === 'directory') {
    return {
      kind: 'line-on-directory',
      citation,
      message: `${where}: \`${citation.raw}\` cites a line number on a directory.`,
    };
  }
  const total = tree.lineCount(citation.path);
  if (citation.lineNumber > total) {
    return {
      kind: 'line-beyond-eof',
      citation,
      message: `${where}: \`${citation.raw}\` cites line ${citation.lineNumber}, but the file has ${total}.`,
    };
  }
  return null;
}

export function checkCitation(citation: Citation, tree: TreeResolver): Violation | null {
  const where = `${citation.file}:${citation.line}`;
  const exemption = citation.exemption;
  if (exemption) return checkExemptCitation(citation, exemption, tree, where);
  return checkResolvedCitation(citation, tree, where);
}

export function isPreservedByRule(repoRelativeFile: string): boolean {
  const posix = repoRelativeFile.split(sep).join('/');
  return IMMUTABLE_RECORD_DIRS.some((dir) => posix.startsWith(dir));
}

export function markdownFilesIn(indexedPaths: readonly string[]): string[] {
  return indexedPaths
    .filter((path) => path.endsWith('.md'))
    .filter((path) => !path.split('/').some((segment) => SKIPPED_DIRS.has(segment)));
}

const CODE_EXTENSION_RE = /\.tsx?$/;

export function codeFilesIn(indexedPaths: readonly string[]): string[] {
  return indexedPaths
    .filter((path) => CODE_EXTENSION_RE.test(path))
    .filter((path) => !path.split('/').some((segment) => SKIPPED_DIRS.has(segment)));
}

export interface CheckOptions {
  readonly root: string;
  readonly files?: readonly string[];
  readonly tree?: TreeResolver;
  readonly knownRoots?: ReadonlySet<string>;
  readonly indexedPaths?: readonly string[];
  readonly readMarkdown?: (repoRelativeFile: string) => string;
}

function extractorFor(
  file: string,
): ((text: string, options: ExtractOptions) => Citation[]) | null {
  if (file.endsWith('.md')) return extractCitations;
  if (CODE_EXTENSION_RE.test(file)) return extractCodeCitations;
  return null;
}

function recordCitations(
  citations: readonly Citation[],
  tree: TreeResolver,
  violations: Violation[],
  exemptByMarker: Record<ExemptReason, number>,
): void {
  for (const citation of citations) {
    const violation = checkCitation(citation, tree);
    if (violation) {
      violations.push(violation);
      continue;
    }
    const reason = citation.exemption?.reason;
    if (reason) exemptByMarker[reason]++;
  }
}

export function runCitationCheck(options: CheckOptions): Report {
  const root = resolve(options.root);
  let listing: readonly string[] | undefined = options.indexedPaths;
  const indexed = (): readonly string[] => (listing ??= listIndexedPaths(root));

  const tree = options.tree ?? createIndexResolver(root, indexed());
  const knownRoots = options.knownRoots ?? knownRootsFromPaths(indexed());
  const read = options.readMarkdown ?? ((f: string) => readFileSync(join(root, f), 'utf8'));
  const all = options.files ?? [...markdownFilesIn(indexed()), ...codeFilesIn(indexed())];

  const exemptByMarker: Record<ExemptReason, number> = {
    foreign: 0,
    historical: 0,
    planned: 0,
    untracked: 0,
  };
  const violations: Violation[] = [];
  let filesScanned = 0;
  let filesSkippedByRule = 0;
  let citationsScanned = 0;

  for (const file of all) {
    if (isPreservedByRule(file)) {
      filesSkippedByRule++;
      continue;
    }
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const extract = extractorFor(file);
    if (!extract) continue;
    filesScanned++;
    const citations = extract(text, { file, knownRoots });
    citationsScanned += citations.length;
    recordCitations(citations, tree, violations, exemptByMarker);
  }

  return { filesScanned, filesSkippedByRule, citationsScanned, exemptByMarker, violations };
}

export function formatReport(report: Report): string {
  const e = report.exemptByMarker;
  const exemptTotal = e.foreign + e.historical + e.planned + e.untracked;
  const lines = [
    'backticked-path citation check',
    `  files scanned (md/ts/tsx):   ${report.filesScanned}`,
    `  files skipped (preserved):   ${report.filesSkippedByRule}  [${IMMUTABLE_RECORD_DIRS.join(' ')}]`,
    `  citations scanned:           ${report.citationsScanned}`,
    `  exempt by marker:            ${exemptTotal}  (foreign ${e.foreign}, historical ${e.historical}, planned ${e.planned}, untracked ${e.untracked})`,
    `  violations:                  ${report.violations.length}`,
  ];
  if (report.violations.length > 0) {
    lines.push('');
    for (const v of report.violations) lines.push(`  [${v.kind}] ${v.message}`);
    lines.push('');
    lines.push(
      '  Paths resolve against the git index, never the working directory, so a file you',
      '  created in this change reads as unresolved until it is `git add`-ed.',
      '  Fix the citation, or — if it is correct as written — mark it inline with',
      '  `<!-- cite-exempt: foreign|historical|planned|untracked — why -->` (the same marker',
      '  works verbatim inside a `//` or `/* */` code comment).',
      '  NEVER edit a file under docs/adr/, docs/wayfinder/, docs/research/archive/ or',
      '  docs/reviews/ to satisfy this check: those are never scanned, and rewriting a',
      '  decision record to fix a path falsifies the record.',
    );
  }
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const report = runCitationCheck({ root });
  console.log(formatReport(report));
  if (report.violations.length > 0) process.exitCode = 1;
}
