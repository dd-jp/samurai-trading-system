import { AlpacaHttpBrokerClient } from '../../pipeline/execution/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import type { StoreMode } from '../../shared/store/index.js';

export function alpacaClientOrNone(
  mode: StoreMode,
  onDisabled: (reason: string) => void,
): AlpacaHttpBrokerClient | undefined {
  try {
    return new AlpacaHttpBrokerClient({ environment: mode === 'live' ? 'live' : 'paper' });
  } catch (error) {
    onDisabled(describeThrownSafely(error));
    return undefined;
  }
}
