/**
 * The Saxo OAuth token endpoint, shared by the one-time operator login
 * (`server/tools/saxo-login.ts`, #1522) and the long-running refresher
 * (`saxo-token-source.ts`, #1523).
 *
 * It lives in `adapters/` rather than in `tools/` because the refresher runs
 * inside the orchestrator: importing the login CLI (which has a top-level
 * `runLogin()` behind an `import.meta.url` guard) from the trading path would
 * invert the existing direction and drag a browser-opening flow into the
 * server bundle. `saxo-login.ts` re-exports what its own callers still name.
 *
 * Both grants — `authorization_code` at login and `refresh_token` afterwards
 * — go through `requestSaxoToken`, so the two facts that are easy to get
 * wrong are stated once: the endpoint answers **201** on live (measured
 * 2026-09-14, #1523), and the lifetimes come from the response
 * (`expires_in` 1200 s, `refresh_token_expires_in` 3600 s live against the
 * docs' 2400) rather than from any published example.
 */
import { maskCredentials } from '../../../shared/index.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import { SAXO_CREDENTIAL_ENV_VARS, SAXO_GATEWAY_URLS } from './saxo-environment.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Carries the HTTP status when the failure was a response rather than a
 * transport or body fault. The refresher reads it to tell a rejected grant
 * (4xx — the refresh token is gone, the session is lost) from a transient
 * one (5xx, timeout — retry inside the remaining window).
 */
export class SaxoOAuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Both Saxo apps register the same localhost redirect (#1522); the environment picks the host. */
const DEFAULT_AUTH_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://sim.logonvalidation.net/authorize',
  live: 'https://live.logonvalidation.net/authorize',
};
const DEFAULT_TOKEN_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://sim.logonvalidation.net/token',
  live: 'https://live.logonvalidation.net/token',
};
const DEFAULT_REDIRECT_URI = 'http://localhost:8080/callback';

export const SAXO_APP_CREDENTIAL_ENV_VARS: Readonly<
  Record<SaxoTradingEnvironment, { appKey: string; appSecret: string }>
> = {
  sim: { appKey: 'SAXO_SIM_APP_KEY', appSecret: 'SAXO_SIM_APP_SECRET' },
  live: { appKey: 'SAXO_LIVE_APP_KEY', appSecret: 'SAXO_LIVE_APP_SECRET' },
};

export interface SaxoOAuthConfig {
  environment: SaxoTradingEnvironment;
  appKey: string;
  appSecret: string;
  authUrl: string;
  tokenUrl: string;
  redirectUri: string;
  gatewayBaseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function resolveSaxoOAuthConfig(
  environment: SaxoTradingEnvironment,
  env: NodeJS.ProcessEnv = process.env,
): SaxoOAuthConfig {
  const credNames = SAXO_APP_CREDENTIAL_ENV_VARS[environment];
  const appKey = readEnv(env, credNames.appKey);
  const appSecret = readEnv(env, credNames.appSecret);
  if (appKey === undefined) {
    throw new SaxoOAuthError(`${credNames.appKey} is not set. Provide it via .env.local.`);
  }
  if (appSecret === undefined) {
    throw new SaxoOAuthError(`${credNames.appSecret} is not set. Provide it via .env.local.`);
  }
  const upper = environment.toUpperCase();
  const authUrl = readEnv(env, `SAXO_${upper}_AUTH_URL`) ?? DEFAULT_AUTH_URLS[environment];
  const tokenUrl = readEnv(env, `SAXO_${upper}_TOKEN_URL`) ?? DEFAULT_TOKEN_URLS[environment];
  const redirectUri = readEnv(env, `SAXO_${upper}_REDIRECT_URI`) ?? DEFAULT_REDIRECT_URI;
  const gatewayNames = SAXO_CREDENTIAL_ENV_VARS[environment];
  const gatewayBaseUrl = readEnv(env, gatewayNames.gateway) ?? SAXO_GATEWAY_URLS[environment];
  return { environment, appKey, appSecret, authUrl, tokenUrl, redirectUri, gatewayBaseUrl };
}

export interface SaxoTokenResponse {
  accessToken: string;
  refreshToken: string;
  /** ISO instant, derived from the response's `expires_in` (measured 1200 s live, 2026-09-14 — never hardcoded). */
  accessTokenExpiresAt: string;
  /** ISO instant, derived from the response's `refresh_token_expires_in` (measured 3600 s live, 2026-09-14 — never hardcoded). */
  refreshTokenExpiresAt: string;
}

export type SaxoTokenGrant =
  | { grant_type: 'authorization_code'; code: string; redirect_uri: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

/**
 * HTTP Basic AppKey:AppSecret at the token URL. Both 200 and 201 count as
 * success — the live gateway measured 201 on 2026-09-14 (#1522's dispatch
 * facts); the docs' example shows 200.
 *
 * No part of `grant` is ever put in an error message: on the refresh grant it
 * IS the refresh token.
 */
export async function requestSaxoToken(
  config: Pick<SaxoOAuthConfig, 'tokenUrl' | 'appKey' | 'appSecret'>,
  grant: SaxoTokenGrant,
  now: Date,
  fetchImpl: FetchLike,
): Promise<SaxoTokenResponse> {
  const basic = Buffer.from(`${config.appKey}:${config.appSecret}`).toString('base64');
  const body = new URLSearchParams({ ...grant });
  let response: Response;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new SaxoOAuthError(
      `Saxo token exchange failed: network error — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new SaxoOAuthError(
      `Saxo token exchange failed: response body could not be read — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      response.status,
    );
  }
  // Masked even though a token-endpoint error body is not expected to echo
  // the app secret back — defense in depth, matching saxo-http-client.ts's
  // own error-body posture.
  if (response.status !== 200 && response.status !== 201) {
    throw new SaxoOAuthError(
      `Saxo token exchange failed: HTTP ${response.status} — ${maskCredentials(text).slice(0, 500)}`,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaxoOAuthError(
      'Saxo token exchange failed: response body was not valid JSON.',
      response.status,
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.access_token !== 'string' ||
    parsed.access_token.length === 0 ||
    typeof parsed.refresh_token !== 'string' ||
    parsed.refresh_token.length === 0 ||
    typeof parsed.expires_in !== 'number' ||
    !Number.isFinite(parsed.expires_in) ||
    typeof parsed.refresh_token_expires_in !== 'number' ||
    !Number.isFinite(parsed.refresh_token_expires_in)
  ) {
    throw new SaxoOAuthError(
      'Saxo token exchange failed: response body is missing access_token/refresh_token/expires_in/refresh_token_expires_in.',
      response.status,
    );
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: new Date(now.getTime() + parsed.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      now.getTime() + parsed.refresh_token_expires_in * 1000,
    ).toISOString(),
  };
}
