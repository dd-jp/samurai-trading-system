import type { Clock, InjectableTimers, Logger } from '../../../shared/index.js';
import {
  DEFAULT_INJECTABLE_TIMERS,
  fetchWithTimeout,
  maskCredentials,
  SystemClock,
} from '../../../shared/index.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import type { FetchLike, SaxoOAuthConfig, SaxoTokenResponse } from './saxo-oauth.js';
import { requestSaxoToken, SaxoOAuthError } from './saxo-oauth.js';
import type { SaxoTokenFileRecord } from './saxo-token-file.js';
import { readTokenFile, writeTokenFile } from './saxo-token-file.js';
import { tryLockTokenFile } from './saxo-token-lock.js';

export type SaxoSessionState =
  | {
      status: 'active';
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt: string;
      failedAttempts: number;
    }
  | { status: 'unrefreshable' }
  | { status: 'lost'; reason: string };

export class SaxoSessionLostError extends Error {}

export interface SaxoSessionLostAlert {
  environment: SaxoTradingEnvironment;
  reason: string;
  reported_at: Date;
}

export interface SaxoSessionLostAlertChannel {
  postSaxoSessionLostAlert(alert: SaxoSessionLostAlert): void;
}

export interface SaxoTokenSource {
  getAccessToken(): Promise<string>;
  sessionState(): SaxoSessionState;
  stop(): Promise<void>;
}

export class StaticSaxoTokenSource implements SaxoTokenSource {
  constructor(private readonly token: string) {}

  async getAccessToken(): Promise<string> {
    return this.token;
  }

  sessionState(): SaxoSessionState {
    return { status: 'unrefreshable' };
  }

  async stop(): Promise<void> {}
}

export type SaxoRefreshTimers = InjectableTimers;

const DEFAULT_TIMERS: SaxoRefreshTimers = DEFAULT_INJECTABLE_TIMERS;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LEAD_MS = 60_000;
const LEAD_FRACTION = 0.25;
const DEFAULT_BACKOFF = { baseMs: 5_000, maxMs: 120_000 } as const;
const LOCK_POLL_MS = 1_000;
const LOCK_ATTEMPTS = 10;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface SaxoTokenRefresherDeps {
  environment: SaxoTradingEnvironment;
  config: Pick<SaxoOAuthConfig, 'tokenUrl' | 'appKey' | 'appSecret'>;
  tokenPath: string;
  logger: Logger;
  clock?: Clock;
  fetchImpl?: FetchLike;
  timers?: SaxoRefreshTimers;
  writeRecord?: (path: string, record: SaxoTokenFileRecord) => void;
  backoff?: { baseMs: number; maxMs: number };
  sessionLostAlerts?: SaxoSessionLostAlertChannel;
  sleep?: (ms: number) => Promise<void>;
}

function oauthFailureStatus(cause: unknown): number | undefined {
  return cause instanceof SaxoOAuthError ? cause.status : undefined;
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? maskCredentials(cause.message) : String(cause);
}

function isTerminalOAuthFailure(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

function refreshWindowExpired(record: SaxoTokenFileRecord, now: number, delay: number): boolean {
  return now + delay >= Date.parse(record.refreshTokenExpiresAt);
}

export class SaxoTokenRefresher implements SaxoTokenSource {
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly timers: SaxoRefreshTimers;
  private readonly writeRecord: (path: string, record: SaxoTokenFileRecord) => void;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly sleep: (ms: number) => Promise<void>;

  private record: SaxoTokenFileRecord | undefined;
  private lostReason: string | undefined;
  private loaded = false;
  private stopped = false;
  private handle: unknown;
  private inFlight: Promise<void> | undefined;
  private failedAttempts = 0;

  constructor(private readonly deps: SaxoTokenRefresherDeps) {
    this.clock = deps.clock ?? new SystemClock();
    this.fetchImpl =
      deps.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init, DEFAULT_TIMEOUT_MS));
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.writeRecord = deps.writeRecord ?? writeTokenFile;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  start(): SaxoSessionState {
    this.load();
    return this.sessionState();
  }

  private assertSessionUsable(
    record: SaxoTokenFileRecord | undefined,
  ): asserts record is SaxoTokenFileRecord {
    if (this.lostReason !== undefined || record === undefined) {
      throw new SaxoSessionLostError(
        `Saxo ${this.deps.environment} session is lost: ${this.lostReason ?? 'no saved session'}.`,
      );
    }
  }

  async getAccessToken(): Promise<string> {
    this.load();
    await this.inFlight;
    const record = this.record;
    this.assertSessionUsable(record);
    if (Date.parse(record.accessTokenExpiresAt) <= this.clock.now().getTime()) {
      await this.refreshNow();
      const renewed = this.record;
      this.assertSessionUsable(renewed);
      if (Date.parse(renewed.accessTokenExpiresAt) <= this.clock.now().getTime()) {
        throw new SaxoSessionLostError(
          `Saxo ${this.deps.environment} access token expired at ${renewed.accessTokenExpiresAt} and could not be renewed${this.stopped ? ' — the refresher was stopped' : ''}.`,
        );
      }
      return renewed.accessToken;
    }
    return record.accessToken;
  }

  async renewNow(): Promise<SaxoSessionState> {
    this.load();
    await this.refreshNow();
    return this.sessionState();
  }

  sessionState(): SaxoSessionState {
    if (this.lostReason !== undefined) return { status: 'lost', reason: this.lostReason };
    const record = this.record;
    if (record === undefined) return { status: 'lost', reason: 'no saved session has been read' };
    return {
      status: 'active',
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      refreshTokenExpiresAt: record.refreshTokenExpiresAt,
      failedAttempts: this.failedAttempts,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.whenIdle();
  }

  async whenIdle(): Promise<void> {
    await this.inFlight;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const { environment, tokenPath } = this.deps;
    let record: SaxoTokenFileRecord | undefined;
    try {
      record = readTokenFile(tokenPath);
    } catch (cause) {
      this.lose(cause instanceof Error ? maskCredentials(cause.message) : 'token file unreadable');
      return;
    }
    if (record === undefined) {
      this.lose(
        `no saved session at ${tokenPath} — run \`npm run saxo:login -- --env ${environment}\` once`,
      );
      return;
    }
    if (record.environment !== environment) {
      this.lose(
        `the saved session at ${tokenPath} is for the ${record.environment} gateway, not ${environment}`,
      );
      return;
    }
    this.record = record;
    if (Date.parse(record.refreshTokenExpiresAt) <= this.clock.now().getTime()) {
      this.lose(
        `the saved refresh token expired at ${record.refreshTokenExpiresAt} — run \`npm run saxo:login -- --env ${environment}\` again`,
      );
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    const record = this.record;
    if (record === undefined || this.stopped) return;
    this.clearTimer();
    const now = this.clock.now().getTime();
    const accessRemaining = Date.parse(record.accessTokenExpiresAt) - now;
    const refreshRemaining = Date.parse(record.refreshTokenExpiresAt) - now;
    const lead = Math.min(MAX_LEAD_MS, Math.max(accessRemaining, 0) * LEAD_FRACTION);
    const delay = Math.max(0, Math.min(accessRemaining - lead, refreshRemaining - lead));
    this.handle = this.timers.set(() => {
      void this.refreshNow();
    }, delay);
  }

  private refreshNow(): Promise<void> {
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runRefresh(): Promise<void> {
    if (this.record === undefined || this.stopped || this.lostReason !== undefined) return;
    const release = await this.acquireLock();
    if (release === undefined) {
      this.onFailure('saxo_token_refresh_failed', new Error('the token refresh lock stayed held'));
      return;
    }
    try {
      if (this.adoptPeerRotation()) {
        this.schedule();
        return;
      }
      await this.rotate();
    } finally {
      release();
    }
  }

  private async acquireLock(): Promise<(() => void) | undefined> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const release = tryLockTokenFile(this.deps.tokenPath, this.clock.now().getTime());
      if (release !== undefined) return release;
      await this.sleep(LOCK_POLL_MS);
    }
    return undefined;
  }

  private readPeerRecord(): SaxoTokenFileRecord | undefined {
    try {
      const onDisk = readTokenFile(this.deps.tokenPath);
      return onDisk?.environment === this.deps.environment ? onDisk : undefined;
    } catch {
      return undefined;
    }
  }

  private adoptPeerRotation(): boolean {
    const own = this.record;
    const peer = this.readPeerRecord();
    if (own === undefined || peer === undefined) return false;
    if (Date.parse(peer.obtainedAt) <= Date.parse(own.obtainedAt)) return false;
    if (Date.parse(peer.accessTokenExpiresAt) <= this.clock.now().getTime()) return false;
    this.record = peer;
    return true;
  }

  private adoptPeerRotationOf(sentRefreshToken: string): boolean {
    const peer = this.readPeerRecord();
    if (peer === undefined || peer.refreshToken === sentRefreshToken) return false;
    if (Date.parse(peer.refreshTokenExpiresAt) <= this.clock.now().getTime()) return false;
    this.record = peer;
    return true;
  }

  private async rotate(): Promise<void> {
    const record = this.record;
    if (record === undefined) return;
    const now = this.clock.now();
    let response: SaxoTokenResponse;
    try {
      response = await requestSaxoToken(
        this.deps.config,
        { grant_type: 'refresh_token', refresh_token: record.refreshToken },
        now,
        this.fetchImpl,
      );
    } catch (cause) {
      if (
        isTerminalOAuthFailure(oauthFailureStatus(cause)) &&
        this.adoptPeerRotationOf(record.refreshToken)
      ) {
        this.schedule();
        return;
      }
      this.onFailure('saxo_token_refresh_failed', cause);
      return;
    }
    const next: SaxoTokenFileRecord = {
      ...response,
      environment: this.deps.environment,
      obtainedAt: now.toISOString(),
      ...(record.loggedInAt === undefined ? {} : { loggedInAt: record.loggedInAt }),
    };
    try {
      this.writeRecord(this.deps.tokenPath, next);
    } catch (cause) {
      this.onFailure('saxo_token_persist_failed', cause);
      return;
    }
    this.record = next;
    this.failedAttempts = 0;
    this.deps.logger.log({
      trace_id: 'saxo-token',
      stage: 'orchestrator',
      event: 'saxo_token_refreshed',
      level: 'info',
      message: `Saxo ${this.deps.environment} session refreshed`,
      payload: {
        environment: this.deps.environment,
        access_token_expires_at: next.accessTokenExpiresAt,
        refresh_token_expires_at: next.refreshTokenExpiresAt,
      },
    });
    this.schedule();
  }

  private onFailure(event: string, cause: unknown): void {
    const record = this.record;
    const status = oauthFailureStatus(cause);
    const detail = this.redactSession(failureDetail(cause));
    if (isTerminalOAuthFailure(status)) {
      this.lose(`the refresh token was rejected (HTTP ${status})`);
      return;
    }
    this.failedAttempts += 1;
    const delay = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * 2 ** (this.failedAttempts - 1),
    );
    const now = this.clock.now().getTime();
    if (record === undefined || refreshWindowExpired(record, now, delay)) {
      this.lose(
        `${this.failedAttempts} refresh attempts failed and the refresh window closes at ${
          record?.refreshTokenExpiresAt ?? 'an unknown instant'
        }`,
      );
      return;
    }
    this.deps.logger.log({
      trace_id: 'saxo-token',
      stage: 'orchestrator',
      event,
      level: 'warn',
      message: `Saxo ${this.deps.environment} token refresh failed; retrying inside the refresh window`,
      payload: {
        environment: this.deps.environment,
        attempt: this.failedAttempts,
        retry_in_ms: delay,
        status: status ?? null,
        detail,
        refresh_token_expires_at: record.refreshTokenExpiresAt,
      },
    });
    this.clearTimer();
    this.handle = this.timers.set(() => {
      void this.refreshNow();
    }, delay);
  }

  private redactSession(text: string): string {
    const record = this.record;
    if (record === undefined) return text;
    return text
      .replaceAll(record.refreshToken, '[redacted refresh token]')
      .replaceAll(record.accessToken, '[redacted access token]');
  }

  private lose(reason: string): void {
    this.lostReason = reason;
    this.clearTimer();
    this.deps.logger.log({
      trace_id: 'saxo-token',
      stage: 'orchestrator',
      event: 'saxo_session_lost',
      level: 'error',
      message: `Saxo ${this.deps.environment} session is lost: ${reason}`,
      payload: { environment: this.deps.environment, reason },
    });
    this.deps.sessionLostAlerts?.postSaxoSessionLostAlert({
      environment: this.deps.environment,
      reason,
      reported_at: this.clock.now(),
    });
  }

  private clearTimer(): void {
    if (this.handle === undefined) return;
    this.timers.clear(this.handle);
    this.handle = undefined;
  }
}
