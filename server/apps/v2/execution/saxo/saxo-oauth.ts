import { maskCredentials } from '../../../../shared/index.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import { SAXO_CREDENTIAL_ENV_VARS, SAXO_GATEWAY_URLS } from './saxo-environment.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SaxoOAuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_AUTH_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://sim.logonvalidation.net/authorize',
  live: 'https://live.logonvalidation.net/authorize',
};
const DEFAULT_TOKEN_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://sim.logonvalidation.net/token',
  live: 'https://live.logonvalidation.net/token',
};
const DEFAULT_REDIRECT_URI = 'http://localhost:8080/callback';

const SAXO_APP_CREDENTIAL_ENV_VARS: Readonly<
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
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

export type SaxoTokenGrant =
  | { grant_type: 'authorization_code'; code: string; redirect_uri: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

interface SaxoTokenBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function postTokenGrant(
  config: Pick<SaxoOAuthConfig, 'tokenUrl' | 'appKey' | 'appSecret'>,
  grant: SaxoTokenGrant,
  fetchImpl: FetchLike,
): Promise<Response> {
  const basic = Buffer.from(`${config.appKey}:${config.appSecret}`).toString('base64');
  const body = new URLSearchParams({ ...grant });
  try {
    return await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new SaxoOAuthError(`Saxo token exchange failed: network error — ${errorText(cause)}`);
  }
}

async function tokenResponseText(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new SaxoOAuthError(
      `Saxo token exchange failed: response body could not be read — ${errorText(cause)}`,
      response.status,
    );
  }
  if (response.status !== 200 && response.status !== 201) {
    throw new SaxoOAuthError(
      `Saxo token exchange failed: HTTP ${response.status} — ${maskCredentials(text).slice(0, 500)}`,
      response.status,
    );
  }
  return text;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteSeconds(value: unknown): value is number {
  return Number.isFinite(value);
}

function isTokenBody(parsed: unknown): parsed is SaxoTokenBody {
  return (
    isRecord(parsed) &&
    isNonEmptyString(parsed.access_token) &&
    isNonEmptyString(parsed.refresh_token) &&
    isFiniteSeconds(parsed.expires_in) &&
    isFiniteSeconds(parsed.refresh_token_expires_in)
  );
}

function parseTokenBody(text: string, status: number): SaxoTokenBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaxoOAuthError(
      'Saxo token exchange failed: response body was not valid JSON.',
      status,
    );
  }
  if (!isTokenBody(parsed)) {
    throw new SaxoOAuthError(
      'Saxo token exchange failed: response body is missing access_token/refresh_token/expires_in/refresh_token_expires_in.',
      status,
    );
  }
  return parsed;
}

export async function requestSaxoToken(
  config: Pick<SaxoOAuthConfig, 'tokenUrl' | 'appKey' | 'appSecret'>,
  grant: SaxoTokenGrant,
  now: Date,
  fetchImpl: FetchLike,
): Promise<SaxoTokenResponse> {
  const response = await postTokenGrant(config, grant, fetchImpl);
  const parsed = parseTokenBody(await tokenResponseText(response), response.status);
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: new Date(now.getTime() + parsed.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      now.getTime() + parsed.refresh_token_expires_in * 1000,
    ).toISOString(),
  };
}
