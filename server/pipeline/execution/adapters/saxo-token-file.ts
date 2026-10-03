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

class SaxoTokenFileError extends Error {}

function repoRoot(): string {
  const fromModule = fileURLToPath(new URL('../../../../', import.meta.url));
  const trimmed = fromModule.replace(/\/+$/, '');
  return trimmed.endsWith('/dist') ? dirname(trimmed) : trimmed;
}

export function tokenFilePath(environment: SaxoTradingEnvironment): string {
  return resolve(repoRoot(), 'data', 'saxo-tokens', `${environment}.json`);
}

export function savedSessionExists(path: string): boolean {
  return existsSync(path);
}

export interface SaxoTokenFileRecord extends SaxoTokenResponse {
  environment: SaxoTradingEnvironment;
  obtainedAt: string;
  loggedInAt?: string;
}

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
    } catch {}
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

function optionalIso(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SaxoTokenFileError(`Saxo token file: ${field} is present but not an ISO instant.`);
  }
  return value;
}

function errorCode(cause: unknown): string {
  return isRecord(cause) && typeof cause.code === 'string' ? cause.code : 'unknown error';
}

function readTokenText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    if (isRecord(cause) && cause.code === 'ENOENT') return undefined;
    throw new SaxoTokenFileError(
      `Saxo token file at ${path} could not be read (${errorCode(cause)}).`,
    );
  }
}

function parseTokenObject(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaxoTokenFileError(`Saxo token file at ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new SaxoTokenFileError(`Saxo token file at ${path} is not an object.`);
  }
  return parsed;
}

export function readTokenFile(path: string): SaxoTokenFileRecord | undefined {
  const text = readTokenText(path);
  if (text === undefined) return undefined;
  const parsed = parseTokenObject(path, text);
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
