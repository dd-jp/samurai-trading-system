/**
 * Where `SaxoHttpBrokerClient` gets its bearer, per request (#1523).
 *
 * Saxo's documented model for a direct retail client is: log in by hand ONCE
 * (`npm run saxo:login`, #1522), then keep the session alive by exchanging the
 * refresh token before its window closes. Certificate-based headless auth is
 * institutional-only. Every exchange ROTATES the refresh token — Saxo's
 * security page: *"this refresh token replaces and invalidates the previous
 * refresh token"* — so the saved file is not a cache, it is the session.
 *
 * ## What "persist before use" does and does not buy
 *
 * The new refresh token is written to disk BEFORE the access token that came
 * with it is adopted, so this process never trades on a token whose partner
 * was not saved. It narrows the crash window to the file write; it does not
 * close it. Saxo invalidates the old refresh token when the new one is
 * ISSUED, not when it is first used, so a crash between the gateway's reply
 * and the `rename` strands the session whatever the ordering — the recovery
 * for that is a new `npm run saxo:login`, which is why the lost state is
 * reported rather than retried away.
 *
 * ## Timing comes from the response, never from the docs
 *
 * `expires_in` measured 1200 s and `refresh_token_expires_in` 3600 s on live
 * (2026-09-14, #1523), against the documented example's 1200/2400. A
 * hard-coded 40-minute window would have been wrong in the direction that
 * loses the session, so every delay here is derived from the instants the
 * gateway actually returned.
 *
 * ## Paging the operator (#1524)
 *
 * `lose()` posts to `SaxoTokenRefresherDeps.sessionLostAlerts` when supplied,
 * in addition to the `saxo_session_lost` log line it always writes — see
 * `SaxoSessionLostAlertChannel`'s doc for why that call needs no throttle of
 * its own. The weekly re-login reminder Saxo also recommends is a separate,
 * self-scheduled concern with no per-request trigger to hang off
 * (`production/saxo-weekly-reminder-alert.ts`).
 */
import type { Clock, Logger } from '../../../shared/index.js';
import { fetchWithTimeout, maskCredentials, SystemClock } from '../../../shared/index.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import type { FetchLike, SaxoOAuthConfig, SaxoTokenResponse } from './saxo-oauth.js';
import { requestSaxoToken, SaxoOAuthError } from './saxo-oauth.js';
import type { SaxoTokenFileRecord } from './saxo-token-file.js';
import { readTokenFile, writeTokenFile } from './saxo-token-file.js';

export type SaxoSessionState =
  | {
      status: 'active';
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt: string;
      /** Consecutive failed refresh attempts still inside the window; 0 when the last one succeeded */
      failedAttempts: number;
    }
  /** A bearer that cannot be renewed — the operator-pasted `SAXO_*_ACCESS_TOKEN` */
  | { status: 'unrefreshable' }
  | { status: 'lost'; reason: string };

/** Thrown by `getAccessToken()` once the session can no longer be renewed */
export class SaxoSessionLostError extends Error {}

/**
 * The operator escalation for a session going lost (#1524). Posted from
 * `lose()` — the one place a `SaxoTokenRefresher` instance can ever make this
 * transition, and it can make it at most once (every path back into `lose()`
 * is guarded by `this.lostReason !== undefined`) — so "one alert per lost
 * episode, not per failed request" falls out of that guard rather than
 * needing a throttle of its own. A NEW episode is a new instance: this
 * process only ever gets one by restarting after a fresh `npm run saxo:login`
 * (`buildSaxoTokenSource`, production/saxo-venue.ts), which is also the only
 * way `lostReason` is ever cleared.
 *
 * `reason` is always safe to page: every string `lose()` is called with is
 * either hand-composed (naming a path or an instant, never a body) or has
 * already been through `maskCredentials`/`redactSession` — see the call
 * sites below.
 */
export interface SaxoSessionLostAlert {
  environment: SaxoTradingEnvironment;
  reason: string;
  reported_at: Date;
}

/**
 * Declared beside `SaxoSessionLostAlert`, like `TickSkipAlertChannel` beside
 * `TickSkipAlert` (production/tick-skip-alert.ts). The alert catalogue's
 * `saxoSessionLostAlerts` entry (alert-catalogue.ts) implements it; `void`,
 * not `Promise<void>` — `lose()` is called from synchronous code
 * (`load()`'s guards) and cannot await a page without becoming async itself.
 */
export interface SaxoSessionLostAlertChannel {
  postSaxoSessionLostAlert(alert: SaxoSessionLostAlert): void;
}

export interface SaxoTokenSource {
  /** The bearer to send on the NEXT request. Never memoised by the caller. */
  getAccessToken(): Promise<string>;
  sessionState(): SaxoSessionState;
  /**
   * Releases any scheduled work and RESOLVES ONLY once a rotation already in
   * flight has finished writing. Async because of that join: Saxo invalidated
   * the previous refresh token when it issued the one in flight, so a process
   * that exits between receipt and `rename` strands the session and costs the
   * operator a manual `npm run saxo:login`. Idempotent.
   */
  stop(): Promise<void>;
}

/**
 * The pre-#1523 behaviour, kept for the operator who pasted a developer-portal
 * token into `SAXO_SIM_ACCESS_TOKEN` and never ran `npm run saxo:login`: one
 * string, no renewal, and a state that says so out loud rather than reporting
 * a healthy session that will 401 within the day
 */
export class StaticSaxoTokenSource implements SaxoTokenSource {
  constructor(private readonly token: string) {}

  async getAccessToken(): Promise<string> {
    return this.token;
  }

  sessionState(): SaxoSessionState {
    return { status: 'unrefreshable' };
  }

  async stop(): Promise<void> {
    // Nothing is scheduled: there is nothing to renew
  }
}

export interface SaxoRefreshTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/**
 * `unref()` so a scheduled refresh never by itself keeps the process alive —
 * the orchestrator's shutdown, not this timer, decides when the run ends
 */
const DEFAULT_TIMERS: SaxoRefreshTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh this far ahead of the access token's expiry, or a quarter of its remaining life if that is shorter */
const MAX_LEAD_MS = 60_000;
const LEAD_FRACTION = 0.25;
const DEFAULT_BACKOFF = { baseMs: 5_000, maxMs: 120_000 } as const;

export interface SaxoTokenRefresherDeps {
  environment: SaxoTradingEnvironment;
  config: Pick<SaxoOAuthConfig, 'tokenUrl' | 'appKey' | 'appSecret'>;
  /** The saved session (`tokenFilePath(environment)` in production). Read lazily, never at construction. */
  tokenPath: string;
  logger: Logger;
  clock?: Clock;
  fetchImpl?: FetchLike;
  timers?: SaxoRefreshTimers;
  /** Overridden only to inject a failure at the persistence step; see `runRefresh` */
  writeRecord?: (path: string, record: SaxoTokenFileRecord) => void;
  backoff?: { baseMs: number; maxMs: number };
  /** Where a lost session is escalated (#1524); absent means the loss is logged only — see `lose()` */
  sessionLostAlerts?: SaxoSessionLostAlertChannel;
}

export class SaxoTokenRefresher implements SaxoTokenSource {
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly timers: SaxoRefreshTimers;
  private readonly writeRecord: (path: string, record: SaxoTokenFileRecord) => void;
  private readonly backoff: { baseMs: number; maxMs: number };

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
  }

  /**
   * Primes the session from disk and arms the schedule, returning the state
   * for the caller to report, so a boot with no usable session says so at
   * startup rather than on the first order. Called by `buildSaxoTokenSource`.
   */
  start(): SaxoSessionState {
    this.load();
    return this.sessionState();
  }

  async getAccessToken(): Promise<string> {
    this.load();
    // A rotation already in flight owns the file; awaiting it means this
    // caller leaves with the token that was actually persisted, never a
    // superseded one. It never rejects — every outcome lands in state.
    await this.inFlight;
    const record = this.record;
    if (this.lostReason !== undefined || record === undefined) {
      throw new SaxoSessionLostError(
        `Saxo ${this.deps.environment} session is lost: ${this.lostReason ?? 'no saved session'}.`,
      );
    }
    if (Date.parse(record.accessTokenExpiresAt) <= this.clock.now().getTime()) {
      await this.refreshNow();
      const renewed = this.record;
      if (this.lostReason !== undefined || renewed === undefined) {
        throw new SaxoSessionLostError(
          `Saxo ${this.deps.environment} session is lost: ${this.lostReason ?? 'no saved session'}.`,
        );
      }
      // `runRefresh` returns without renewing anything once `stop()` has run,
      // so the record can still be the expired one. Refusing is the only safe
      // answer: an expired bearer buys a 401, which is deliberately NOT
      // retryable, and a shutdown drain would read that as a venue failure
      // instead of as the session having ended
      if (Date.parse(renewed.accessTokenExpiresAt) <= this.clock.now().getTime()) {
        throw new SaxoSessionLostError(
          `Saxo ${this.deps.environment} access token expired at ${renewed.accessTokenExpiresAt} and could not be renewed${this.stopped ? ' — the refresher was stopped' : ''}.`,
        );
      }
      return renewed.accessToken;
    }
    return record.accessToken;
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

  /** Resolves once any in-flight rotation has finished — the join point for a caller that must not race one */
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

  /**
   * Both bounds come from the gateway's own reply. The access token's expiry
   * sets the cadence; the refresh token's caps it, so a schedule can never be
   * armed past the window that makes refreshing possible at all.
   */
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
    const record = this.record;
    if (record === undefined || this.stopped || this.lostReason !== undefined) return;
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
      this.onFailure('saxo_token_refresh_failed', cause);
      return;
    }
    const next: SaxoTokenFileRecord = {
      ...response,
      environment: this.deps.environment,
      obtainedAt: now.toISOString(),
      // Carried forward, not restamped (#1524): a silent rotation is not a
      // manual login, and `loggedInAt` answers "when did an operator last run
      // `npm run saxo:login`", not "when did this process last renew its bearer"
      // — see `SaxoTokenFileRecord.loggedInAt`
      ...(record.loggedInAt === undefined ? {} : { loggedInAt: record.loggedInAt }),
    };
    try {
      // PERSIST BEFORE USE. `this.record` is swapped only after the write
      // returns, so no request can ever go out on an access token whose
      // rotated refresh token is not on disk
      this.writeRecord(this.deps.tokenPath, next);
    } catch (cause) {
      // The gateway has already invalidated `record.refreshToken` by issuing
      // the one that could not be saved, so the retry below will almost
      // certainly be rejected and end in `lost`. That is the honest outcome:
      // the session needs a new login, and pretending otherwise would mean
      // running on an access token nothing can renew
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
    const status = cause instanceof SaxoOAuthError ? cause.status : undefined;
    const detail = this.redactSession(
      cause instanceof Error ? maskCredentials(cause.message) : String(cause),
    );
    // A 4xx is the gateway saying this refresh token is not one it will
    // honour. Retrying cannot change that answer, and each attempt is another
    // request against the account's limit
    if (status !== undefined && status >= 400 && status < 500) {
      this.lose(`the refresh token was rejected (HTTP ${status})`);
      return;
    }
    this.failedAttempts += 1;
    const delay = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * 2 ** (this.failedAttempts - 1),
    );
    const now = this.clock.now().getTime();
    if (record === undefined || now + delay >= Date.parse(record.refreshTokenExpiresAt)) {
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

  /**
   * `maskCredentials` keys on a name beside the value (`"token": "..."`), and
   * a token-endpoint error body can quote the bare secret with no name at all
   * — measured against a fixture that echoes the refresh token back in a 500
   * body. This process knows exactly which strings are its own session's, so
   * it removes those by value before anything is logged.
   */
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
    // Every path into `lose()` is guarded by `this.lostReason !== undefined`
    // (`load()` runs once; `runRefresh()` returns immediately once lost), so
    // this line runs at most once per instance — the "one alert per lost
    // episode" property lives in that guard, not here
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
