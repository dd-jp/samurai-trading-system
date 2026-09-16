/**
 * Retention sweep for `logs/`. `RotatingFileSink` only bounds the one file
 * `SAMURAI_LOG_FILE` names; everything else left in `logs/` (redirected
 * stdout/stderr, hand-run `> logs/*.log` output, a standalone dashboard's
 * `service-api.log`) grows unbounded on a host meant to run unattended for
 * weeks. This boot-time sweep reaches those hand-named files too, which a
 * second rotated sink — which only ever bounds the one file it is told to
 * write — could not.
 *
 * ## What is even a candidate
 *
 * Two structural filters run before age is consulted at all, since both
 * failure modes below are unrecoverable:
 * - **The directory must not be the process's own cwd.** A `SAMURAI_LOG_FILE`
 *   with no directory component resolves to the repo root, which holds
 *   `.env.local`. This is a cwd check rather than a "must be named `logs`"
 *   check, since `/var/log/samurai` is a legitimate log directory too; the
 *   name rule below is what keeps non-log files ineligible regardless of path.
 * - **The name must be archival-shaped**: a `RotatingFileSink` generation
 *   (`orchestrator.log.1`) or a datestamped artefact
 *   (`orchestrator-20260902-1842.log`, or a bare date with no time
 *   component, `soak-20260825.log`). This rule is one-directional: an
 *   undated bare name (`orchestrator.log`, `service-api.log`,
 *   `soak-boot.out`) is never unlinked on age, whatever its mtime — this is
 *   what makes `.env.local` and every non-log file structurally ineligible
 *   for unlinking, not merely usually excluded. The converse does not hold:
 *   an archival-shaped name is not proof a file is finished, so liveness is
 *   still checked below.
 *
 * ## Liveness rule
 *
 * A wrong sweep deletes evidence of a run still producing it, so age alone
 * never triggers removal on the unlink path. Two independent signals gate
 * it, since no one signal covers every process writing into `logs/`:
 * - **Descriptor identity.** This process's own fd 1/2 may BE one of these
 *   files — directly under a shell redirect, or indirectly through the
 *   supervisor's `stdio: 'inherit'`, which passes descriptors to a spawned
 *   child verbatim. `fstatSync` on fd 1/2 and comparing `{dev, ino}` against
 *   each candidate catches both without knowing either filename in advance.
 * - **Recency**, for anything descriptor identity can't reach — most
 *   concretely a sibling process's own redirect target (`service-api.log`
 *   from a standalone dashboard). A process still appending keeps moving its
 *   mtime forward, so "unmodified within the window" is the operative
 *   definition of dead here.
 *
 *   Mtime alone is not sufficient even with a generous window: a barely-used
 *   writer can hold a file open for far longer than any reasonable window.
 *   Unlinking that is worse than losing the file — the writer keeps
 *   appending to the now-detached inode, so the space stays allocated but
 *   invisible until the writer exits, turning "unbounded growth" into
 *   "invisible unbounded growth". A bare name is already excluded from this
 *   path entirely by the name rule above (see "Bare live names" for what
 *   reaches it instead); for a datestamped name written by an unidentified
 *   sibling, `SAMURAI_LOG_RETENTION_KEEP` is the operator's own escape hatch.
 *
 * `protectedPaths` is a third, deterministic backstop: the caller's own
 * active sink file and its rotation generations are excluded regardless of
 * mtime, since `RotatingFileSink` owns their retirement on its own
 * count-based policy and an age-based sweep reaching into that set would
 * fight it. This tracks the *currently configured* rotation count, not
 * whatever produced the files on disk — an orphaned generation left behind
 * by a lowered `SAMURAI_LOG_MAX_FILES` falls out of `protectedPaths` and is
 * correctly left to the age window instead, since the sink will never
 * revisit it either.
 *
 * `keepNames` (`SAMURAI_LOG_RETENTION_KEEP`) is the operator's own version of
 * that backstop, for a file this process has no way to identify on its own.
 * Basenames only, never paths — the sweep never reaches outside its own
 * directory.
 *
 * ## Bare live names: truncated, not deleted
 *
 * An undated bare name is permanently ineligible for unlink by the name
 * rule above — correct, since it's what makes the descriptor gap closeable
 * at all, but it leaves a bare artefact like `soak-boot.out` itself
 * unbounded. `bareTruncateBytes` gives eligible bare names a
 * disk-allocation-based path instead: past a size threshold,
 * `truncateSync(path, 0)` rather than `remove(path)`. This is safe on a file
 * a writer still holds open in a way unlink is not — truncate changes only
 * length, never the descriptor's position, so the writer's next write lands
 * by path again rather than on a stranded inode. That safety is also why
 * this path carries none of the age/descriptor liveness gates above:
 * allocation alone decides eligibility, live or not. It carries no
 * evidence-loss protection either — `SAMURAI_LOG_RETENTION_KEEP` is how an
 * operator exempts a specific bare file from it.
 *
 * `isBareLogName` shape alone is not narrow enough to scope this path — any
 * undated `.log`/`.out` file in the swept directory matches it, unlike the
 * unlink path where an archival shape rarely collides with an unrelated
 * tool's own files (`install.log`, `wifi.log`). `bareTruncateNames`
 * (`SAMURAI_LOG_BARE_TRUNCATE_NAMES`) narrows it by an explicit basename
 * allowlist instead, defaulting to `DEFAULT_BARE_TRUNCATE_NAMES`
 * (`soak-boot.out`, the one file this mechanism exists for) — so unrelated
 * bare logs are unreachable by construction, not by an operator remembering
 * to opt in. The variable only ever extends the set, never shrinks it below
 * the default — `SAMURAI_LOG_RETENTION_KEEP` already covers exempting a
 * specific file from every path in this sweep. `protectedPaths`/`keepNames`
 * still apply on top, since `SAMURAI_LOG_FILE` itself is usually a bare name.
 *
 * Truncation is boot-time, like the rest of this sweep — a growing file is
 * only capped on a boot that happens to land after it crosses the threshold,
 * not continuously while a process keeps running.
 *
 * Eligibility and `bytesReclaimed` are measured in disk allocation
 * (`stat.blocks * 512`), never `stat.size`: a plain-redirect (`>`, not
 * `>>`) writer's fd has no `O_APPEND` and keeps its own unmoved write
 * offset, so after a truncate its next write lands past the new end of file
 * and leaves a sparse hole — `stat.size` climbs back toward its
 * pre-truncation figure on that very write even though the hole's blocks
 * stay unallocated. Gating on `stat.size` would re-truncate on every
 * subsequent boot and destroy everything appended since the last one;
 * `stat.blocks` does not have that failure mode (verified on both macOS
 * APFS and Linux ext4 — see `log-retention.test.ts`'s hole test). A side
 * effect: a truncated-then-appended file's sparse hole reads back as `\0`
 * bytes, so a plain `grep` reports it as binary — use `grep -a` or `tail -c`.
 * A removed (unlinked) file contributes its `stat.size` instead, since there
 * the whole file is gone and apparent length and disk freed agree.
 *
 * ## Failure posture
 *
 * A malformed `SAMURAI_LOG_*` environment value throws at boot — retention
 * policy nobody chose is worse than a named refusal. A refused directory,
 * or any per-file sweep failure, instead warns and does nothing:
 * housekeeping must never abort a trading process.
 */
import {
  type Dirent,
  fstatSync,
  readdirSync,
  rmSync,
  type Stats,
  statSync,
  truncateSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { nonEmpty, positiveIntegerFromEnv } from '../../shared/index.js';
import type { Logger } from './types.js';

/**
 * Wider than the 14-day soak window itself, so the sweep can't have already
 * dropped the soak's opening days by the time anyone goes looking
 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** Matches `DEFAULT_MAX_BYTES` in `rotating-file-sink.ts` — the same size treated as "big enough to rotate" there is defensible as "big enough to reclaim" here */
export const DEFAULT_BARE_TRUNCATE_BYTES = 16 * 1024 * 1024;

/**
 * Only a basename in this set is ever eligible for truncation, whatever its
 * size or age — see the module doc's "Bare live names" section. An operator
 * can extend this set via `SAMURAI_LOG_BARE_TRUNCATE_NAMES` but not shrink it.
 */
export const DEFAULT_BARE_TRUNCATE_NAMES: readonly string[] = ['soak-boot.out'];

/**
 * `stat.blocks` counts fixed 512-byte units — this is POSIX (`stat(2)`), not
 * `stat.blksize` (the filesystem's own preferred I/O size, 4096 on both APFS
 * and ext4 here), and not `stat.size`. Multiplying by anything else silently
 * misreads allocation.
 */
const STAT_BLOCK_BYTES = 512;

const ENV_LOG_RETENTION_DAYS = 'SAMURAI_LOG_RETENTION_DAYS';
const ENV_LOG_RETENTION_KEEP = 'SAMURAI_LOG_RETENTION_KEEP';
const ENV_LOG_BARE_TRUNCATE_BYTES = 'SAMURAI_LOG_BARE_TRUNCATE_BYTES';
const ENV_LOG_BARE_TRUNCATE_NAMES = 'SAMURAI_LOG_BARE_TRUNCATE_NAMES';

/** A `RotatingFileSink` generation: `orchestrator.log.1` */
const ROTATED_GENERATION = /^.+\.log\.\d+$/;

/**
 * A finished, datestamped artefact: `orchestrator-20260902-1842.log`, or a
 * bare date with no time component (`soak-20260825.log`). The eight digits
 * must be followed by `-`, `.`, or the extension's own dot — never another
 * digit — so a name merely containing a long number
 * (`orchestrator-202608251842.log`) cannot pass as a datestamp.
 */
const DATESTAMPED_ARTEFACT = /^.*-\d{8}(?:[-.].*)?\.(?:log|out)$/;

/**
 * Whether `name` is a finished log artefact, eligible for age-based deletion
 * at all — see the module doc's "What is even a candidate". Undated bare
 * names are what a live writer holds open.
 */
export function isArchivedLogName(name: string): boolean {
  return ROTATED_GENERATION.test(name) || DATESTAMPED_ARTEFACT.test(name);
}

/** A `.log`/`.out` name, whatever else it is — the only extensions this module ever touches */
const LOG_SHAPED_NAME = /\.(?:log|out)$/;

/**
 * An undated bare log file that `isArchivedLogName` refuses to unlink on
 * age. Necessary but not sufficient for truncation eligibility —
 * `bareTruncateNames` narrows further by exact basename, since this shape
 * check alone would match `install.log` as readily as `soak-boot.out`.
 */
export function isBareLogName(name: string): boolean {
  return LOG_SHAPED_NAME.test(name) && !isArchivedLogName(name);
}

/**
 * Malformed values are refused at startup rather than defaulted, matching
 * `fileSinkConfigFromEnvironment` and `miArchiveRetentionDaysFromEnvironment`:
 * this is retention policy, and a window nobody chose is worse than a
 * refusal that names the variable
 */
export function logRetentionDaysFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerFromEnv(
    env[ENV_LOG_RETENTION_DAYS],
    ENV_LOG_RETENTION_DAYS,
    DEFAULT_LOG_RETENTION_DAYS,
    1,
    "the logs/ retention sweep's window (#1116)",
  );
}

/**
 * Same refuse-rather-than-default posture as `logRetentionDaysFromEnvironment`,
 * for the threshold that decides when a bare log-shaped name gets truncated.
 * Defaulted like every other setting here, because `bareTruncateNames` is
 * what scopes the blast radius — see the module doc's "Bare live names".
 */
export function logBareTruncateBytesFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerFromEnv(
    env[ENV_LOG_BARE_TRUNCATE_BYTES],
    ENV_LOG_BARE_TRUNCATE_BYTES,
    DEFAULT_BARE_TRUNCATE_BYTES,
    1,
    'the size threshold past which an undated, allowlisted bare log file is truncated (#1206)',
  );
}

/**
 * `DEFAULT_BARE_TRUNCATE_NAMES` plus whatever `SAMURAI_LOG_BARE_TRUNCATE_NAMES`
 * adds — never fewer, only ever more, since `SAMURAI_LOG_RETENTION_KEEP`
 * already exempts any specific file from every path in this sweep. Malformed
 * entries throw rather than being silently dropped.
 */
export function logBareTruncateNamesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = nonEmpty(env[ENV_LOG_BARE_TRUNCATE_NAMES]);
  if (raw === undefined) return DEFAULT_BARE_TRUNCATE_NAMES;

  const names: string[] = [...DEFAULT_BARE_TRUNCATE_NAMES];
  for (const segment of raw.split(',')) {
    const name = segment.trim();
    if (name === '') {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_BARE_TRUNCATE_NAMES} contains an empty entry (a ` +
          'stray or trailing comma). It extends which bare log-shaped names the truncate path ' +
          '(#1206) may reach, beyond the built-in soak-boot.out, so an entry nobody meant is ' +
          'refused rather than ignored.',
      );
    }
    if (name.includes('/') || name.includes('\\')) {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_BARE_TRUNCATE_NAMES} contains ` +
          `${JSON.stringify(name)}, which is a path. The truncate path (#1206) never leaves the ` +
          'one directory it sweeps, so entries are basenames within it.',
      );
    }
    names.push(name);
  }
  return names;
}

/**
 * Basenames the operator has taken out of the sweep, from a comma-separated
 * `SAMURAI_LOG_RETENTION_KEEP`. Unset means none; malformed entries throw
 * rather than being silently dropped.
 */
export function logRetentionKeepNamesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const raw = nonEmpty(env[ENV_LOG_RETENTION_KEEP]);
  if (raw === undefined) return [];

  const names: string[] = [];
  for (const segment of raw.split(',')) {
    const name = segment.trim();
    if (name === '') {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_RETENTION_KEEP} contains an empty entry (a stray ` +
          'or trailing comma). It names files in logs/ that the retention sweep (#1116) must ' +
          'never delete, so an entry nobody meant is refused rather than ignored.',
      );
    }
    if (name.includes('/') || name.includes('\\')) {
      throw new Error(
        `Orchestrator cannot start: ${ENV_LOG_RETENTION_KEEP} contains ${JSON.stringify(name)}, ` +
          'which is a path. The retention sweep (#1116) never leaves the one directory it ' +
          'sweeps, so entries are basenames within it.',
      );
    }
    names.push(name);
  }
  return names;
}

/** Enough of `fs.Stats` to identify an open descriptor's target file */
interface FileIdentity {
  dev: number;
  ino: number;
}

export interface LogRetentionOptions {
  /** Directory swept. Never recursed into, and no entry outside it is ever touched. */
  directory: string;
  /** A file is stale once it has gone unmodified this long */
  maxAgeMs: number;
  /**
   * Paths never removed regardless of age — the caller's own active sink
   * file and its rotation set. Resolved before comparison, so relative and
   * absolute forms of the same path match.
   */
  protectedPaths?: readonly string[];
  /** Basenames in `directory` the operator has taken out of the sweep */
  keepNames?: readonly string[];
  /**
   * Disk bytes (`stat.blocks * 512`, not `stat.size` — see the module doc)
   * past which a bare log-shaped name in `bareTruncateNames` is truncated.
   * Undefined disables this path entirely. Independent of age/liveness:
   * truncation has none of unlink's liveness hazard, so eligibility is
   * allocation alone.
   */
  bareTruncateBytes?: number;
  /**
   * The truncate path's own name-based narrowing: only a basename in this
   * set is ever a candidate, since `isBareLogName` alone matches any undated
   * `.log`/`.out` file. Undefined or empty means no bare name is eligible —
   * see the module doc's "Bare live names" section.
   */
  bareTruncateNames?: readonly string[];
  now?: () => number;
  /**
   * Seam for tests: stands in for `process.cwd()`. Injected rather than read
   * directly so the refusal can be exercised — and mutated — without ever
   * pointing a real sweep at the repo root.
   */
  cwd?: () => string;
  /** Seam for tests: stands in for `fstatSync(1)` / `fstatSync(2)` */
  activeDescriptors?: () => readonly FileIdentity[];
  /** Seam for tests: stands in for `rmSync` */
  remove?: (path: string) => void;
  /** Seam for tests: stands in for `truncateSync(path, 0)` */
  truncate?: (path: string) => void;
}

export interface LogRetentionResult {
  filesRemoved: number;
  /**
   * A removed file contributes `stat.size`; a truncated bare name contributes
   * `stat.blocks * 512` instead — see the module doc's "Bare live names" for
   * why `stat.size` would overstate what actually stays reclaimed there
   */
  bytesReclaimed: number;
  /** Bare log-shaped names truncated rather than removed */
  filesTruncated: number;
  /**
   * Set when the sweep declined to look at `directory` at all. Present only
   * on a refusal, so a caller comparing against `{filesRemoved, bytes}` still
   * matches every ordinary outcome.
   */
  refusedReason?: string;
}

function defaultActiveDescriptors(): readonly FileIdentity[] {
  const identities: FileIdentity[] = [];
  for (const fd of [1, 2]) {
    try {
      const stat = fstatSync(fd);
      identities.push({ dev: stat.dev, ino: stat.ino });
    } catch {
      // Closed descriptor (EBADF) or one this platform can't stat — nothing
      // to compare candidate files against, not a reason to stop sweeping
    }
  }
  return identities;
}

/** `statSync`, tolerating a file that vanished between listing and stat (not this sweep's problem) */
function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The unlink path's own liveness + age gate and the `remove` call, pulled out
 * of `sweepStaleLogs`'s loop — see the module doc's "Liveness rule" for why
 * both descriptor identity and mtime are checked, and in that order
 */
function tryRemoveArchivedLogEntry(
  path: string,
  stat: Stats,
  liveIdentities: readonly FileIdentity[],
  cutoff: number,
  remove: (path: string) => void,
): { removed: boolean; bytesReclaimed: number } {
  if (liveIdentities.some((id) => id.dev === stat.dev && id.ino === stat.ino)) {
    return { removed: false, bytesReclaimed: 0 };
  }
  if (stat.mtimeMs >= cutoff) {
    return { removed: false, bytesReclaimed: 0 };
  }
  try {
    remove(path);
  } catch {
    // Permission error, already gone, or a platform quirk — tolerated by design
    return { removed: false, bytesReclaimed: 0 };
  }
  return { removed: true, bytesReclaimed: stat.size };
}

/**
 * The truncate path's own name-based narrowing — see
 * `LogRetentionOptions.bareTruncateNames`'s doc for why `isBareLogName`
 * shape alone is not narrow enough on its own
 */
function isBareTruncateCandidateName(name: string, truncateNameSet: ReadonlySet<string>): boolean {
  return isBareLogName(name) && truncateNameSet.has(name);
}

/**
 * The truncate path's own allocation gate and the `truncate` call, pulled out
 * of `sweepStaleLogs`'s loop
 */
function tryTruncateBareLogEntry(
  path: string,
  stat: Stats,
  bareTruncateBytes: number,
  truncate: (path: string) => void,
): { truncated: boolean; bytesReclaimed: number } {
  // Gated on disk allocation (`stat.blocks`), not apparent length
  // (`stat.size`) — see the module doc's "Bare live names" for why gating
  // on size would re-truncate and destroy appended data every boot
  const allocatedBytes = stat.blocks * STAT_BLOCK_BYTES;
  if (allocatedBytes <= bareTruncateBytes) {
    return { truncated: false, bytesReclaimed: 0 };
  }
  try {
    truncate(path);
  } catch {
    // Permission error, already gone, or a platform quirk — tolerated by design
    return { truncated: false, bytesReclaimed: 0 };
  }
  return { truncated: true, bytesReclaimed: allocatedBytes };
}

/** `LogRetentionOptions` with every optional field defaulted, resolved once up front */
interface ResolvedSweepOptions {
  directory: string;
  maxAgeMs: number;
  bareTruncateBytes: number | undefined;
  protectedPaths: readonly string[];
  keepNames: readonly string[];
  bareTruncateNames: readonly string[];
  now: () => number;
  cwd: () => string;
  activeDescriptors: () => readonly FileIdentity[];
  remove: (path: string) => void;
  truncate: (path: string) => void;
}

function resolveSweepOptions(options: LogRetentionOptions): ResolvedSweepOptions {
  const {
    directory,
    maxAgeMs,
    protectedPaths = [],
    keepNames = [],
    bareTruncateBytes,
    bareTruncateNames = [],
    now = Date.now,
    cwd = process.cwd,
    activeDescriptors = defaultActiveDescriptors,
    remove = (path: string) => rmSync(path),
    truncate = (path: string) => truncateSync(path, 0),
  } = options;
  return {
    directory,
    maxAgeMs,
    bareTruncateBytes,
    protectedPaths,
    keepNames,
    bareTruncateNames,
    now,
    cwd,
    activeDescriptors,
    remove,
    truncate,
  };
}

/**
 * Deletes archival-shaped files in `directory` whose mtime is older than
 * `maxAgeMs` — see the module doc for what makes a candidate and the
 * liveness rule. Every per-file and per-listing failure is tolerated rather
 * than propagated: a boot must not fail because housekeeping did.
 */
function sweepOneEntry(
  entry: Dirent,
  result: LogRetentionResult,
  ctx: {
    root: string;
    keepSet: ReadonlySet<string>;
    protectedSet: ReadonlySet<string>;
    truncateNameSet: ReadonlySet<string>;
    bareTruncateBytes: number | undefined;
    liveIdentities: readonly FileIdentity[];
    cutoff: number;
    remove: (path: string) => void;
    truncate: (path: string) => void;
  },
): void {
  // `isFile()` reports the type of the directory entry, never a symlink's
  // target, so a symlink is skipped rather than resolved and followed —
  // this is what keeps the sweep inside `directory` structurally
  if (!entry.isFile()) return;
  if (ctx.keepSet.has(entry.name)) return;

  const path = join(ctx.root, entry.name);
  if (ctx.protectedSet.has(resolve(path))) return;

  if (isArchivedLogName(entry.name)) {
    const stat = safeStat(path);
    // Vanished between listing and stat — not this sweep's problem
    if (stat === undefined) return;
    const outcome = tryRemoveArchivedLogEntry(
      path,
      stat,
      ctx.liveIdentities,
      ctx.cutoff,
      ctx.remove,
    );
    if (outcome.removed) {
      result.filesRemoved += 1;
      result.bytesReclaimed += outcome.bytesReclaimed;
    }
    return;
  }

  // Bare log-shaped name: no age or liveness gate, since `truncate` never
  // orphans a writer's descriptor (see the module doc). `truncateNameSet`
  // is the separate narrowing that keeps `isBareLogName`'s blast radius to
  // files this process actually knows about
  if (
    ctx.bareTruncateBytes === undefined ||
    !isBareTruncateCandidateName(entry.name, ctx.truncateNameSet)
  ) {
    return;
  }

  const stat = safeStat(path);
  // Vanished between listing and stat — not this sweep's problem
  if (stat === undefined) return;
  const outcome = tryTruncateBareLogEntry(path, stat, ctx.bareTruncateBytes, ctx.truncate);
  if (outcome.truncated) {
    result.filesTruncated += 1;
    result.bytesReclaimed += outcome.bytesReclaimed;
  }
}

export function sweepStaleLogs(options: LogRetentionOptions): LogRetentionResult {
  const {
    directory,
    maxAgeMs,
    protectedPaths,
    keepNames,
    bareTruncateBytes,
    bareTruncateNames,
    now,
    cwd,
    activeDescriptors,
    remove,
    truncate,
  } = resolveSweepOptions(options);

  const result: LogRetentionResult = { filesRemoved: 0, bytesReclaimed: 0, filesTruncated: 0 };
  const root = resolve(directory);
  if (root === resolve(cwd())) {
    return {
      ...result,
      refusedReason:
        `${root} is this process's working directory, not a dedicated log directory — ` +
        'a SAMURAI_LOG_FILE with no directory component resolves here, and here is where ' +
        '.env.local lives',
    };
  }
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
  const keepSet = new Set(keepNames);
  const truncateNameSet = new Set(bareTruncateNames);
  const liveIdentities = activeDescriptors();
  const cutoff = now() - maxAgeMs;

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // Missing or unreadable logs/ — nothing to sweep
    return result;
  }

  const ctx = {
    root,
    keepSet,
    protectedSet,
    truncateNameSet,
    bareTruncateBytes,
    liveIdentities,
    cutoff,
    remove,
    truncate,
  };
  for (const entry of entries) {
    sweepOneEntry(entry, result, ctx);
  }

  return result;
}

/**
 * `sweepStaleLogs`, reported on `logger` and never throwing past this point —
 * a throw here at boot would abort a trading process over housekeeping.
 * This wrapper's own try/catch covers anything unanticipated beyond what
 * `sweepStaleLogs` itself already tolerates.
 */
export function sweepStaleLogsWithLog(
  options: LogRetentionOptions,
  logger: Logger,
): LogRetentionResult {
  try {
    const result = sweepStaleLogs(options);
    if (result.refusedReason !== undefined) {
      logger.log({
        trace_id: 'startup',
        stage: 'orchestrator',
        event: 'log_retention_refused',
        level: 'warn',
        message: `logs/ retention sweep refused to sweep ${options.directory} — growth there is unbounded until SAMURAI_LOG_FILE names a dedicated log directory`,
        payload: { directory: options.directory, reason: result.refusedReason },
      });
      return result;
    }
    if (result.filesRemoved > 0 || result.filesTruncated > 0) {
      logger.log({
        trace_id: 'startup',
        stage: 'orchestrator',
        level: 'info',
        message: `logs/ retention sweep removed ${result.filesRemoved} stale file(s) and truncated ${result.filesTruncated} bare file(s)`,
        payload: {
          files_removed: result.filesRemoved,
          files_truncated: result.filesTruncated,
          bytes_reclaimed: result.bytesReclaimed,
        },
      });
    }
    return result;
  } catch (error) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'log_retention_failed',
      level: 'warn',
      message:
        'logs/ retention sweep failed — logging continues, but growth in logs/ is unbounded ' +
        'until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return { filesRemoved: 0, bytesReclaimed: 0, filesTruncated: 0 };
  }
}
