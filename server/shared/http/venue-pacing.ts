import type { TokenBucketConfig } from './token-bucket.js';

export type VenueKey = 'alpaca' | 'ccxt' | 'ibkr' | 'saxo';

export type VenuePacingConfig = Record<VenueKey, TokenBucketConfig>;

const VENUE_KEYS: readonly VenueKey[] = ['alpaca', 'ccxt', 'ibkr', 'saxo'];

export const VENUE_DOCUMENTED_CEILING_PER_SECOND: Partial<Record<VenueKey, number>> = {
  alpaca: 200 / 60,
  ibkr: 50,
  saxo: 120 / 60,
};

export const POLYGON_DOCUMENTED_CEILING_PER_SECOND = 5 / 60;

export const DEFAULT_VENUE_PACING: VenuePacingConfig = {
  alpaca: { capacity: 41, refillPerSecond: 2.0, reserveForPriority: 21 },
  ccxt: { capacity: 1, refillPerSecond: 1, reserveForPriority: 0 },
  ibkr: { capacity: 5, refillPerSecond: 5, reserveForPriority: 0 },
  saxo: { capacity: 2, refillPerSecond: 1, reserveForPriority: 1 },
};

export const DEFAULT_POLYGON_PACING: TokenBucketConfig = {
  capacity: 1,
  refillPerSecond: 1 / 13,
  reserveForPriority: 0,
};

export function venuePacingEnvVars(venue: string): {
  capacity: string;
  refillPerSecond: string;
  ceilingPerSecond: string;
  reserveForPriority: string;
} {
  const prefix = `SAMURAI_PACING_${venue.toUpperCase()}`;
  return {
    capacity: `${prefix}_CAPACITY`,
    refillPerSecond: `${prefix}_REFILL_PER_SEC`,
    ceilingPerSecond: `${prefix}_CEILING_PER_SEC`,
    reserveForPriority: `${prefix}_PRIORITY_RESERVE`,
  };
}

function resolveCeiling(
  env: NodeJS.ProcessEnv,
  documented: number | undefined,
  name: string,
): number | undefined {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return documented;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite number greater than 0; got '${raw}'.`);
  }
  return value;
}

function readPositive(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  constraints: {
    min: number;
    minLabel: string;
    ceiling?: number | undefined;
    ceilingEnvVar?: string;
  },
): number {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number; got '${raw}'.`);
  }
  if (value < constraints.min) {
    throw new Error(`${name} must be ${constraints.minLabel}; got ${value}.`);
  }
  if (constraints.ceiling !== undefined && value > constraints.ceiling) {
    throw new Error(
      `${name}=${value} exceeds the venue's documented limit of ${constraints.ceiling}/s. ` +
        'Pacing above a published rate limit does not make the system faster — it earns a 429 ' +
        'and, sustained, a banned API key. If THIS ACCOUNT has a documented allowance above ' +
        `that figure, state it with ${constraints.ceilingEnvVar} — no code change needed.`,
    );
  }
  return value;
}

function resolveBucketPacing(
  env: NodeJS.ProcessEnv,
  names: ReturnType<typeof venuePacingEnvVars>,
  fallback: TokenBucketConfig,
  documentedCeiling: number | undefined,
): TokenBucketConfig {
  return {
    capacity: readPositive(env, names.capacity, fallback.capacity, {
      min: 1,
      minLabel: 'at least 1 (a bucket under one token never releases a call)',
    }),
    refillPerSecond: readPositive(env, names.refillPerSecond, fallback.refillPerSecond, {
      min: Number.MIN_VALUE,
      minLabel: 'greater than 0 (a non-positive rate parks every call forever)',
      ceiling: resolveCeiling(env, documentedCeiling, names.ceilingPerSecond),
      ceilingEnvVar: names.ceilingPerSecond,
    }),
    reserveForPriority: resolveReserve(env, names, fallback),
  };
}

export function resolveVenuePacing(env: NodeJS.ProcessEnv = process.env): VenuePacingConfig {
  const resolved = {} as VenuePacingConfig;

  for (const venue of VENUE_KEYS) {
    resolved[venue] = resolveBucketPacing(
      env,
      venuePacingEnvVars(venue),
      DEFAULT_VENUE_PACING[venue],
      VENUE_DOCUMENTED_CEILING_PER_SECOND[venue],
    );
  }

  return resolved;
}

export function resolvePolygonPacing(env: NodeJS.ProcessEnv = process.env): TokenBucketConfig {
  return resolveBucketPacing(
    env,
    venuePacingEnvVars('polygon'),
    DEFAULT_POLYGON_PACING,
    POLYGON_DOCUMENTED_CEILING_PER_SECOND,
  );
}

export const DISTINCT_BAR_WINDOWS_PER_INSTRUMENT = 4;

export function deriveAnalystDrainMs(pacing: TokenBucketConfig, universeSize: number): number {
  const backgroundHeadroom = pacing.capacity - (pacing.reserveForPriority ?? 0);
  const sweepRequests = universeSize * DISTINCT_BAR_WINDOWS_PER_INSTRUMENT;
  return Math.max(((sweepRequests - backgroundHeadroom) / pacing.refillPerSecond) * 1_000, 0);
}

export function deriveAnalystTimeoutMs(
  pacing: TokenBucketConfig,
  universeSize: number,
  fetchBoundMs: number,
): number {
  return deriveAnalystDrainMs(pacing, universeSize) + fetchBoundMs;
}

function resolveReserve(
  env: NodeJS.ProcessEnv,
  names: ReturnType<typeof venuePacingEnvVars>,
  fallback: TokenBucketConfig,
): number {
  const capacity = readPositive(env, names.capacity, fallback.capacity, {
    min: 1,
    minLabel: 'at least 1 (a bucket under one token never releases a call)',
  });
  const reserve = readPositive(env, names.reserveForPriority, fallback.reserveForPriority ?? 0, {
    min: 0,
    minLabel: 'at least 0',
  });

  if (reserve > capacity - 1) {
    throw new Error(
      `${names.reserveForPriority}=${reserve} leaves no token for background callers under a ` +
        `capacity of ${capacity}: a background acquire needs 1 + reserve tokens, so market-data ` +
        'calls would park forever and the run would look like a quiet market rather than a ' +
        `stopped one. Use at most ${capacity - 1}, or raise ${names.capacity}.`,
    );
  }
  return reserve;
}
