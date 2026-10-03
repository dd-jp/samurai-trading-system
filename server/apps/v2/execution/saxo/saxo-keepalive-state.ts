import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SaxoKeepAliveState {
  readonly lostAt?: string;
  readonly lostReason?: string;
  readonly warnedAt?: string;
}

export function keepAliveStatePath(tokenPath: string): string {
  return `${tokenPath}.keepalive.json`;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

export function readKeepAliveState(tokenPath: string): SaxoKeepAliveState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keepAliveStatePath(tokenPath), 'utf8'));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const body = parsed as Record<string, unknown>;
  const lostAt = optionalString(body, 'lostAt');
  const lostReason = optionalString(body, 'lostReason');
  const warnedAt = optionalString(body, 'warnedAt');
  return {
    ...(lostAt === undefined ? {} : { lostAt }),
    ...(lostReason === undefined ? {} : { lostReason }),
    ...(warnedAt === undefined ? {} : { warnedAt }),
  };
}

export function writeKeepAliveState(tokenPath: string, state: SaxoKeepAliveState): void {
  const path = keepAliveStatePath(tokenPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function clearKeepAliveState(tokenPath: string): void {
  try {
    unlinkSync(keepAliveStatePath(tokenPath));
  } catch {}
}
