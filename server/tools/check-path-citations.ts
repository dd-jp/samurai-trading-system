/**
 * Backticked-path citation checker (#821, successor to #645).
 *
 * Inline backticked path citations — `` `server/pipeline/verdict/index.ts:44` `` — are
 * load-bearing evidence in this repo's decision records: a reader who cannot resolve the
 * path cannot check the reasoning. Nothing validated them before this file, and markdown
 * link checkers structurally cannot, because these are not links.
 *
 * ## The central risk, and the design that answers it
 *
 * A checker like this fails in one of two directions, and both are worse than having no
 * checker at all:
 *
 *  - **Noise.** It fires on citations that are correct-as-written, everyone learns to
 *    ignore the red, and the check gets deleted or `|| true`-d.
 *  - **Audit-trail falsification.** Someone "fixes" an ADR's path to satisfy it. The
 *    2026-08-16 triage established that rewriting a decision record to fix a path
 *    falsifies the record — the ADR said what it said, at the tree it said it about.
 *
 * So the rules are deliberately asymmetric, and the whole file errs toward false
 * negatives (a stale citation slipping through) over false positives (a correct citation
 * flagged). Concretely:
 *
 *  1. `IMMUTABLE_RECORD_DIRS` are not parsed at all. Four directories, listed once, and
 *     that list is the only blanket suppression in the design. It exists precisely so
 *     that no future contributor is ever handed a red CI run whose cheapest fix is to
 *     edit a decision record.
 *  2. Everything else silences per citation, via an inline `<!-- cite-exempt: ... -->`
 *     marker carrying a reason and a written justification. An exemption is therefore a
 *     visible line in a diff with a sentence attached, not a directory quietly added to
 *     a list.
 *  3. Extraction is narrow by construction (see `parseCandidate`). A token has to look
 *     unambiguously like a repo-relative path before it is a citation at all.
 *
 * The `planned` reason inverts: a `planned` citation FAILS once its path starts
 * resolving. Without that, the widest exemption in the set would silently outlive its own
 * truth — `invalidation` ships, and a marker asserting the path does not exist yet stays
 * on a live citation forever. It is the one exemption that clears itself.
 *
 * ## The tree is the git index, never the working directory (#866)
 *
 * Existence is resolved against `git ls-files --cached`, and the set of markdown files
 * scanned and the set of known top-level roots are derived from that same listing. The
 * working directory is read for exactly one thing: the CONTENT of an indexed file, to
 * count its lines.
 *
 * It used to `statSync` the working directory instead, and #866 measured what that cost.
 * A citation's root had to exist for the citation to be extracted at all, so on a clean
 * checkout the repo had 261 citations and 0 violations, and on a checkout carrying the
 * gitignored `data/` a paper run leaves behind it had 268 and 4. Same commit, two
 * answers. "0 violations" was not a fact about the repository but about which modes had
 * been run on one machine. Worse in the other direction: `data/samurai-paper.sqlite`
 * *resolved* on a machine that had run paper mode, so a citation to a runtime artefact
 * was judged by whether the artefact happened to have been produced.
 *
 * The index fixes that by construction rather than by enumeration: it contains no
 * gitignored path and no runtime output, so the report is a pure function of the index
 * plus the content of the files it lists. No list of runtime directories to keep current,
 * and no gitignore parser.
 *
 * `--cached` alone, deliberately — NOT `--others --exclude-standard`. Untracked-but-not-
 * ignored files are still runtime state as far as this checker is concerned, and letting
 * them in would re-open the same hole through the `planned` rule: scaffold
 * `server/pipeline/invalidation/index.ts` locally without staging it and every `planned`
 * marker on that path turns into a `stale-planned-exemption` — green on a clean checkout,
 * red on a machine where work has happened, which is exactly the bug being fixed here.
 *
 * Two accepted costs, both in the direction this file is allowed to err:
 *
 *  - A file created and cited in the same change reads as unresolved until it is
 *    `git add`-ed. A transient false positive with a one-word fix, and the only one.
 *  - A new, unstaged `.md` is not scanned at all — a false negative, which is the safe
 *    direction, and it clears itself the moment the file is staged.
 *
 * And one real narrowing: the checker now REQUIRES a git checkout and fails loudly
 * outside one (a tarball export, a vendored copy). Falling back to the filesystem there
 * would silently restore the flip, so it throws instead.
 *
 * ## Known, deliberate gap
 *
 * Line validation is end-of-file validation: a `path:44` citation fails if the file has
 * fewer than 44 lines. It does NOT verify that line 44 still holds the cited *symbol* —
 * the citation does not carry a symbol name, and any heuristic that scraped one out of
 * the surrounding prose would be a false-positive generator, which is the direction this
 * file is explicitly not allowed to err in.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Directories whose contents are preserved by rule and are therefore never parsed.
 *
 * This list is the checker's only blanket suppression and it must stay exactly this
 * long. If a future change wants to add a fifth directory to make the check go quiet,
 * that is the widening this ticket was written against — use a per-citation marker
 * instead, which costs one line and a sentence of justification.
 */
export const IMMUTABLE_RECORD_DIRS = [
  'docs/adr/',
  'docs/wayfinder/',
  'docs/research/archive/',
  'docs/reviews/',
] as const;

/**
 * Directory names excluded from the scanned file set and from the known roots.
 *
 * Every entry here is TRACKED — that is the only reason an entry is needed at all. The
 * listing is the git index, so `node_modules`, `dist`, `coverage`, `graphify-out`,
 * `.git` and `.vitest-reports` are structurally unreachable and were dropped from this
 * set when #866 moved resolution onto the index; verified with `git ls-files` that not
 * one of them has a tracked file. Do not re-add them: an entry that can never match is
 * an entry a reader has to disprove.
 *
 * `.claude/` and `.yarn/` appear in `.gitignore` yet have tracked files under them —
 * an explicit `git add` beats an ignore rule — so both are still load-bearing here.
 */
const SKIPPED_DIRS = new Set([
  // Agent skills and yarn's vendored releases: tracked, but not this repo's prose or
  // source, and neither is ever the subject of a citation.
  '.claude',
  '.yarn',
  // Fixture markdown deliberately contains citations that do NOT resolve — that is what
  // it is for. Scanning it would make the checker flag its own test data on every run.
  // Do not remove this entry without moving the fixtures somewhere else first.
  '__fixtures__',
]);

/** Legacy top-level source root, removed by #627. Kept so `src/…` citations stay in scope. */
const LEGACY_ROOT = 'src';

export const EXEMPT_REASONS = ['foreign', 'historical', 'planned', 'untracked'] as const;
export type ExemptReason = (typeof EXEMPT_REASONS)[number];

export interface Exemption {
  readonly reason: ExemptReason;
  readonly note: string;
}

export interface Citation {
  /** Repo-relative path of the markdown file the citation was written in. */
  readonly file: string;
  /** 1-based line within that markdown file. */
  readonly line: number;
  /** The citation exactly as it appears between the backticks. */
  readonly raw: string;
  /** The path part, with any trailing `:line` and trailing slash removed. */
  readonly path: string;
  /** The cited line number, when the citation carried one. */
  readonly lineNumber?: number;
  /** Set when an in-document marker exempts this citation. */
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

/** What the tree says about a cited path. Injected so tests can run against fixtures. */
export interface TreeResolver {
  kind(repoRelativePath: string): 'file' | 'directory' | 'missing';
  lineCount(repoRelativePath: string): number;
}

/**
 * Every path in the git index of the checkout at `root`, repo-relative, `/`-separated.
 *
 * `-z` because a NUL-separated listing needs no unquoting and cannot be confused by a
 * path containing a quote or a newline. Deliberately not memoized: a module-level cache
 * would make the invariance test vacuous — it would pass by never re-listing rather than
 * because the property holds. One `git` call per run, which measures faster than the
 * recursive directory walk it replaced.
 */
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

/**
 * A resolver whose existence answers come from the index and whose line counts come from
 * disk.
 *
 * A path is a directory when the index holds something beneath it: git stores no
 * directory entries, so `docs/specs` is real exactly because `docs/specs/foo.md` is.
 */
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
        // Indexed but not readable on disk — a tracked file deleted in the working tree
        // with the deletion unstaged. Existence and content now come from different
        // places, so this case exists where it could not before. Report a length no
        // citation can exceed: the checker errs toward the false negative, and crashing
        // the whole run over one locally-deleted file is the worst available outcome.
        return Number.MAX_SAFE_INTEGER;
      }
      // A trailing newline terminates the last line rather than starting an empty one,
      // so `a\nb\n` is 2 lines, not 3 — cite `b` as `:2` and it must pass.
      if (text === '') return 0;
      return text.replace(/\n$/, '').split('\n').length;
    },
  };
}

const MARKER = /<!--\s*cite-exempt:\s*([a-z]+)\s*(?:[—:-]\s*)?([^>]*?)\s*-->/;

/**
 * Marker scope is exactly one line: the line the marker is written on.
 *
 * Line scope is the smallest scope that is still writable everywhere a citation can
 * appear. Prose in this repo is written one paragraph per line, so a paragraph is
 * covered by one marker; and a markdown table row is covered by appending the marker
 * after the row's final `|`, which GFM discards as an excess cell (a row with more cells
 * than the header row has the excess ignored) rather than rendering. A comment on its
 * own line inside a table body would end the table, so per-row is the only safe form
 * there — and per-row is what makes mixed tables work at all, where one row is `planned`
 * and the next cites a file that already exists.
 *
 * There is deliberately no file-scoped or block-scoped form. An exemption has to be
 * attached to the citation it excuses.
 *
 * The known cost: a marker covers every citation on its line, so a correct citation
 * sharing a line with an exempt one stops being checked. On the tree at the time this
 * landed that was 4 citations out of 261 (~1.5%). Narrowing the marker to a single named
 * path would recover them, at the price of a marker that goes stale silently when the
 * prose around it is edited — a false-positive source, which is the direction this
 * checker is not allowed to err in.
 *
 * Append the marker to the end of the cited line; never put it at the start. A comment
 * that opens a line opens a CommonMark HTML block, and the rest of that line stops being
 * parsed as markdown — links, emphasis and backticks in it render as literal text.
 */
function markerOn(line: string): { reason: string; note: string } | null {
  const match = MARKER.exec(line);
  if (!match) return null;
  return { reason: match[1] ?? '', note: (match[2] ?? '').trim() };
}

/** Blanks out fenced code blocks so inline-looking backticks inside them are not scanned. */
function stripFencedBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const opener = /^\s*(```+|~~~+)/.exec(line);
    if (fence === null) {
      if (opener) {
        fence = (opener[1] ?? '').slice(0, 3);
        out.push('');
        continue;
      }
      out.push(line);
    } else {
      const closer = /^\s*(```+|~~~+)\s*$/.exec(line);
      if (closer && (closer[1] ?? '').startsWith(fence)) fence = null;
      out.push('');
    }
  }
  return out;
}

/**
 * Whether a backticked token is a repo path citation.
 *
 * Deliberately strict — every rejection here is a false negative accepted on purpose:
 *
 *  - **At least two non-empty segments.** A bare top-level directory is a concept token,
 *    not a citation. CLAUDE.md literally asserts *"There is no root `src/`"*; demanding
 *    that `src/` resolve would be demanding the sentence create what it denies.
 *  - **Known first segment.** A directory that exists at the repo root today, or the
 *    legacy `src`. This keeps `application/json`, `req/min` and `crypto/stocks` out
 *    without a hand-maintained denylist, and it means a citation under a top-level name
 *    that never existed is ignored rather than flagged — cheap, and on the safe side.
 *  - **No metacharacters.** `docs/specs/<stage>-spec.md`, globs and anchored paths are
 *    templates or fragments, not citations of a concrete file.
 *  - **No line ranges.** `foo.ts:10-20` is skipped outright rather than mis-parsed into
 *    a path ending in `:10-20`.
 */
function parseCandidate(
  token: string,
  knownRoots: ReadonlySet<string>,
): Omit<Citation, 'file' | 'line' | 'raw'> | null {
  const trimmed = token.trim();
  if (trimmed === '' || !trimmed.includes('/')) return null;
  if (/[\s<>*{}()[\]|#?!,'"$\\~^`]/.test(trimmed)) return null;
  if (/:\d+\s*-\s*\d+$/.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

  const withLine = /^(.*?):(\d+)$/.exec(trimmed);
  const rawPath = withLine ? (withLine[1] ?? '') : trimmed;
  const lineNumber = withLine ? Number(withLine[2]) : undefined;
  if (rawPath.includes(':')) return null;
  if (!/^[A-Za-z0-9._@/-]+$/.test(rawPath)) return null;
  if (rawPath.startsWith('/') || rawPath.startsWith('.')) return null;

  const segments = rawPath.split('/').filter((s) => s !== '');
  if (segments.length < 2) return null;
  const root = segments[0] ?? '';
  if (!knownRoots.has(root) && root !== LEGACY_ROOT) return null;

  const path = segments.join('/');
  return lineNumber === undefined ? { path } : { path, lineNumber };
}

/**
 * Top-level directories that exist in the index, plus the legacy root.
 *
 * This is the half of the checker #866 measured the flip on: a `data/` produced by a
 * paper run made `data` a known root, which made seven previously-ignored tokens into
 * citations. Directories are known because the index lists a file beneath them, so no
 * amount of runtime output can add one.
 *
 * There is no dotfile rule any more. `.github/**` is tracked, so the listing supplies
 * that root the same way it supplies `server`; the two tracked dot-directories that are
 * NOT wanted (`.claude`, `.yarn`) are named in `SKIPPED_DIRS`, and every other dot
 * directory is untracked and therefore already absent.
 */
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

export function extractCitations(markdown: string, options: ExtractOptions): Citation[] {
  const rawLines = markdown.split('\n');
  const lines = stripFencedBlocks(rawLines);
  const citations: Citation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const inline = /`([^`\n]+)`/g;
    let match: RegExpExecArray | null = inline.exec(lines[i] ?? '');
    while (match !== null) {
      const parsed = parseCandidate(match[1] ?? '', options.knownRoots);
      if (parsed) {
        const marker = markerOn(rawLines[i] ?? '');
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
      match = inline.exec(lines[i] ?? '');
    }
  }
  return citations;
}

export function checkCitation(citation: Citation, tree: TreeResolver): Violation | null {
  const where = `${citation.file}:${citation.line}`;
  const exemption = citation.exemption;

  if (exemption) {
    if (
      !(EXEMPT_REASONS as readonly string[]).includes(exemption.reason) ||
      exemption.note === ''
    ) {
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

export function isPreservedByRule(repoRelativeFile: string): boolean {
  const posix = repoRelativeFile.split(sep).join('/');
  return IMMUTABLE_RECORD_DIRS.some((dir) => posix.startsWith(dir));
}

/**
 * The markdown to scan: tracked `.md`, minus anything under a skipped directory.
 *
 * Taking the file set from the index too — not just the resolution of the paths inside
 * it — is what makes `filesScanned` a repository fact. A walker would also pick up an
 * ignored `.md` dropped into the checkout by a tool, and the scanned count would move
 * again for a reason having nothing to do with the repository.
 */
export function markdownFilesIn(indexedPaths: readonly string[]): string[] {
  return indexedPaths
    .filter((path) => path.endsWith('.md'))
    .filter((path) => !path.split('/').some((segment) => SKIPPED_DIRS.has(segment)));
}

export interface CheckOptions {
  readonly root: string;
  /** Repo-relative markdown files to scan. Defaults to every tracked `.md` under `root`. */
  readonly files?: readonly string[];
  readonly tree?: TreeResolver;
  readonly knownRoots?: ReadonlySet<string>;
  /** The git index listing. Defaults to `git ls-files --cached` run against `root`. */
  readonly indexedPaths?: readonly string[];
  /** Where citation text is read from. Defaults to the real filesystem under `root`. */
  readonly readMarkdown?: (repoRelativeFile: string) => string;
}

export function runCitationCheck(options: CheckOptions): Report {
  const root = resolve(options.root);
  // Lazy: a caller that supplies the tree, the roots and the file list is running against
  // fixtures and must not be made to shell out to git for a listing it never reads.
  let listing: readonly string[] | undefined = options.indexedPaths;
  const indexed = (): readonly string[] => (listing ??= listIndexedPaths(root));

  const tree = options.tree ?? createIndexResolver(root, indexed());
  const knownRoots = options.knownRoots ?? knownRootsFromPaths(indexed());
  const read = options.readMarkdown ?? ((f: string) => readFileSync(join(root, f), 'utf8'));
  const all = options.files ?? markdownFilesIn(indexed());

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
    filesScanned++;
    const citations = extractCitations(read(file), { file, knownRoots });
    citationsScanned += citations.length;
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

  return { filesScanned, filesSkippedByRule, citationsScanned, exemptByMarker, violations };
}

export function formatReport(report: Report): string {
  const e = report.exemptByMarker;
  const exemptTotal = e.foreign + e.historical + e.planned + e.untracked;
  const lines = [
    'backticked-path citation check',
    `  markdown files scanned:      ${report.filesScanned}`,
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
      '  `<!-- cite-exempt: foreign|historical|planned|untracked — why -->`.',
      '  NEVER edit a file under docs/adr/, docs/wayfinder/, docs/research/archive/ or',
      '  docs/reviews/ to satisfy this check: those are never scanned, and rewriting a',
      '  decision record to fix a path falsifies the record.',
    );
  }
  return lines.join('\n');
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  const root = process.argv[2] ?? process.cwd();
  const report = runCitationCheck({ root });
  console.log(formatReport(report));
  if (report.violations.length > 0) process.exitCode = 1;
}
