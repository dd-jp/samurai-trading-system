/**
 * Boot-time retention sweep for `logs/` (#1116). `RotatingFileSink` bounds
 * only the one file `SAMURAI_LOG_FILE` names, so this sweep (not a second
 * rotated sink) is what reaches the hand-named files it leaves alone
 * (supervisor stdout, `service-api.log`, hand-run redirects).
 *
 * Candidacy: the directory must not be the process cwd (else it could reach
 * `.env.local`), and the name must be archival-shaped (rotated `.N` suffix
 * or datestamped) — one-directionally, so an undated bare name is never
 * unlinked on age no matter how old.
 *
 * Liveness (unlink path only): `fstatSync` identity on this process's own
 * fd 1/2 catches an inherited redirect; mtime alone is not sufficient (a
 * slow writer can outlast any window while still open, and unlinking it
 * makes the leak invisible rather than stopping it). `protectedPaths` and
 * `keepNames` are deterministic backstops on top of both signals.
 *
 * Bare names (#1206, e.g. `soak-boot.out`) can never be unlinked, so
 * `bareTruncateBytes` truncates them in place past a size threshold instead
 * — safe on an open descriptor, unlike unlink, so it carries no liveness
 * gate of its own. `bareTruncateNames` scopes it by exact basename rather
 * than by `.log`/`.out` shape alone, since that shape collides with
 * unrelated tools' files in a shared log directory.
 *
 * Eligibility and `bytesReclaimed` for a truncated file use disk allocation
 * (`stat.blocks * 512`), not `stat.size`: truncating a non-`O_APPEND`
 * writer leaves a sparse hole whose apparent size recovers on the writer's
 * next write while the freed blocks stay freed — gating on `stat.size`
 * would re-truncate (and destroy new data) on every boot after the first.
 * Verified on macOS APFS and Linux ext4 CI.
 *
 * Malformed env vars throw at boot (retention policy nobody chose); a
 * refused directory warns and sweeps nothing — this is housekeeping, and
 * aborting a trading process over housekeeping is the one outcome it must
 * never cause.
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

/** Wider than #238's 14-day soak window, so the sweep can't have already dropped its opening days by the time anyone looks */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** Matches `DEFAULT_MAX_BYTES` in `rotating-file-sink.ts` — "big enough to rotate" there is a defensible "big enough to reclaim" here (#1206) */
export const DEFAULT_BARE_TRUNCATE_BYTES = 16 * 1024 * 1024;

/**
 * Operators may extend this via `SAMURAI_LOG_BARE_TRUNCATE_NAMES` but never
 * shrink it — `soak-boot.out` is the one file #1206 names
 */
export const DEFAULT_BARE_TRUNCATE_NAMES: readonly string[] = ['soak-boot.out'];

/** POSIX `stat(2)` block size — NOT `stat.blksize` (the filesystem's preferred I/O size, 4096 here) and not `stat.size` */
const STAT_BLOCK_BYTES = 512;

const ENV_LOG_RETENTION_DAYS = 'SAMURAI_LOG_RETENTION_DAYS';
const ENV_LOG_RETENTION_KEEP = 'SAMURAI_LOG_RETENTION_KEEP';
const ENV_LOG_BARE_TRUNCATE_BYTES = 'SAMURAI_LOG_BARE_TRUNCATE_BYTES';
const ENV_LOG_BARE_TRUNCATE_NAMES = 'SAMURAI_LOG_BARE_TRUNCATE_NAMES';

/** A `RotatingFileSink` generation: `orchestrator.log.1` */
const ROTATED_GENERATION = /^.+\.log\.\d+$/;

/**
 * A finished, datestamped artefact, including a bare date with no time
 * component (`soak-20260825.log`, widened by #1206). The 8 digits must be
 * followed by `-`, `.`, or the extension's dot — never another digit — so a
 * name merely containing a long number can't pass as a datestamp.
 */
const DATESTAMPED_ARTEFACT = /^.*-\d{8}(?:[-.].*)?\.(?:log|out)$/;

/** Whether `name` is a finished log artefact eligible for age-based deletion — see the module doc's candidacy rule */
export function isArchivedLogName(name: string): boolean {
  return ROTATED_GENERATION.test(name) || DATESTAMPED_ARTEFACT.test(name);
}

/** A `.log`/`.out` name, whatever else it is — the only extensions this module ever touches */
const LOG_SHAPED_NAME = /\.(?:log|out)$/;

/**
 * The SHAPE #1206 closes: an undated bare log file that `isArchivedLogName`
 * refuses to unlink since a live writer may still hold it open. Necessary
 * but not sufficient for truncation — `bareTruncateNames` narrows further
 * by exact basename, since this shape alone matches `install.log` too.
 */
export function isBareLogName(name: string): boolean {
  return LOG_SHAPED_NAME.test(name) && !isArchivedLogName(name);
}

/** Malformed values are refused at startup rather than defaulted — this is retention policy, and a window nobody chose is worse than a named refusal */
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
 * Defaulted (not opt-in) like every other setting here, because
 * `bareTruncateNames` — not this threshold — is what scopes the blast
 * radius; see the module doc's "Bare live names" section
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
 * `DEFAULT_BARE_TRUNCATE_NAMES` plus whatever the env var adds — never
 * fewer, only ever more; `SAMURAI_LOG_RETENTION_KEEP` is the existing
 * mechanism for removing a file from eligibility instead
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

/** Basenames the operator has taken out of the sweep. Malformed entries throw rather than being silently dropped. */
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
   * file and its rotation set. Resolved before comparison.
   */
  protectedPaths?: readonly string[];
  /** Basenames in `directory` the operator has taken out of the sweep */
  keepNames?: readonly string[];
  /**
   * Disk bytes (`stat.blocks * 512`, NOT `stat.size` — see the module doc)
   * past which a bare log-shaped name in `bareTruncateNames` is truncated
   * (#1206). Undefined disables this path entirely. Independent of age/
   * `activeDescriptors`: truncation carries none of unlink's liveness hazard.
   */
  bareTruncateBytes?: number;
  /**
   * Exact-basename narrowing for the truncate path: `isBareLogName` alone
   * matches any undated `.log`/`.out` file, so this scopes the blast radius
   * to files this process actually knows about. Undefined/empty means no
   * bare name is eligible; `logBareTruncateNamesFromEnvironment` supplies
   * the default at the composition root.
   */
  bareTruncateNames?: readonly string[];
  now?: () => number;
  /** Seam for tests: stands in for `process.cwd()`, so the refusal path can be exercised without pointing a real sweep at the repo root */
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
   * A REMOVED file contributes `stat.size`. A TRUNCATED bare name contributes
   * `stat.blocks * 512` instead — apparent size recovers through a sparse
   * hole on the writer's next write, so `stat.size` there would overstate
   * what stays reclaimed (see the module doc).
   */
  bytesReclaimed: number;
  /** Bare log-shaped names truncated rather than removed (#1206) */
  filesTruncated: number;
  /** Set only when the sweep declined to look at `directory` at all */
  refusedReason?: string;
}

function defaultActiveDescriptors(): readonly FileIdentity[] {
  const identities: FileIdentity[] = [];
  for (const fd of [1, 2]) {
    try {
      const stat = fstatSync(fd);
      identities.push({ dev: stat.dev, ino: stat.ino });
    } catch {
      // Closed descriptor (EBADF): nothing to compare against, not a reason to stop
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

/** Unlink path's liveness + age gate — see the module doc's liveness rule for why descriptor identity is checked before mtime */
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
    // Tolerated by design: permission error, already gone, or a platform quirk
    return { removed: false, bytesReclaimed: 0 };
  }
  return { removed: true, bytesReclaimed: stat.size };
}

/** See `LogRetentionOptions.bareTruncateNames` for why `isBareLogName` shape alone is not narrow enough */
function isBareTruncateCandidateName(name: string, truncateNameSet: ReadonlySet<string>): boolean {
  return isBareLogName(name) && truncateNameSet.has(name);
}

function tryTruncateBareLogEntry(
  path: string,
  stat: Stats,
  bareTruncateBytes: number,
  truncate: (path: string) => void,
): { truncated: boolean; bytesReclaimed: number } {
  // Gated on disk allocation, not stat.size — see the module doc for why
  // gating on apparent size would re-truncate and destroy data every boot
  const allocatedBytes = stat.blocks * STAT_BLOCK_BYTES;
  if (allocatedBytes <= bareTruncateBytes) {
    return { truncated: false, bytesReclaimed: 0 };
  }
  try {
    truncate(path);
  } catch {
    // Tolerated by design: permission error, already gone, or a platform quirk
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
 * Deletes archival-shaped files older than `maxAgeMs` in `directory` — see
 * the module doc for candidacy and the liveness rule. Never recurses, never
 * follows a symlink, never throws: every per-file/per-listing failure is
 * tolerated, since a boot must not fail because housekeeping did.
 */
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

  for (const entry of entries) {
    // isFile() reports the DIRECTORY ENTRY's type, never a symlink's target,
    // so a symlink is skipped rather than resolved and followed — this is
    // what keeps the sweep inside `directory` structurally, not by convention
    if (!entry.isFile()) continue;
    if (keepSet.has(entry.name)) continue;

    const path = join(root, entry.name);
    if (protectedSet.has(resolve(path))) continue;

    if (isArchivedLogName(entry.name)) {
      const stat = safeStat(path);
      // Vanished between listing and stat — not this sweep's problem
      if (stat === undefined) continue;

      const outcome = tryRemoveArchivedLogEntry(path, stat, liveIdentities, cutoff, remove);
      if (outcome.removed) {
        result.filesRemoved += 1;
        result.bytesReclaimed += outcome.bytesReclaimed;
      }
      continue;
    }

    // Bare log-shaped name (#1206): no age/liveness gate — truncate never
    // orphans a writer's descriptor, so disk allocation alone decides
    // eligibility among names in truncateNameSet
    if (
      bareTruncateBytes === undefined ||
      !isBareTruncateCandidateName(entry.name, truncateNameSet)
    ) {
      continue;
    }

    const stat = safeStat(path);
    // Vanished between listing and stat — not this sweep's problem
    if (stat === undefined) continue;

    const outcome = tryTruncateBareLogEntry(path, stat, bareTruncateBytes, truncate);
    if (outcome.truncated) {
      result.filesTruncated += 1;
      result.bytesReclaimed += outcome.bytesReclaimed;
    }
  }

  return result;
}

/**
 * `sweepStaleLogs`, reported on `logger` and never throwing past this point
 * — same posture as `pruneMiArchiveWithLog`/`pruneLlmCallLogWithLog`. The
 * outer try/catch covers anything `sweepStaleLogs` itself doesn't already
 * tolerate, so a future edit can't reopen the abort-boot-over-housekeeping risk.
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
