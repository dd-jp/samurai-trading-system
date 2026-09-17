/**
 * Durable, size-rotated file sink for the structured log.
 *
 * `audit_log` persists `input_digest`/`output_digest` only — it proves a
 * stage ran but reconstructs no value. Everything diagnostic (LLM warn
 * lines, latency-budget overruns, alert-transport failures, fill-sync
 * errors) exists *only* as a structured log line, and before this file that
 * line went to stdout and nowhere else — lost on any unattended run without
 * a shell redirect.
 *
 * Hand-rolled rather than `pino`+`pino-roll`: every stage already logs
 * through the shared `Logger` interface, so pino would arrive as a second
 * logging abstraction wrapped by the first, not as the logger. What's
 * actually needed is one `write(line)` byte sink.
 *
 * Failure modes a naive rotator gets wrong, handled here: partial
 * `writeSync`s (loop drains the buffer), byte counting by `Buffer.byteLength`
 * not `String.length` (log lines are not ASCII-guaranteed), rotation racing
 * a write (everything here is synchronous/single-threaded), a failed
 * rotation growing the file forever (it degrades the sink instead), and a
 * missing generation from a hand-deleted file (`renameSync` ENOENT is
 * skipped, not fatal). The file is created `0o600`, its directory `0o700`.
 *
 * Synchronous by design, not a tick-latency problem: measured at ~2.8µs per
 * write and ~5ms per rotation on the deployment target, both a small
 * fraction of the tick/debate budget. More importantly, an async or
 * worker-based sink loses buffered lines exactly when the process dies —
 * and the lines immediately before a crash are the ones this log exists to
 * answer for. Trading a few guaranteed microseconds for the risk of losing
 * the most valuable records is the wrong trade here.
 *
 * Any I/O failure — at construction or mid-run — flips the sink to
 * `degraded` permanently, reporting once through `onFailure`; it never
 * retries, since retrying means a per-tick syscall storm against a
 * filesystem that's already unhappy. It never throws, since a logging call
 * sits inside every tick and a full disk must not end the run.
 *
 * The retention window here is short on purpose: these files are the
 * *diagnostic* record, not the *trade* record — every signal, order and
 * fill is persisted in SQLite, which is what HMRC CGT record-keeping
 * actually rests on.
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
import { nonEmpty, positiveIntegerFromEnv } from '../../shared/index.js';

/**
 * Default path. Relative to the process CWD, sibling to `data/` where the
 * shared SQLite store lives — the same in-repo-adjacent posture, and `logs/`
 * is gitignored alongside it.
 */
export const DEFAULT_LOG_FILE = 'logs/orchestrator.log';

/** 16 MiB per generation */
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
  /** Seam for tests: stands in for the `writeSync` loop */
  writeLine?: (fd: number, bytes: Buffer) => void;
}

/**
 * The sink configuration for this run, from the environment.
 *
 * A sane default is deliberate here, unlike `SAMURAI_ALERTS`'s no-default
 * rule: a log file path has no dangerous value — the dangerous state is the
 * *absence* of a file, which is what defaulting fixes.
 *
 * Malformed values throw rather than falling back: a typo'd
 * `SAMURAI_LOG_MAX_BYTES` that silently became 16 MiB is a retention policy
 * nobody chose. Runtime I/O failures are the thing that degrades;
 * configuration errors fail fast.
 */
export function fileSinkConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): FileSinkConfig {
  // `nonEmpty` on the path, not just on the integers, and the trim is not
  // cosmetic: `Number(' ')` is `0`, and `0` is a *legal* value for
  // `SAMURAI_LOG_MAX_FILES` meaning "keep nothing" — a stray space would
  // silently switch retention from ten generations to none
  const purpose = "the durable log sink's rotation policy (#325)";
  return {
    filePath: nonEmpty(env[ENV_FILE]) ?? DEFAULT_LOG_FILE,
    maxBytes: positiveIntegerFromEnv(
      env[ENV_MAX_BYTES],
      ENV_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      1,
      purpose,
    ),
    maxRotatedFiles: positiveIntegerFromEnv(
      env[ENV_MAX_FILES],
      ENV_MAX_FILES,
      DEFAULT_MAX_ROTATED_FILES,
      0,
      purpose,
    ),
  };
}

/**
 * An append-only, size-rotated line sink. Synchronous by design: a structured
 * log line written the instant it is produced survives the crash it is
 * describing, which a buffered async sink does not. See the module doc for
 * the measured cost.
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

  /** True once an I/O failure has taken this sink out of service for good */
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
      // `maxBytes` rotates on every write and never lands anywhere
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
      // Nothing useful to do on a failed close of a log file at shutdown
    }
  }

  private open(): void {
    const directory = dirname(this.options.filePath);
    if (directory !== '.') mkdirSync(directory, { recursive: true, mode: 0o700 });
    // 'a' — append. Two processes pointed at one file interleave whole lines
    // rather than overwriting each other, since O_APPEND makes each write
    // seek-and-write atomically
    this.fd = openSync(this.options.filePath, 'a', 0o600);
    // From the descriptor, not the path: whatever this fd is attached to is
    // what the byte counter must describe
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
    // `maxRotatedFiles` copies of the same lines
    //
    // Nothing explicitly deletes the oldest generation: POSIX `rename(2)`
    // replaces an existing destination atomically, so the final shift IS
    // the eviction
    for (let generation = maxRotatedFiles - 1; generation >= 1; generation -= 1) {
      const from = `${filePath}.${generation}`;
      // renameSync throws ENOENT on a missing source; a hand-deleted
      // generation is a gap to skip, not a reason to lose the sink
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
   * Not theoretical: the shipped `onFailure` is `warnOnStdout`, and stdout
   * can be dead — routine for a long-running process someone attached to and
   * detached from, or one whose supervisor closed the pipe. Without this
   * catch, `attempt`'s handler for a *file* failure would itself throw,
   * straight out of `write()` and into a tick.
   *
   * There is nowhere left to escalate at that point: the file sink is gone
   * and the stream that reports on it is gone too. The only correct
   * behaviour is to keep trading. `failed` is already set, so nothing retries.
   */
  private report(message: string): void {
    try {
      this.options.onFailure?.(message);
    } catch {
      // Both sinks are broken. Losing THIS message is strictly better than
      // losing the run here — this class's one hard guarantee is that IT
      // never throws into a tick
    }
  }
}

/**
 * `writeSync` may write fewer bytes than asked; drain the buffer.
 *
 * **The zero-progress guard is the important line.** A `writeSync` that
 * returns 0 without throwing — a stuck descriptor, an exotic device — never
 * advances `offset`, and this loop would spin forever. `attempt` cannot
 * catch that because nothing is thrown, so the sink never degrades and the
 * tick never completes: a trading process hung mid-tick with open positions
 * is the worst outcome in this file. Converting it to a throw hands it to
 * `attempt`'s machinery instead: retire the sink, warn on stdout, keep
 * trading.
 *
 * `write` is injectable purely so that path is testable without a wedged
 * filesystem.
 */
export function writeAll(
  fd: number,
  bytes: Buffer,
  write: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = write(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error(
        `writeSync made no progress (returned ${written}) with ${bytes.length - offset} of ` +
          `${bytes.length} bytes left to write. Treating as a failed write rather than ` +
          'retrying, because retrying is an infinite loop inside a tick.',
      );
    }
    offset += written;
  }
}
