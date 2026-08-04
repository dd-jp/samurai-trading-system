/**
 * Durable, size-rotated file sink for the structured log (#325) — see
 * docs/specs/orchestrator-spec.md story 11 ("I want to own the log sink
 * (stdout + rotated file), so that log retention/rotation is configured once,
 * not per stage"), the half #95 deliberately deferred.
 *
 * ## Why this exists
 *
 * `audit_log` persists `input_digest`/`output_digest` only: it can prove a
 * stage ran and that its I/O hashed to X, and can reconstruct no value at all.
 * Everything diagnostic — LLM warn lines, latency-budget overruns,
 * `daily_pnl_pct` assumption warnings, alert-transport failures, fill-sync
 * errors — exists *only* as a structured log line. Before this file that line
 * went to stdout and nowhere else, so a `yarn orchestrator` run without a
 * shell redirect discarded it. "Why did it do that on day 6" is the single
 * question the 14-day soak (#238) exists to answer, and it was unanswerable.
 *
 * ## Hand-rolled, not a dependency
 *
 * ~150 lines against `pino` + `pino-roll`. ADR-0001's posture is minimal hard
 * dependencies, and the concrete reason the library does not earn its place
 * here is that it would not *replace* anything: every stage logs through the
 * shared `Logger` interface (shared/types.ts), so pino would arrive as a
 * second logging abstraction wrapped by the first, not as the logger. What is
 * actually needed is one `write(line)` byte sink. See
 * docs/research/techstack.md § Logging.
 *
 * ## The failure modes a hand-rolled rotator gets wrong, and what is done here
 *
 * - **Partial writes.** `writeSync` may write fewer bytes than asked. The
 *   write loop advances an offset until the buffer is drained.
 * - **Byte counting.** The size counter and the rotation threshold use
 *   `Buffer.byteLength`, never `String.length` — log lines carry LLM prose and
 *   are not ASCII-guaranteed, and a UTF-16-code-unit counter under-counts
 *   multi-byte text and lets the file grow past its cap.
 * - **Rotation racing an in-flight write.** Everything here is synchronous and
 *   single-threaded: a rotation cannot interleave with a `writeSync`.
 * - **Unbounded growth when rotation silently fails.** A failed rotation is a
 *   failure like any other — it degrades the sink and reports, rather than
 *   being swallowed and leaving the active file to grow forever.
 * - **Missing generations.** `renameSync` on an absent path throws ENOENT, so
 *   the shift loop skips generations that are not there (an operator deleting
 *   `.1` by hand mid-soak must not take the sink down).
 * - **Permissions.** The file is created `0o600` and its directory `0o700`.
 *   Log payloads are the most detailed record this process keeps; they are not
 *   for a shared host's other accounts. (Modes apply at creation only — an
 *   existing file's permissions are the operator's.)
 *
 * ## Why synchronous, and why that is not a tick-latency problem
 *
 * Raised in review on #349 and answered with measurements rather than a
 * rewrite, so it does not have to be re-litigated. On the deployment target
 * (Node 26, darwin/arm64, 461-byte lines — a real orchestrator log line):
 *
 * | case | cost |
 * | --- | --- |
 * | steady-state write, mean | **2.8 µs** (p50 2.2 µs, p99 6.8 µs; ~344k lines/sec) |
 * | rotation write at the shipped 16 MiB × 10 policy | 2.5 ms mean, 4.7 ms worst |
 * | 20 log lines in a tick | 0.056 ms |
 * | 1000 log lines in a tick | 2.8 ms |
 *
 * Against `DEFAULT_TICK_INTERVAL_MS` (60 s), `LATENCY_BUDGET_MS.crypto` (15 s)
 * and the Alpaca broker client's own 10 s request timeout, a realistic tick
 * spends **0.0004%** of the debate budget in this sink. The expensive case —
 * the close + 10-rename shift + reopen — costs ~5 ms and fires once per 16 MiB,
 * which at soak volumes is roughly once a day: about eleven times across the
 * whole 14-day run.
 *
 * It also does not introduce a synchronous write; it doubles one. `JsonLogger`
 * already called `process.stdout.write` per line, measured at 2.75 µs against
 * this sink's 2.63 µs — the same syscall to the same kind of destination.
 *
 * The affirmative argument matters more than the cost, though: **an async or
 * worker-based sink loses buffered lines exactly when the process dies.** This
 * log exists to answer "why did it do that on day 6" (#238), and the lines
 * immediately before a crash are the ones that answer it. Trading a guaranteed
 * few microseconds for the possibility of losing precisely the most valuable
 * records in the file is the wrong trade for this component. `fs/promises` or a
 * worker thread would buy latency this application has in enormous surplus, at
 * the cost of durability it has none to spare of.
 *
 * (Benchmark was one-off and deliberately not committed: a timing assertion is
 * exactly the kind of test that goes flaky in CI. Numbers are in #349.)
 *
 * ## Degradation
 *
 * Any I/O failure — at construction or mid-run — flips the sink to `degraded`,
 * reports **once** through `onFailure`, and from then on the sink is a no-op
 * that touches the filesystem never again. It does not throw, ever, because a
 * logging call sits inside every tick and a full disk must not end the run.
 *
 * Permanent rather than retry-on-next-write, deliberately: retrying means a
 * per-tick syscall storm against a filesystem that is already unhappy, and a
 * degrade report that either repeats forever or lies about the state. The cost
 * is that a *transient* failure loses file logging until restart, and the
 * report says exactly that rather than implying recovery.
 *
 * ## Retention and UK CGT
 *
 * The retention window here is short on purpose. These files are the
 * *diagnostic* record, not the *trade* record: every signal, order and fill is
 * persisted in SQLite (`audit_log`, `verdict_log`, execution/fill tables),
 * which is what CLAUDE.md's "log every signal, every fill" and HMRC CGT
 * record-keeping actually rest on. Nothing about the disposal history depends
 * on a file being rotated away here.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Default path. Relative to the process CWD, sibling to `data/` where the
 * shared SQLite store lives — the same in-repo-adjacent posture, and `logs/`
 * is gitignored alongside it.
 */
export const DEFAULT_LOG_FILE = 'logs/orchestrator.log';

/** 16 MiB per generation. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Rotated generations kept, *excluding* the active file — so the on-disk
 * ceiling is `maxBytes * (maxRotatedFiles + 1)`, 176 MiB at the defaults.
 * Bounded and short: see the retention note in the module doc.
 *
 * `0` is a legal value and means keep *nothing*: rotation discards the full
 * file instead of renaming it, leaving only the last `maxBytes` of history. It
 * does not mean "never rotate" — an operator who wants a bigger single file
 * wants `SAMURAI_LOG_MAX_BYTES`, and the README says so.
 */
export const DEFAULT_MAX_ROTATED_FILES = 10;

const ENV_FILE = 'SAMURAI_LOG_FILE';
const ENV_MAX_BYTES = 'SAMURAI_LOG_MAX_BYTES';
const ENV_MAX_FILES = 'SAMURAI_LOG_MAX_FILES';

export interface FileSinkConfig {
  filePath: string;
  maxBytes: number;
  /** Rotated generations kept. The active file is not counted. */
  maxRotatedFiles: number;
}

export interface RotatingFileSinkOptions extends FileSinkConfig {
  /**
   * Called at most once, with a human-readable reason, the first time this
   * sink fails. The caller is expected to surface it on the stream that is
   * still working — stdout — and must not route it back through this sink.
   */
  onFailure?: (message: string) => void;
  /** Seam for tests: stands in for the `writeSync` loop. */
  writeLine?: (fd: number, bytes: Buffer) => void;
}

/**
 * The sink configuration for this run, from the environment.
 *
 * A sane default is deliberate here, and is *not* in tension with #322's
 * "a dangerous degraded mode gets no silent default" precedent: `SAMURAI_ALERTS`
 * has no default because the degraded value (log-only) is the one that makes an
 * unattended run silently unsafe. A log file path has no dangerous value — the
 * dangerous state is the *absence* of a file, which is what defaulting fixes.
 * So the variables are optional and the default is on.
 *
 * Malformed values throw rather than falling back, matching `parseMode` and
 * `sharedStorePath`: a typo'd `SAMURAI_LOG_MAX_BYTES` that silently became
 * 16 MiB is a retention policy nobody chose. Runtime I/O failures are the
 * thing that degrades; configuration errors fail fast.
 */
export function fileSinkConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): FileSinkConfig {
  return {
    filePath: nonEmpty(env[ENV_FILE]) ?? DEFAULT_LOG_FILE,
    maxBytes: positiveInteger(env[ENV_MAX_BYTES], ENV_MAX_BYTES, DEFAULT_MAX_BYTES, 1),
    maxRotatedFiles: positiveInteger(env[ENV_MAX_FILES], ENV_MAX_FILES, DEFAULT_MAX_ROTATED_FILES),
  };
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function positiveInteger(raw: string | undefined, name: string, fallback: number, min = 0): number {
  const value = nonEmpty(raw);
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(
      `Orchestrator cannot start: ${name} must be an integer >= ${min}, not ` +
        `${JSON.stringify(value)}. It is the durable log sink's rotation policy (#325); a ` +
        'value nobody meant is a retention window nobody chose, so it is refused rather than ' +
        `defaulted. Unset it to accept the default (${fallback}).`,
    );
  }
  return parsed;
}

/**
 * An append-only, size-rotated line sink. Synchronous by design: a structured
 * log line written the instant it is produced survives the crash it is
 * describing, which a buffered async sink does not. See the module doc
 * ("Why synchronous, and why that is not a tick-latency problem") for the
 * measured cost — 2.8 µs a line, 0.0004% of the crypto debate budget for a
 * realistic tick.
 */
export class RotatingFileSink {
  private readonly options: RotatingFileSinkOptions;
  private fd: number | null = null;
  private bytes = 0;
  private failed = false;

  constructor(options: RotatingFileSinkOptions) {
    this.options = options;
    this.attempt('open the log file', () => {
      this.open();
    });
  }

  /** True once an I/O failure has taken this sink out of service for good. */
  get degraded(): boolean {
    return this.failed;
  }

  /**
   * Appends one already-formatted line (newline included). Never throws — see
   * the module doc; this is called from inside every tick.
   */
  write(line: string): void {
    if (this.failed) return;

    this.attempt('write to the log file', () => {
      const bytes = Buffer.from(line, 'utf8');
      // `this.bytes > 0` matters: without it a single line larger than
      // `maxBytes` rotates on every write and never lands anywhere.
      if (this.bytes > 0 && this.bytes + bytes.length > this.options.maxBytes) this.rotate();
      const fd = this.fd;
      if (fd === null) throw new Error('log file is not open');
      (this.options.writeLine ?? writeAll)(fd, bytes);
      this.bytes += bytes.length;
    });
  }

  /** Releases the descriptor. Never throws; idempotent. */
  close(): void {
    const fd = this.fd;
    this.fd = null;
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      // Nothing useful to do on a failed close of a log file at shutdown.
    }
  }

  private open(): void {
    const directory = dirname(this.options.filePath);
    if (directory !== '.') mkdirSync(directory, { recursive: true, mode: 0o700 });
    // 'a' — append. Two processes pointed at one file interleave whole lines
    // rather than overwriting each other, since O_APPEND makes each write
    // seek-and-write atomically.
    this.fd = openSync(this.options.filePath, 'a', 0o600);
    // From the descriptor, not the path: whatever this fd is attached to is
    // what the byte counter must describe.
    this.bytes = fstatSync(this.fd).size;
  }

  /**
   * `log` → `log.1` → `log.2` → … → dropped past `maxRotatedFiles`.
   *
   * The descriptor is closed first: on POSIX a rename would otherwise leave
   * this process writing into the renamed inode, so the "active" file would
   * stop growing and the newest lines would land in `.1`.
   */
  private rotate(): void {
    const { filePath, maxRotatedFiles } = this.options;
    this.close();

    // Shift every generation up one. Descending order is required — ascending
    // would overwrite each generation with the one below it, leaving
    // `maxRotatedFiles` copies of the same lines.
    //
    // Nothing explicitly deletes the oldest generation: POSIX `rename(2)`
    // replaces an existing destination atomically, so the final shift
    // (`.maxRotatedFiles-1` → `.maxRotatedFiles`) *is* the eviction. An
    // explicit `rmSync` here was verified redundant by mutation-testing the
    // retention cap — removing it left the bound intact — and redundant
    // filesystem calls in a rotation path are a place for bugs to hide.
    for (let generation = maxRotatedFiles - 1; generation >= 1; generation -= 1) {
      const from = `${filePath}.${generation}`;
      // renameSync throws ENOENT on a missing source; a hand-deleted
      // generation is a gap to skip, not a reason to lose the sink.
      if (existsSync(from)) renameSync(from, `${filePath}.${generation + 1}`);
    }

    if (maxRotatedFiles === 0) rmSync(filePath, { force: true });
    else renameSync(filePath, `${filePath}.1`);

    this.open();
  }

  /**
   * Runs `action`, and on any failure retires the sink permanently, reporting
   * once. `failed` is set *before* `onFailure` runs so that a callback which
   * (wrongly) logs through this sink cannot recurse back into a failing write.
   */
  private attempt(what: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.failed = true;
      this.close();
      this.report(
        `structured log file sink disabled: could not ${what} ` +
          `(${this.options.filePath}) — ${error instanceof Error ? error.message : String(error)}. ` +
          'Logging continues on stdout only, and will not resume to file until the process is ' +
          'restarted. An unattended soak (#238) started this way keeps no durable diagnostic ' +
          'trace: fix the path or its permissions and restart.',
      );
    }
  }

  /**
   * Reports the degradation, and swallows a failure to report it.
   *
   * Raised in review on #349, and not theoretical: the shipped `onFailure` is
   * `warnOnStdout` (logger.ts), and `process.stdout.write` throws EPIPE the
   * moment the far end of the pipe goes away — routine for a long-running
   * process someone attached to and detached from, or one whose supervisor
   * closed the pipe. Without this catch, `attempt`'s handler for a *file*
   * failure would itself throw, straight out of `write()` and into a tick.
   *
   * There is nowhere left to escalate at that point: the file sink is gone and
   * the stream that reports on it is gone too. The only correct behaviour is
   * to keep trading. `failed` is already set, so nothing retries.
   */
  private report(message: string): void {
    try {
      this.options.onFailure?.(message);
    } catch {
      // Both sinks are broken. Losing the message is strictly better than
      // losing the run — this class's one hard guarantee is that a logging
      // call inside a tick never throws.
    }
  }
}

/** `writeSync` may write fewer bytes than asked; drain the buffer. */
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}
