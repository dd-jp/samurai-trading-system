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
 *   file this process has no other way to identify. That is a real gap, not
 *   a theoretical one, and sizing the window generously (see
 *   `DEFAULT_LOG_RETENTION_DAYS`) is what keeps it from mattering in
 *   practice.
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
 * generation is orphaned like this, not a gap.
 */
import { type Dirent, fstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { positiveIntegerFromEnv } from '../../shared/env-integer.js';
import type { Logger } from './types.js';

/**
 * Sized against the sink's own module doc ("why did it do that on day 6"):
 * the sweep must not have already dropped the opening days of a completed
 * 14-day soak (#238) by the time anyone goes looking, so the window is wider
 * than the soak itself rather than equal to it.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

const ENV_LOG_RETENTION_DAYS = 'SAMURAI_LOG_RETENTION_DAYS';

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
  now?: () => number;
  /** Seam for tests: stands in for `fstatSync(1)` / `fstatSync(2)`. */
  activeDescriptors?: () => readonly FileIdentity[];
  /** Seam for tests: stands in for `rmSync`. */
  remove?: (path: string) => void;
}

export interface LogRetentionResult {
  filesRemoved: number;
  bytesReclaimed: number;
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
 * Deletes files in `directory` whose mtime is older than `maxAgeMs`. Never
 * recurses, never follows a symlink, and never throws — see the module doc
 * for the liveness rule and why each of those is load-bearing rather than
 * decorative.
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
    now = Date.now,
    activeDescriptors = defaultActiveDescriptors,
    remove = (path: string) => rmSync(path),
  } = options;

  const result: LogRetentionResult = { filesRemoved: 0, bytesReclaimed: 0 };
  const root = resolve(directory);
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
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
