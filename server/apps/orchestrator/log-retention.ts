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
 *   cwd comparison can catch. That path-independent guarantee covers only
 *   the unlink path below: "Bare live names" (#1206) adds a SECOND
 *   destructive action, and `isBareLogName` alone is not narrow enough to
 *   scope it — any undated `.log`/`.out` file at whatever directory the
 *   sweep is aimed at would match it, Samurai's or not. That path carries
 *   its own, separate narrowing instead: an explicit basename allowlist,
 *   see "Bare live names" below.
 * - **The name must be archival-shaped**: either a `RotatingFileSink`
 *   generation (`orchestrator.log.1`) or a datestamped artefact
 *   (`orchestrator-20260902-1842.log`, `supervisor-20260904-1020-v3.log`,
 *   `soak-boot-20260903-1007.out`, or — widened by #1206 — a bare date with
 *   no time component, `soak-20260825.log`). The rule is one-directional and
 *   only one-directional: an undated bare name is never UNLINKED on age,
 *   which is what closes the descriptor gap below structurally rather than
 *   probabilistically, and makes `.env.local`, `LICENSE` and every other
 *   non-log file ineligible for unlinking as a side effect. The converse does
 *   NOT hold — an archival-shaped name is not evidence the file is finished
 *   (`supervisor-20260904-1020-v3.log` is datestamped and was live at
 *   #1116's audit), and a finished file is not always archival-shaped
 *   (`soak-boot.out` is bare — never unlinked, but see "Bare live names"
 *   below for the disk-allocation-based path #1206 gives it instead).
 *
 * ## Liveness rule
 *
 * A wrong sweep deletes evidence of a run that is still producing it, so
 * "old" is deliberately not the only test — for the UNLINK path below. Two
 * independent signals decide whether a candidate file is currently being
 * written, because no single one covers every process that writes into
 * `logs/`. ("Bare live names" (#1206) below is the exception: it avoids the
 * INVISIBLE-GROWTH failure mode this section exists to prevent, by never
 * unlinking, but it still carries the EVIDENCE-LOSS half of the same
 * sentence — truncation has no age or descriptor gate of its own, on
 * purpose; see that section for why. Its blast radius is instead bounded by
 * NAME, not by liveness.)
 *
 * - **Descriptor identity.** This process's own stdout/stderr (fd 1 and 2)
 *   may BE one of these files: directly, under a shell redirect
 *   (`npm run orchestrator > logs/orchestrator-DATE.log`), or indirectly, under
 *   the supervisor's `stdio: 'inherit'` — a spawned child inherits its
 *   parent's descriptors verbatim, so the orchestrator's fd 1/2 are the exact
 *   same open file as the supervisor's own redirect target
 *   (`supervisor-*.log`) when launched via `npm run serve`. `fstatSync` on those
 *   two descriptors and comparing `{dev, ino}` against each candidate file
 *   catches both cases without knowing either filename in advance. A
 *   descriptor that is a TTY, a pipe, or closed (`EBADF`) simply contributes
 *   nothing to compare against, so the check is inert rather than wrong when
 *   stdout isn't redirected to a regular file.
 * - **Recency.** Anything this process cannot identify by descriptor — most
 *   concretely, a sibling process's own redirect target when it is not the
 *   parent or child of this one (`service-api.log` from a dashboard started
 *   standalone, outside `npm run serve`) — is judged by mtime instead: a process
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
 *   unbounded growth would become invisible unbounded growth. For a BARE
 *   name the archival-name rule above removes that reachability entirely from
 *   THIS (unlink) path — `service-api.log` can never be a candidate for
 *   `remove`, whatever its mtime; "Bare live names" below is the separate,
 *   unlink-hazard-free path that reaches it instead. For a datestamped name
 *   the archival-name rule does not: the name rule contributes nothing, so a
 *   live datestamped file rests on the descriptor check, which covers the
 *   supervisor-spawned path (inherited fd 1/2) and nothing else. A sibling
 *   process writing one slowly enough to age past the window is the residual
 *   case, and `SAMURAI_LOG_RETENTION_KEEP` is the only thing that closes it.
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
 * ## Bare live names: truncated, not deleted (#1206)
 *
 * #1116's own audit named two things unbounded: the supervisor's own stdout
 * (`supervisor-*.log`, datestamped, reached by the unlink path above) and
 * `soak-boot.out` — a bare name, permanently ineligible for unlink by the
 * name rule above. That rule is correct (it is what makes the descriptor gap
 * closeable at all), but it left `soak-boot.out` itself unbounded, which is
 * the gap this section closes.
 *
 * `bareTruncateBytes` gives every eligible bare name (`.log`/`.out`, undated,
 * not archival-shaped, see below for "eligible") a disk-allocation-based path
 * instead: past the threshold, `truncateSync(path, 0)` rather than
 * `remove(path)`. This is safe on a file a writer still holds open in a way
 * unlink is not — `truncate` changes only the file's length, never the
 * writer's file descriptor or its position in it, so the descriptor a live
 * writer holds keeps working and its next write is reachable again by path,
 * never stranded on a now-unlinked inode. That is also why this path carries
 * none of the age or `activeDescriptors` liveness checks above that guard the
 * INVISIBLE-GROWTH hazard: allocation alone decides eligibility, live or
 * not. It does NOT avoid the EVIDENCE-LOSS half of "a wrong sweep deletes
 * evidence of a run that is still producing it" (see the liveness rule's
 * opening above) — there is no age or descriptor gate here at all, by
 * design; `SAMURAI_LOG_RETENTION_KEEP` is how an operator exempts a
 * specific bare file from it.
 *
 * Unlike the unlink path, `isBareLogName` alone is not what narrows this
 * one's blast radius: it accepts any undated `.log`/`.out` file at whatever
 * directory the sweep is aimed at, Samurai's or not — the unlink path's
 * blast radius stays narrow because an archival SHAPE
 * (`orchestrator-20260902-1842.log`) is unlikely to collide with an
 * unrelated tool's own files, but a bare `.log`/`.out` name collides
 * routinely (`install.log`, `wifi.log`, `system.log`). Pointed at a shared
 * directory — the module doc above blesses `/var/log/samurai` as "a
 * legitimate place to point a log directory" — an unscoped truncate path
 * would reach any co-located bare file the process can write to once it
 * crosses the threshold, root-owned ones aside (`truncateSync` throws
 * `EPERM`, tolerated by the per-file catch below like any other failure, but
 * a directory the running user owns offers no such protection).
 *
 * `bareTruncateNames` (`SAMURAI_LOG_BARE_TRUNCATE_NAMES`) is what actually
 * narrows it, by NAME rather than by requiring an operator to opt in: only a
 * basename in this set is ever a truncation candidate, whatever its size.
 * `logBareTruncateNamesFromEnvironment` defaults it to exactly
 * `DEFAULT_BARE_TRUNCATE_NAMES` — `soak-boot.out`, the one file #1206 itself
 * names — so `install.log`/`wifi.log`/`system.log` are unreachable by
 * construction, not by an operator remembering not to opt in. An operator
 * extends the set with `SAMURAI_LOG_BARE_TRUNCATE_NAMES` (a comma-separated
 * list of additional basenames, same validation as `SAMURAI_LOG_RETENTION_KEEP`
 * beside it) if a second bare name in their own deployment needs the same
 * treatment; there is deliberately no way to shrink it below the default via
 * this variable — `SAMURAI_LOG_RETENTION_KEEP` is the existing, already-
 * general mechanism for exempting a specific file from every path in this
 * sweep, truncation included, so a second way to remove `soak-boot.out`
 * itself from eligibility would be redundant.
 *
 * `SAMURAI_LOG_BARE_TRUNCATE_BYTES` therefore carries the same default
 * posture as every other setting in this module — see
 * `logBareTruncateBytesFromEnvironment` — because the name allowlist, not an
 * opt-in threshold, is what now does the scoping. An earlier version of this
 * fix (#1281 review, round 1) made the threshold itself opt-in instead: sound
 * against the blast-radius hazard, but it meant `soak-boot.out` stayed
 * exactly as unbounded as before #1206 in any deployment that never sets the
 * variable — which, grepped across this repo, is every deployment: none of
 * the sibling `SAMURAI_LOG_*` variables are set anywhere in it either, they
 * simply have code-level defaults this one had stopped having. Naming the
 * one file this ticket is about, rather than gating the mechanism behind an
 * operator action nothing in this repo takes, is what makes `soak-boot.out`
 * actually bounded on the next boot rather than bounded only if someone
 * remembers to configure it (#1281 review, round 2).
 *
 * `protectedPaths` and `keepNames` both still apply — a bare name is exactly
 * what `SAMURAI_LOG_FILE` itself usually is (`orchestrator.log`), so without
 * that exclusion this path would fight `RotatingFileSink`'s own size-based
 * rotation over the file it owns.
 *
 * Truncation is boot-time, like the rest of this sweep — it runs once, when
 * the orchestrator starts, not on a timer while it keeps running. A
 * `soak-boot.out` growing at a couple of MB/day only gets truncated on a
 * boot that happens to land after it has crossed the threshold; an
 * unattended run with no restart across the whole window it is measured over
 * is not capped mid-run. #1206 is that the sweep can reach the file at all
 * (before this it never could, at any boot); it is not a continuous cap.
 *
 * Eligibility and `bytesReclaimed` are measured in DISK ALLOCATION
 * (`stat.blocks * 512`), never `stat.size` — deliberately, and gating on
 * size instead was tried and rejected during review (#1281). The premise:
 * `soak-boot.out` is, as best this repo can establish, produced by a plain
 * shell redirect — `> logs/soak-boot.out 2>&1` — whose fd has no
 * `O_APPEND` and so keeps its own, unmoved write offset (this is an
 * ASSUMPTION about a command this repo has never itself written — no launch
 * script, no supervisor code, no commit — inferred from the ticket's own
 * example; if an operator instead runs it under `>>`, `O_APPEND` moves the
 * offset to the CURRENT end of file before every write, which truncate has
 * just set to zero, so none of what follows in this paragraph applies —
 * there is no hole, and `stat.size` reads the same as `stat.blocks * 512`).
 * Under the `>` premise, `truncateSync` changes the file's length at that
 * instant, but that writer's next write still lands at its stale offset —
 * past the new, zero end of file — leaving a sparse hole in between.
 * `stat.size` climbs back toward its pre-truncation figure on that very
 * next write even though the hole's blocks stay unallocated on disk —
 * `stat.blocks` returns to a few KiB and STAYS there across repeated
 * truncate/write cycles. Verified two different ways on this repo's two
 * target filesystems: an interactive probe directly on macOS APFS (the
 * deployment target), and, on Linux ext4 (CI's `ubuntu-latest`, the `checks`
 * job in `.github/workflows/ci.yml`), the regression test named below —
 * which asserts the exact same numeric behaviour, not a proxy for it —
 * passing there as part of every `npm run test` run this PR's CI performs. Gating on
 * `stat.size` instead would see that recovered apparent length, truncate
 * again on the very next boot, and destroy whatever the writer had appended
 * since the previous one — every boot after the first, for as long as the
 * writer stays open (this was caught in review, not designed in from the
 * start; `log-retention.test.ts`'s hole test pins the exact mechanism).
 * `stat.blocks` does not have that failure mode, so both eligibility and
 * `bytesReclaimed` are computed from it for a TRUNCATED file; a REMOVED
 * (unlinked) file still contributes its `stat.size`, because there the
 * whole file is gone and apparent length and disk freed agree.
 *
 * A truncated-then-appended file is no longer `grep`-able the ordinary way:
 * the sparse hole reads back as `\0` bytes, so `file` reports it as `data`
 * and a plain `grep pattern file` prints "binary file … matches" instead of
 * the matching lines. `grep -a`, and `tail -c`, still work.
 *
 * `SAMURAI_LOG_BARE_TRUNCATE_BYTES` is validated, and defaults, the same way
 * as every other setting here — see `logBareTruncateBytesFromEnvironment`:
 * unset means `DEFAULT_BARE_TRUNCATE_BYTES` (16 MiB, the same figure
 * `rotating-file-sink.ts` already treats as "big enough to rotate" for the
 * one file it manages), a malformed value throws.
 *
 * Two failure postures, deliberately different: a malformed
 * `SAMURAI_LOG_RETENTION_DAYS`/`SAMURAI_LOG_RETENTION_KEEP`/
 * `SAMURAI_LOG_BARE_TRUNCATE_BYTES` throws at boot (retention policy nobody
 * chose, same rule as `env-integer.ts`), while a
 * refused directory warns and sweeps nothing. The first is an operator typo
 * that must be seen before the run starts; the second is housekeeping
 * declining to act, and aborting a trading process over housekeeping is the
 * one outcome this module must never cause.
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
 * Sized against the sink's own module doc ("why did it do that on day 6"):
 * the sweep must not have already dropped the opening days of a completed
 * 14-day soak (#238) by the time anyone goes looking, so the window is wider
 * than the soak itself rather than equal to it
 */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/**
 * Matches `DEFAULT_MAX_BYTES` in `rotating-file-sink.ts`: the size already
 * treated as "big enough to rotate" for the one file this module's sibling
 * manages is a defensible size for "big enough to reclaim" on the bare names
 * nothing manages at all (#1206)
 */
export const DEFAULT_BARE_TRUNCATE_BYTES = 16 * 1024 * 1024;

/**
 * The truncate path's blast-radius narrowing (#1206 review, round 2): only a
 * basename in this set is ever eligible for truncation, whatever its size or
 * age. `soak-boot.out` is the one file the ticket itself names; an operator
 * extends the set via `SAMURAI_LOG_BARE_TRUNCATE_NAMES`, they cannot shrink
 * it (see `logBareTruncateNamesFromEnvironment` and the module doc's "Bare
 * live names" section for why that asymmetry is deliberate).
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
 * A finished, datestamped artefact: `orchestrator-20260902-1842.log`,
 * `supervisor-20260904-1020-v3.log`, `soak-boot-20260903-1007.out`, or a bare
 * date with no time component (`soak-20260825.log`, #1206 — widened from a
 * form that required a `-`/`.` and at least one more character after the
 * eight digits, which made a plain `name-YYYYMMDD.log` ineligible). The eight
 * digits must be followed by `-`, `.`, or the extension's own dot — never by
 * another digit — so a bare name that merely contains a long number
 * (`orchestrator-202608251842.log`) cannot pass as a datestamp.
 */
const DATESTAMPED_ARTEFACT = /^.*-\d{8}(?:[-.].*)?\.(?:log|out)$/;

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

/** A `.log`/`.out` name, whatever else it is — the only extensions this module ever touches */
const LOG_SHAPED_NAME = /\.(?:log|out)$/;

/**
 * Whether `name` is the SHAPE #1206 closes: an undated bare log file
 * (`soak-boot.out`, `orchestrator.log`) that `isArchivedLogName` refuses to
 * unlink on age because a live writer may still hold it open. Truncation
 * (see `sweepStaleLogs`'s `bareTruncateBytes`) does not carry that hazard, so
 * this name shape gets a disk-allocation-based path instead of no path at
 * all — but only for `.log`/`.out`: a non-log file (`.env.local`) must never
 * be eligible for either mechanism. This is necessary but not sufficient for
 * truncation eligibility: `bareTruncateNames` narrows further, by exact
 * basename, since this shape check alone would match `install.log` as
 * readily as `soak-boot.out`.
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
 * Same refuse-rather-than-default posture as `logRetentionDaysFromEnvironment`
 * beside it, for the threshold that decides when a bare log-shaped name
 * (#1206) gets truncated. This has a default like every other setting here —
 * unlike the earlier revision of this fix (#1281 review, round 1), which made
 * it opt-in instead of defaulted — because `bareTruncateNames`
 * (`logBareTruncateNamesFromEnvironment`) is what scopes the blast radius now;
 * see the module doc's "Bare live names" section for the full reasoning.
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
 * adds — never fewer than the default, only ever more. Extends rather than
 * replaces because `SAMURAI_LOG_RETENTION_KEEP` already exempts any specific
 * file (`soak-boot.out` included) from every path in this sweep; this
 * variable exists to ADD a second bare name to the truncate path's allowlist
 * for a deployment with one of its own, not to remove the one #1206 names.
 *
 * Validation mirrors `logRetentionKeepNamesFromEnvironment` beside it —
 * basenames only, no empty entries — same reasoning: a comma-separated list
 * silently dropping the entry an operator wrote is the one failure this
 * variable exists to prevent.
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

/** Enough of `fs.Stats` to identify an open descriptor's target file */
export interface FileIdentity {
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
   * Disk bytes (`stat.blocks * 512`, NOT `stat.size` — see the module doc)
   * past which a bare log-shaped name in `bareTruncateNames` is truncated to
   * empty rather than left alone (#1206). Undefined disables this path
   * entirely — no bare name is ever touched, matching the behaviour before
   * #1206. Age, `activeDescriptors` and this option are independent of each
   * other: truncation has none of unlink's liveness hazard (the writer keeps
   * its descriptor; see the module doc), so an allowlisted bare name is
   * eligible by allocation alone, at any age, live or not.
   */
  bareTruncateBytes?: number;
  /**
   * The truncate path's own name-based narrowing (#1206 review, round 2):
   * only a basename in this set is ever a candidate for it, whatever its
   * size — `isBareLogName` alone matches any undated `.log`/`.out` file,
   * Samurai's or not, so this is what keeps the blast radius to files this
   * process actually knows about. Undefined or empty means NO bare name is
   * eligible, the same conservative default every option here takes at this
   * pure-function level; `logBareTruncateNamesFromEnvironment` is what
   * supplies `DEFAULT_BARE_TRUNCATE_NAMES` (`soak-boot.out`) at the
   * composition root. See the module doc's "Bare live names" section.
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
   * A REMOVED file contributes its `stat.size` (the whole thing is gone, so
   * apparent length and disk freed agree). A TRUNCATED bare name contributes
   * its `stat.blocks * 512` — disk actually freed at that instant, not
   * `stat.size` — because a live, non-`O_APPEND` writer's apparent size
   * recovers through a sparse hole on its very next write while the disk
   * stays freed (see "Bare live names" in the module doc); reporting
   * `stat.size` there would overstate what stays reclaimed, sometimes by
   * orders of magnitude. Either way this is a snapshot at the moment of the
   * operation, not a durable total.
   */
  bytesReclaimed: number;
  /** Bare log-shaped names truncated rather than removed (#1206) */
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
 * The truncate path's own name-based narrowing (#1206 review, round 2) — see
 * `LogRetentionOptions.bareTruncateNames`'s doc for why `isBareLogName` shape
 * alone is not narrow enough on its own
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
  // Gated on DISK ALLOCATION (`stat.blocks`), not apparent length
  // (`stat.size`): a live, non-`O_APPEND` writer leaves a sparse hole
  // behind a previous truncate (see the module doc), so `stat.size` climbs
  // back toward its pre-truncation figure on its very next write while the
  // disk usage that motivated the truncation stays freed. Gating on size
  // would see that recovered apparent length, truncate again, and destroy
  // whatever the writer had appended since the last boot — every boot
  // after the first, for as long as the writer stays open. `stat.blocks`
  // is fixed at 512-byte units by POSIX regardless of `stat.blksize`, and
  // is what actually goes back to (near) zero after a truncate, cycle over
  // cycle — verified interactively on macOS APFS (deployment), and by the
  // "does not re-truncate" regression test below passing on Linux ext4 in
  // this PR's own CI (`ubuntu-latest`, `.github/workflows/ci.yml`)
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
  // `isFile()` reports the type of the DIRECTORY ENTRY, never a symlink's
  // target — so a symlink (even one pointing outside `directory`) is
  // neither a file nor a directory here and is skipped rather than
  // resolved and followed. This is what keeps the sweep inside `directory`
  // with no path ever leaving it, structurally rather than by convention
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

  // Bare log-shaped name (#1206): no age or liveness gate — unlike the
  // branch above, `truncate` never orphans a writer's descriptor, so disk
  // allocation alone decides eligibility among ELIGIBLE names (below)
  // `bareTruncateBytes === undefined` disables this path outright, matching
  // every version of this sweep before #1206. `truncateNameSet` is the
  // separate narrowing that keeps `isBareLogName`'s blast radius to files
  // this process actually knows about (#1281 review, round 2) — `.log`/
  // `.out` shape alone would match `install.log` as readily as
  // `soak-boot.out`
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
    return result; // Missing or unreadable logs/ — nothing to sweep
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
