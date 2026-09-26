import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpacaClientOrNone } from './alpaca-client.js';

afterEach(() => vi.unstubAllEnvs());

describe('alpacaClientOrNone', () => {
  it('builds the paper client from the paper keys', () => {
    vi.stubEnv('ALPACA_API_KEY', 'paper-key');
    vi.stubEnv('ALPACA_API_SECRET', 'paper-secret');
    const onDisabled = vi.fn();
    expect(alpacaClientOrNone('paper', onDisabled)).toBeDefined();
    expect(onDisabled).not.toHaveBeenCalled();
  });

  it('reports why the balance tile is disabled when the live keys are missing', () => {
    vi.stubEnv('ALPACA_API_KEY', 'paper-key');
    vi.stubEnv('ALPACA_API_SECRET', 'paper-secret');
    vi.stubEnv('ALPACA_LIVE_API_KEY', '');
    vi.stubEnv('ALPACA_LIVE_API_SECRET', '');
    const onDisabled = vi.fn();
    expect(alpacaClientOrNone('live', onDisabled)).toBeUndefined();
    expect(onDisabled).toHaveBeenCalledWith(expect.stringMatching(/\S/));
  });
});
