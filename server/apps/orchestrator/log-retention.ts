/**
 * Retention sweep for `logs/` (#1116).
 *
 * `RotatingFileSink` (`./rotating-file-sink.ts`) bounds exactly one file:
 * whatever `SAMURAI_LOG_FILE` names. Everything else a run leaves in `logs/`
 * — a supervisor's own stdout/stderr under a shell redirect, an
 * orchestrator's stdout under a hand-run `> logs/orchestrator-DATE.log`, a
 * standalone dashboard's `service-api.log` — is never touched by it, because
 * the sink only recognises its own `.1`…`.N` suffixes. Left alone those grow
 * without bound on a host meant to run unattended for weeks (#238).
 *
 * This is the "small retention sweep on boot" the ticket asks for rather than
 * a second rotated sink, specifically because it is the only shape that also
 * reaches the hand-named files above — a rotated sink only ever bounds the
 * file it was told to write.
 *
 * ## What is even a candidate
 *
 * Two structural filters run before age is consulted at all, because both
 * failure modes below are unrecoverable and neither is caught by sizing the
 * window:
 *
 * - **The directory must not be the process's own working directory.**
 *   `SAMURAI_LOG_FILE` is taken verbatim, so a value with no directory
 *   component (`orchestrator.log`) makes the caller's `dirname` yield `.` —
 *   the repo root the supervisor spawns from, holding `.env.local` (the
 *   gitignored credential file this process boots from) and root-level
 *   `soak-*.log` evidence. Refused, warned about, and swept-nothing. This is
 *   a cwd check rather than a "must contain a `logs` segment" check because
 *   `/var/log/samurai` is a legitimate place to point a log directory, and
 *   the name rule below — not the path — is what makes a non-log file
 *   ineligible no matter where the sweep is aimed, including an absolute
 *   `SAMURAI_LOG_FILE` naming the repo root from some other cwd, which no
 *   cwd comparison can catch.
 * - **The name must be archival-shaped**: either a `RotatingFileSink`
 *   generation (`orchestrator.log.1`) or a datestamped artefact
 *   (`orchestrator-20260902-1842.log`, `supervisor-20260904-1020-v3.log`,
 *   `soak-boot-20260903-1007.out`). Every file a run finishes with carries
 *   one of those two shapes; the files a run is still WRITING carry the
 *   undated bare name (`orchestrator.log`, `service-api.log`,
 *   `soak-boot.out`). Making an undated bare name ineligible for age-based
 *   deletion outright is what closes the descriptor gap below structurally
 *   instead of probabilistically, and it makes `.env.local`, `LICENSE` and
 *   every other non-log file ineligible as a side effect of the same rule.
 *
 * ## Liveness rule
 *
 * A wrong sweep deletes evidence of a run that is still producing it, so
 * "old" is deliberately not the only test. Two independent signals decide
 * whether a candidate file is currently being written, because no single one
 * covers every process that writes into `logs/`:
 *
 * - **Descriptor identity.** This process's own stdout/stderr (fd 1 and 2)
 *   may BE one of these files: directly, under a shell redirect
 *   (`yarn orchestrator > logs/orchestrator-DATE.log`), or indirectly, under
 *   the supervisor's `stdio: 'inherit'` — a spawned child inherits its
 *   parent's descriptors verbatim, so the orchestrator's fd 1/2 are the exact
 *   same open file as the supervisor's own redirect target
 *   (`supervisor-*.log`) when launched via `yarn serve`. `fstatSync` on those
 *   two descriptors and comparing `{dev, ino}` against each candidate file
 *   catches both cases without knowing either filename in advance. A
 *   descriptor that is a TTY, a pipe, or closed (`EBADF`) simply contributes
 *   nothing to compare against, so the check is inert rather than wrong when
 *   stdout isn't redirected to a regular file.
 * - **Recency.** Anything this process cannot identify by descriptor — most
 *   concretely, a sibling process's own redirect target when it is not the
 *   parent or child of this one (`service-api.log` from a dashboard started
 *   standalone, outside `yarn serve`) — is judged by mtime instead: a process
 *   still appending to a file keeps moving its mtime forward, so "not written
 *   to inside the retention window" is the operative definition of dead for a
 *   file this process has no other way to identify.
 *
 *   Mtime alone is not sufficient, and a generous window does not rescue it:
 *   a file can be open and slow. The real `logs/service-api.log` is 85 bytes
 *   nine days after its last line, so a barely-used writer crosses any window
 *   as a matter of course while still holding the file open. Unlinking that
 *   is worse than losing a file: the writer keeps appending to the now
 *   unlinked inode, so the space stays allocated but invisible to `ls`/`du`
 *   and the content is unrecoverable when the writer exits — the fix for
 *   unbounded growth would become invisible unbounded growth. What makes
 *   this unreachable is the archival-name rule above, not the window:
 *   `service-api.log` is an undated bare name and can never be a candidate.
 *   Recency is the last check on files that already look finished, not the
 *   thing standing between a live writer and deletion.
 *
 * `protectedPaths` is a third, deterministic backstop: this process's OWN
 * configuration can name a file outright (the active rotating sink's path,
 * and its `.1`…`.maxRotatedFiles` generations, which are `RotatingFileSink`'s
 * to retire on its own count-based policy — a second, age-based policy
 * reaching into that set would fight it). Those paths are excluded
 * regardless of mtime, covering a sink that has been quiet for the entire
 * retention window — first boot after long dormancy, before this run's first
 * line lands — with no dependence on the descriptor or recency checks above.
 * That protection tracks the CURRENTLY CONFIGURED `maxRotatedFiles`, not
 * whatever cap produced the files on disk: lower `SAMURAI_LOG_MAX_FILES`
 * after running with a higher one and the orphaned higher-numbered
 * generations fall outside `protectedPaths` on the next boot, because the
 * sink itself will never revisit them again either — the age window is the
 * only thing left bounding them, which is the correct owner once a
 * generation is orphaned like this, not a gap. That last part holds only
 * while `SAMURAI_LOG_FILE` ends in `.log`: point the sink at some other
 * extension and its generations match neither eligible shape, so orphans of
 * it are never swept at all. Erring towards keeping them is the safe
 * direction, and widening the rule to any `<name>.<ext>.<n>` would admit
 * archives that are not logs.
 *
 * `keepNames` (`SAMURAI_LOG_RETENTION_KEEP`) is the operator's own version of
 * that backstop, for the file this process has no way to know about: a
 * long-running writer whose artefact happens to be datestamped, or evidence
 * being kept deliberately past the window. Basenames in the swept directory,
 * never paths — a path would imply the sweep reaches outside the directory,
 * which nothing here does.
 *
 * Two failure postures, deliberately different: a malformed
 * `SAMURAI_LOG_RETENTION_DAYS`/`SAMURAI_LOG_RETENTION_KEEP` throws at boot
 * (retention policy nobody chose, same rule as `env-integer.ts`), while a
 * refused directory warns and sweeps nothing. The first is an operator typo
 * that must be seen before the run starts; the second is housekeeping
 * declining to act, and aborting a trading process over housekeeping is the
 * one outcome this module must never cause.
 */
import { type Dirent, fstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nonEmpty, positiveIntegerFromEnv } from '../../shared/env-integer.js';
import type { Logger } from './types.js';

/**
 * Sized against the sink's own module doc ("why did it do that on day 6"):
 * the sweep must not have already dropped the opening days of a completed
 * 14-day soak (#238) by the time anyone goes looking, so the window is wider
 * than the soak itself rather than equal to it.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

const ENV_LOG_RETENTION_DAYS = 'SAMURAI_LOG_RETENTION_DAYS';
const ENV_LOG_RETENTION_KEEP = 'SAMURAI_LOG_RETENTION_KEEP';

/** A `RotatingFileSink` generation: `orchestrator.log.1`. */
const ROTATED_GENERATION = /^.+\.log\.\d+$/;

/**
 * A finished, datestamped artefact: `orchestrator-20260902-1842.log`,
 * `supervisor-20260904-1020-v3.log`, `soak-boot-20260903-1007.out`. The
 * eight digits must be followed by `-` or `.` so a bare name that merely
 * contains a long number cannot pass as a datestamp.
 */
const DATESTAMPED_ARTEFACT = /^.*-\d{8}[-.].*\.(?:log|out)$/;

/**
 * Whether `name` is a finished log artefact and therefore eligible for
 * age-based deletion at all — see the module doc's "What is even a
 * candidate". Undated bare names (`orchestrator.log`, `service-api.log`,
 * `soak-boot.out`) are what a live writer holds open; non-log files
 * (`.env.local`) are not this sweep's business in any directory.
 */
export function isArchivedLogName(name: string): boolean {
  return ROTATED_GENERATION.test(name) || DATESTAMPED_ARTEFACT.test(name);
}

/**
 * Malformed values are refused at startup rather than defaulted, matching
 * `fileSinkConfigFromEnvironment` and `miArchiveRetentionDaysFromEnvironment`:
 * this is retention policy, and a window nobody chose is worse than a
 * refusal that names the variable.
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
 * Basenames the operator has taken out of the sweep, from a comma-separated
 * `SAMURAI_LOG_RETENTION_KEEP`. Unset means none.
 *
 * Malformed entries throw rather than being dropped, matching
 * `logRetentionDaysFromEnvironment` beside it: a keep-list quietly missing
 * the entry an operator wrote is the one thing this variable exists to
 * prevent.
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

/** Enough of `fs.Stats` to identify an open descriptor's target file. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface LogRetentionOptions {
  /** Directory swept. Never recursed into, and no entry outside it is ever touched. */
  directory: string;
  /** A file is stale once it has gone unmodified this long. */
  maxAgeMs: number;
  /**
   * Paths never removed regardless of age — the caller's own active sink
   * file and its rotation set. Resolved before comparison, so relative and
   * absolute forms of the same path match.
   */
  protectedPaths?: readonly string[];
  /** Basenames in `directory` the operator has taken out of the sweep. */
  keepNames?: readonly string[];
  now?: () => number;
  /**
   * Seam for tests: stands in for `process.cwd()`. Injected rather than read
   * directly so the refusal can be exercised — and mutated — without ever
   * pointing a real sweep at the repo root.
   */
  cwd?: () => string;
  /** Seam for tests: stands in for `fstatSync(1)` / `fstatSync(2)`. */
  activeDescriptors?: () => readonly FileIdentity[];
  /** Seam for tests: stands in for `rmSync`. */
  remove?: (path: string) => void;
}

export interface LogRetentionResult {
  filesRemoved: number;
  bytesReclaimed: number;
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
      // to compare candidate files against, not a reason to stop sweeping.
    }
  }
  return identities;
}

/**
 * Deletes archival-shaped files in `directory` whose mtime is older than
 * `maxAgeMs`. Never recurses, never follows a symlink, never touches a name
 * that isn't a finished log artefact, refuses a directory that is the
 * process's own cwd, and never throws — see the module doc for what makes a
 * candidate, the liveness rule, and why each of those is load-bearing rather
 * than decorative.
 *
 * Every per-file and per-listing failure is tolerated: a missing directory,
 * a permission error, a file that vanishes between `readdirSync` and
 * `statSync`, or a `remove` that throws all leave that one file (or the
 * whole sweep) skipped rather than propagating. A boot must not fail because
 * housekeeping did.
 */
export function sweepStaleLogs(options: LogRetentionOptions): LogRetentionResult {
  const {
    directory,
    maxAgeMs,
    protectedPaths = [],
    keepNames = [],
    now = Date.now,
    cwd = process.cwd,
    activeDescriptors = defaultActiveDescriptors,
    remove = (path: string) => rmSync(path),
  } = options;

  const result: LogRetentionResult = { filesRemoved: 0, bytesReclaimed: 0 };
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
  const liveIdentities = activeDescriptors();
  const cutoff = now() - maxAgeMs;

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result; // Missing or unreadable logs/ — nothing to sweep.
  }

  for (const entry of entries) {
    // `isFile()` reports the type of the DIRECTORY ENTRY, never a symlink's
    // target — so a symlink (even one pointing outside `directory`) is
    // neither a file nor a directory here and is skipped rather than
    // resolved and followed. This is what keeps the sweep inside `directory`
    // with no path ever leaving it, structurally rather than by convention.
    if (!entry.isFile()) continue;
    if (!isArchivedLogName(entry.name)) continue;
    if (keepSet.has(entry.name)) continue;

    const path = join(root, entry.name);
    if (protectedSet.has(resolve(path))) continue;

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue; // Vanished between listing and stat — not this sweep's problem.
    }

    if (liveIdentities.some((id) => id.dev === stat.dev && id.ino === stat.ino)) continue;
    if (stat.mtimeMs >= cutoff) continue;

    try {
      remove(path);
    } catch {
      continue; // Permission error, already gone, or a platform quirk — tolerated by design.
    }

    result.filesRemoved += 1;
    result.bytesReclaimed += stat.size;
  }

  return result;
}

/**
 * `sweepStaleLogs`, reported on `logger` and never throwing past this point —
 * same posture as `pruneMiArchiveWithLog`/`pruneLlmCallLogWithLog`
 * (`production.ts`): a throw here at boot would abort a trading process over
 * housekeeping. `sweepStaleLogs` itself already tolerates every failure it
 * can name; this wrapper's own try/catch covers anything unanticipated
 * (e.g. `now`/`activeDescriptors` throwing) so that guarantee holds even if
 * a future edit to this file's internals breaks it.
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
        level: 'warn',
        message: `logs/ retention sweep refused to sweep ${options.directory} — growth there is unbounded until SAMURAI_LOG_FILE names a dedicated log directory`,
        payload: { directory: options.directory, reason: result.refusedReason },
      });
      return result;
    }
    if (result.filesRemoved > 0) {
      logger.log({
        trace_id: 'startup',
        stage: 'orchestrator',
        level: 'info',
        message: `logs/ retention sweep removed ${result.filesRemoved} stale file(s)`,
        payload: { files_removed: result.filesRemoved, bytes_reclaimed: result.bytesReclaimed },
      });
    }
    return result;
  } catch (error) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'warn',
      message:
        'logs/ retention sweep failed — logging continues, but growth in logs/ is unbounded ' +
        'until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return { filesRemoved: 0, bytesReclaimed: 0 };
  }
}
