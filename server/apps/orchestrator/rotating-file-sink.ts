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

export const DEFAULT_LOG_FILE = 'logs/orchestrator.log';

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export const DEFAULT_MAX_ROTATED_FILES = 10;

const ENV_FILE = 'SAMURAI_LOG_FILE';
const ENV_MAX_BYTES = 'SAMURAI_LOG_MAX_BYTES';
const ENV_MAX_FILES = 'SAMURAI_LOG_MAX_FILES';

export interface FileSinkConfig {
  filePath: string;
  maxBytes: number;
  maxRotatedFiles: number;
}

export interface RotatingFileSinkOptions extends FileSinkConfig {
  onFailure?: (message: string) => void;
  writeLine?: (fd: number, bytes: Buffer) => void;
}

export function fileSinkConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): FileSinkConfig {
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

  get degraded(): boolean {
    return this.failed;
  }

  write(line: string): void {
    if (this.failed) return;

    this.attempt('write to the log file', () => {
      const bytes = Buffer.from(line, 'utf8');
      if (this.bytes > 0 && this.bytes + bytes.length > this.options.maxBytes) this.rotate();
      const fd = this.fd;
      if (fd === null) throw new Error('log file is not open');
      (this.options.writeLine ?? writeAll)(fd, bytes);
      this.bytes += bytes.length;
    });
  }

  close(): void {
    const fd = this.fd;
    this.fd = null;
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
    }
  }

  private open(): void {
    const directory = dirname(this.options.filePath);
    if (directory !== '.') mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.fd = openSync(this.options.filePath, 'a', 0o600);
    this.bytes = fstatSync(this.fd).size;
  }

  private rotate(): void {
    const { filePath, maxRotatedFiles } = this.options;
    this.close();

    for (let generation = maxRotatedFiles - 1; generation >= 1; generation -= 1) {
      const from = `${filePath}.${generation}`;
      if (existsSync(from)) renameSync(from, `${filePath}.${generation + 1}`);
    }

    if (maxRotatedFiles === 0) rmSync(filePath, { force: true });
    else renameSync(filePath, `${filePath}.1`);

    this.open();
  }

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

  private report(message: string): void {
    try {
      this.options.onFailure?.(message);
    } catch {
    }
  }
}

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
