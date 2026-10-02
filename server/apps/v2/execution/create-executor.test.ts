import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSharedStore } from '../../../shared/store/index.js';
import { createBrokerAccess, type OrderExecutorOptions } from './create-executor.js';
import type { FillPricing } from './simulated-costs.js';

const PRICING: FillPricing = { halfSpreadBps: () => 0, impactBps: () => 0, fee: () => 0 };
const CLOCK = { now: () => new Date('2026-09-28T12:00:00Z') };

function options(overrides: Partial<OrderExecutorOptions> = {}): OrderExecutorOptions {
  return {
    dryRun: false,
    pricing: PRICING,
    db: openSharedStore(':memory:'),
    clock: CLOCK,
    logger: { log: () => undefined },
    ...overrides,
  };
}

function paperCredentialsOnly(): void {
  vi.stubEnv('ALPACA_API_KEY', 'paper-key');
  vi.stubEnv('ALPACA_API_SECRET', 'paper-secret');
  vi.stubEnv('ALPACA_LIVE_API_KEY', '');
  vi.stubEnv('ALPACA_LIVE_API_SECRET', '');
}

describe('createBrokerAccess: broker mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a paper client when no mode is given', () => {
    paperCredentialsOnly();
    expect(() => createBrokerAccess(options())).not.toThrow();
  });

  it('builds a paper client for paper mode', () => {
    paperCredentialsOnly();
    expect(() => createBrokerAccess(options({ brokerMode: 'paper' }))).not.toThrow();
  });

  it('live mode needs the live credentials and never falls back to the paper ones', () => {
    paperCredentialsOnly();
    expect(() => createBrokerAccess(options({ brokerMode: 'live' }))).toThrow(
      'ALPACA_LIVE_API_KEY',
    );
  });

  it('live mode builds a client once the live credentials are present', () => {
    paperCredentialsOnly();
    vi.stubEnv('ALPACA_LIVE_API_KEY', 'live-key');
    vi.stubEnv('ALPACA_LIVE_API_SECRET', 'live-secret');
    expect(() => createBrokerAccess(options({ brokerMode: 'live' }))).not.toThrow();
  });

  it('a dry run builds no client whatever the mode', () => {
    paperCredentialsOnly();
    expect(() => createBrokerAccess(options({ dryRun: true, brokerMode: 'live' }))).not.toThrow();
  });
});
