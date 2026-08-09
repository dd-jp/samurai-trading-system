import type {
  FlattenAttribution,
  FlattenSubmissionWriteAhead,
  LotAdvance,
  SharedStore,
  UnprotectedResidualLot,
  UnresolvedFlattenSubmission,
} from '../../../pipeline/execution/index.js';
import type { OnTradeCloseInput } from '../../../pipeline/feedback-loop/index.js';
import { FixtureSetupStore } from '../../../pipeline/trader/index.js';
import type { ClosedTrade, Fill, OpenPosition, OrderState } from '../../../shared/index.js';
import type { Logger } from '../types.js';

const { onTradeCloseMock } = vi.hoisted(() => ({ onTradeCloseMock: vi.fn() }));

// Path kept in step with the move by hand: `vi.mock`'s specifier is a call
// argument, not an import, so no automated rewrite sees it — and a stale one
// fails OPEN (the mock silently stops applying and the real module runs),
// which is why this is the only place in the tree that needed a manual fix.
vi.mock('../../../pipeline/feedback-loop/on-trade-close.js', () => ({
  onTradeClose: onTradeCloseMock,
}));

// Imported after the mock so `withOnTradeClose` picks up the mocked `onTradeClose`.
const { withOnTradeClose } = await import('./on-trade-close-hookup.js');

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: 200,
    fees_total: 1,
    opened_at: new Date('2026-07-01T10:00:00Z'),
    closed_at: new Date('2026-07-02T10:00:00Z'),
    close_reason: 'target',
    ...overrides,
  };
}

/** The flat-lot advance shape `ingestFills()` emits — fills plus the close. */
function closingAdvance(trade: ClosedTrade): LotAdvance {
  return { idempotency_key: trade.idempotency_key, fills: [], closed_trade: trade };
}

/**
 * Records every call it receives — enough to prove `withOnTradeClose` is a
 * transparent pass-through on every method except `applyLotAdvance`, and
 * that `applyLotAdvance` itself still reaches the underlying store.
 */
class FakeSharedStore implements SharedStore {
  applyLotAdvanceCalls: LotAdvance[] = [];
  shouldThrow = false;

  async findByKey(_idempotency_key: string): Promise<boolean> {
    return false;
  }
  async writeAheadPosition(_position: OpenPosition): Promise<void> {}
  async updatePositionState(
    _idempotency_key: string,
    _update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {}
  async getOpenPositions(): Promise<OpenPosition[]> {
    return [];
  }
  async hasFill(_broker_fill_id: string): Promise<boolean> {
    return false;
  }
  async getFills(_idempotency_key: string): Promise<Fill[]> {
    return [];
  }
  async getEntryFillSizes(_idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return new Map();
  }
  async getExitFillSizes(_idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return new Map();
  }
  async writeAheadFlatten(_submission: FlattenSubmissionWriteAhead): Promise<void> {}
  async resolveFlattenSubmitted(
    _idempotency_key: string,
    _update: { order_state: OrderState; broker_order_ids: string[] },
    _resolved_at: Date,
  ): Promise<void> {}
  async resolveFlattenError(
    _idempotency_key: string,
    _reason: string,
    _resolved_at: Date,
  ): Promise<void> {}
  async getFlattenAttribution(_idempotency_key: string): Promise<FlattenAttribution | null> {
    return null;
  }
  async getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]> {
    return [];
  }
  async recordFlattenOrderStateObserved(
    _idempotency_key: string,
    _update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {}
  async markFlattenFillsSwept(_idempotency_key: string, _swept_at: Date): Promise<void> {}
  async markResidualUnprotected(_idempotency_key: string, _observed_at: Date): Promise<void> {}
  async confirmResidualProtected(_idempotency_key: string): Promise<void> {}
  async markResidualAlerted(_idempotency_key: string, _alerted_at: Date): Promise<boolean> {
    return true;
  }
  async getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]> {
    return [];
  }
  async applyLotAdvance(advance: LotAdvance): Promise<void> {
    if (this.shouldThrow) {
      throw new Error('boom');
    }
    this.applyLotAdvanceCalls.push(advance);
  }
}

/** Records every entry rather than writing to stdout, for assertions. */
class FakeLogger implements Logger {
  entries: Parameters<Logger['log']>[0][] = [];
  log(entry: Parameters<Logger['log']>[0]): void {
    this.entries.push(entry);
  }
}

describe('withOnTradeClose', () => {
  beforeEach(() => {
    onTradeCloseMock.mockReset();
  });

  it('invokes onTradeClose exactly once when an advance carrying a close succeeds', async () => {
    const store = new FakeSharedStore();
    const logger = new FakeLogger();
    const input: OnTradeCloseInput = { setup_store: new FixtureSetupStore() };
    const decorated = withOnTradeClose(store, input, logger);
    const trade = makeTrade();
    const advance = closingAdvance(trade);

    await decorated.applyLotAdvance(advance);

    expect(store.applyLotAdvanceCalls).toEqual([advance]);
    expect(onTradeCloseMock).toHaveBeenCalledTimes(1);
    expect(onTradeCloseMock).toHaveBeenCalledWith(trade, trade.idempotency_key, input);
    expect(logger.entries).toEqual([]);
  });

  it('never invokes onTradeClose for an advance that carries no close', async () => {
    const store = new FakeSharedStore();
    const input: OnTradeCloseInput = { setup_store: new FixtureSetupStore() };
    const decorated = withOnTradeClose(store, input, new FakeLogger());

    await decorated.applyLotAdvance({ idempotency_key: 'key-1', fills: [] });

    expect(store.applyLotAdvanceCalls).toHaveLength(1);
    expect(onTradeCloseMock).not.toHaveBeenCalled();
  });

  it('does not invoke onTradeClose when the underlying write throws', async () => {
    const store = new FakeSharedStore();
    store.shouldThrow = true;
    const input: OnTradeCloseInput = { setup_store: new FixtureSetupStore() };
    const decorated = withOnTradeClose(store, input, new FakeLogger());

    await expect(decorated.applyLotAdvance(closingAdvance(makeTrade()))).rejects.toThrow('boom');
    expect(onTradeCloseMock).not.toHaveBeenCalled();
  });

  it('logs and swallows an onTradeClose failure rather than failing the write', async () => {
    onTradeCloseMock.mockImplementationOnce(() => {
      throw new Error('no pending setup for debate_id');
    });
    const store = new FakeSharedStore();
    const logger = new FakeLogger();
    const input: OnTradeCloseInput = { setup_store: new FixtureSetupStore() };
    const decorated = withOnTradeClose(store, input, logger);
    const trade = makeTrade();

    // Resolves (does not reject) even though onTradeClose threw — the
    // closed_trades write already succeeded and must not be reported as failed.
    await expect(decorated.applyLotAdvance(closingAdvance(trade))).resolves.toBeUndefined();

    expect(store.applyLotAdvanceCalls).toHaveLength(1);
    expect(onTradeCloseMock).toHaveBeenCalledTimes(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'error', trace_id: trade.idempotency_key });
  });

  it('passes every other method through to the underlying store untouched', async () => {
    const store = new FakeSharedStore();
    const input: OnTradeCloseInput = { setup_store: new FixtureSetupStore() };
    const decorated = withOnTradeClose(store, input, new FakeLogger());

    await expect(decorated.findByKey('k')).resolves.toBe(false);
    await expect(decorated.getOpenPositions()).resolves.toEqual([]);
    await expect(decorated.hasFill('f')).resolves.toBe(false);
    await expect(decorated.getFills('k')).resolves.toEqual([]);
    expect(onTradeCloseMock).not.toHaveBeenCalled();
  });
});
