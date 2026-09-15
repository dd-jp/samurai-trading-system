/**
 * The saved Saxo OAuth session: where it lives, how it is written, how it is
 * read back (#1522 wrote it, #1523 rotates it).
 *
 * The write is **atomic and fsync'd** — a temp file beside the target, then `rename` —
 * because the refresher persists a rotated refresh token before using the
 * access token that came with it. Saxo invalidates the previous refresh token
 * the moment a new one is ISSUED, so a half-written file is a lost session:
 * the old token no longer works and the new one was never saved. Renaming
 * within the same directory is what makes the replacement all-or-nothing;
 * `os.tmpdir()` would be a different filesystem and `rename` would fail
 * `EXDEV`.
 *
 * Permissions match `saxo-login.ts`'s posture: directory `0o700`, file
 * `0o600`, set on the temp file BEFORE the rename so the secret is never
 * visible at the final path with a umask-widened mode.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import type { SaxoTokenResponse } from './saxo-oauth.js';

export class SaxoTokenFileError extends Error {}

/**
 * `server/pipeline/execution/adapters/` → repo root, four levels up — with the
 * compiled tree's extra `dist/` segment stripped.
 *
 * Anchored at the module rather than at `process.cwd()` for #1522's reason
 * (the gitignore pattern `data/saxo-tokens/` is root-anchored, so a
 * cwd-relative path stops matching the moment the command runs from a
 * subdirectory). The `dist` strip is what keeps ONE path across the two ways
 * this code runs: `yarn saxo:login` writes it from source under `tsx`, while
 * the orchestrator reads and rewrites it from `dist/server/...`. Without the
 * strip the running system would refresh a second token file under `dist/`
 * that no login ever wrote.
 */
function repoRoot(): string {
  const fromModule = fileURLToPath(new URL('../../../../', import.meta.url));
  const trimmed = fromModule.replace(/\/+$/, '');
  return trimmed.endsWith('/dist') ? dirname(trimmed) : trimmed;
}

export function tokenFilePath(environment: SaxoTradingEnvironment): string {
  return resolve(repoRoot(), 'data', 'saxo-tokens', `${environment}.json`);
}

/**
 * Whether a login has ever saved a session for this environment. Deliberately
 * an existence check and not a read: the composition root uses it to CHOOSE a
 * token source, and a file that exists but cannot be parsed must reach the
 * refresher (which reports the session lost) rather than silently fall back to
 * a static bearer that nothing can renew.
 */
export function savedSessionExists(path: string): boolean {
  return existsSync(path);
}

export interface SaxoTokenFileRecord extends SaxoTokenResponse {
  environment: SaxoTradingEnvironment;
  obtainedAt: string;
  /**
   * When `yarn saxo:login` last ran for this environment (#1524) — set by
   * `runLogin` and then carried forward UNCHANGED through every rotation
   * (`SaxoTokenRefresher.runRefresh` copies it onto the next record rather
   * than restamping it), unlike `obtainedAt`, which a silent rotation does
   * update. The weekly re-login reminder reads this field precisely because
   * `obtainedAt` would answer "when did this process last renew its bearer",
   * not "when did an operator last actually log in" — the question Saxo's own
   * disclaimer-refresh guidance is about. Absent on a session saved before
   * this field existed, or one still on the pasted-token path (#1522
   * predates it).
   */
  loggedInAt?: string;
}

/**
 * Replaces the saved session atomically. The temp file is created beside the
 * target (not in `os.tmpdir()`, which risks `EXDEV` on `rename`) at 0600 from
 * `O_CREAT` — never world-readable for an instant.
 *
 * Durable against power loss, not only against a crashed process: the file's
 * bytes are `fsync`ed before the `rename`, and the DIRECTORY is `fsync`ed
 * after it, or the rename itself could still be in the page cache when the
 * host loses power. That matters here in a way it would not for a cache —
 * Saxo invalidated the previous refresh token when it issued this one, so a
 * lost write is a lost session, and the deployment target is a MacBook whose
 * named risks include power and lid-close (CLAUDE.md, Deployment Target).
 */
export function writeTokenFile(path: string, record: SaxoTokenFileRecord): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; its absence is the state we want.
    }
    throw cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireIso(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SaxoTokenFileError(`Saxo token file: ${field} is missing or not an ISO instant.`);
  }
  return value;
}

function requireSecret(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SaxoTokenFileError(`Saxo token file: ${field} is missing or empty.`);
  }
  return value;
}

/** Like `requireIso`, but the field is allowed to be absent — see `loggedInAt`'s doc. */
function optionalIso(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SaxoTokenFileError(`Saxo token file: ${field} is present but not an ISO instant.`);
  }
  return value;
}

/**
 * `undefined` when there is no saved session at all; throws when there is one
 * this process cannot use. No error message here ever quotes the file's
 * contents — every field it validates is either a secret or sits beside one.
 */
export function readTokenFile(path: string): SaxoTokenFileRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause.code === 'ENOENT') return undefined;
    throw new SaxoTokenFileError(
      `Saxo token file at ${path} could not be read (${
        isRecord(cause) && typeof cause.code === 'string' ? cause.code : 'unknown error'
      }).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaxoTokenFileError(`Saxo token file at ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new SaxoTokenFileError(`Saxo token file at ${path} is not an object.`);
  }
  const environment = parsed.environment;
  if (environment !== 'sim' && environment !== 'live') {
    throw new SaxoTokenFileError(`Saxo token file at ${path} names no known environment.`);
  }
  const loggedInAt = optionalIso(parsed, 'loggedInAt');
  return {
    environment,
    accessToken: requireSecret(parsed, 'accessToken'),
    refreshToken: requireSecret(parsed, 'refreshToken'),
    accessTokenExpiresAt: requireIso(parsed, 'accessTokenExpiresAt'),
    refreshTokenExpiresAt: requireIso(parsed, 'refreshTokenExpiresAt'),
    obtainedAt: requireIso(parsed, 'obtainedAt'),
    ...(loggedInAt === undefined ? {} : { loggedInAt }),
  };
}
