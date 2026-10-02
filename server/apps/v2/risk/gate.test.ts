import { describe, expect, it } from 'vitest';
import type {
  BookDay,
  BookSpec,
  CapitalYear,
  EntryRequest,
  LossBudgetState,
  MarketData,
  Position,
  SleeveDecision,
  SleeveSpec,
  V2Bar,
  Venue,
} from '../../../../contracts/index.js';
import { isRiskApproved } from './approval.js';
import { V2RiskGate } from './gate.js';

const FX = 1.25;
const primary: BookSpec = {
  id: 'debate/primary',
  sleeve: 'debate',
  variant: 'primary',
  instantiated: true,
};
const shadow: BookSpec = { ...primary, id: 'debate/no-macro-gate', variant: 'no-macro-gate' };
const year: CapitalYear = {
  year: 2026,
  effectiveFrom: '2026-01-01',
  startCapitalGbp: 2_000,
  lossCapGbp: 1_500,
};
const SPEC: SleeveSpec = {
  capitalShare: 1,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: true,
  sizing: {
    riskFraction: 0.005,
    stopAtrMultiple: 2,
    targetAtrMultiple: 3,
    timeStopTradingDays: 10,
    advShare: 0.01,
    advWindowBars: 20,
  },
  books: [],
};

function liquidBars(count = 20, volume = 1_000_000, lastDate = '2026-09-24'): V2Bar[] {
  const last = Date.parse(`${lastDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(last - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    open: 20,
    high: 20,
    low: 20,
    close: 20,
    volume,
    rawClose: 20,
  }));
}

function marketWith(bars: readonly V2Bar[]): MarketData {
  return {
    lastBarBefore: () => undefined,
    barsBefore: (_instrument, _tradingDate, count) => bars.slice(-count),
    gbpUsdAtYearStart: () => FX,
  };
}
const decision: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'AAPL',
  venue: 'alpaca',
  direction: 'bullish',
  confidence: 1,
  action: 'enter_long',
  reason: 'r',
  price: 20,
  atr: 0.4,
  stop_price: 19.2,
  inputs_hash: 'h',
  debate_id: 'd',
  payload: {},
};

function gate(
  options: {
    state?: Partial<LossBudgetState>;
    capital?: CapitalYear | undefined;
    bars?: readonly V2Bar[];
    spec?: SleeveSpec;
    venueRefusal?: ((venue: Venue) => string | undefined) | undefined;
    fixDate?: string;
  } = {},
) {
  const lastDay = (): BookDay | undefined =>
    options.state === undefined
      ? undefined
      : {
          bookId: 'debate/primary',
          tradingDate: '2026-09-24',
          equityGbp: 1_000,
          cashGbp: 1_000,
          investedGbp: 0,
          custodyAccrualGbp: 0,
          cfdFinancingAccrualGbp: 0,
          cfdBorrowAccrualGbp: 0,
          recordedAt: '2026-09-24T21:00:00.000Z',
          state: {
            referenceEquityGbp: 1_000,
            ytdLossGbp: 0,
            sizeMultiplier: 1,
            halted: false,
            entriesBlockedAtNextFill: false,
            ...options.state,
          },
        };
  const capital = 'capital' in options ? options.capital : year;
  return new V2RiskGate({
    books: { lastDay },
    capital: { inForce: () => capital },
    market: {
      ...marketWith(options.bars ?? liquidBars()),
      gbpUsdYearStartFixDate: () => options.fixDate ?? '2025-12-31',
    },
    spec: () => options.spec ?? SPEC,
    venueRefusal: 'venueRefusal' in options ? options.venueRefusal : () => undefined,
  });
}

const cfdShort: SleeveDecision = {
  ...decision,
  venue: 'saxo_cfd_usd',
  direction: 'bearish',
  action: 'enter_short',
  stop_price: 20.8,
};

const signalLong: SleeveDecision = { ...decision, entry_limit: 20 };
const signalShort: SleeveDecision = { ...cfdShort, entry_limit: 20 };

function request(overrides: Partial<EntryRequest> = {}): EntryRequest {
  return {
    book: primary,
    decision,
    clientOrderId: 'c1',
    tradingDate: '2026-09-25',
    equityGbp: 1_000,
    macroDay: false,
    ...overrides,
  };
}

describe('V2RiskGate', () => {
  it('mints a frozen bracket entry sized in GBP with the target at three ATR', () => {
    const approval = gate().approveEntry(request());
    expect(approval.size).toBe(6);
    expect(approval.order).toEqual({
      kind: 'bracket_entry',
      approvalId: 'entry:c1:6',
      clientOrderId: 'c1',
      bookId: 'debate/primary',
      bookVariant: 'primary',
      venue: 'alpaca',
      instrument: 'AAPL',
      side: 'buy',
      size: 6,
      entry: expect.closeTo(20.1, 9),
      stop: 19.2,
      target: expect.closeTo(21.2, 9),
    });
    expect(approval.order !== undefined && isRiskApproved(approval.order)).toBe(true);
    expect(Object.isFrozen(approval.order)).toBe(true);
  });

  it('sends a decision-close entry as a limit 50 bps through the close, stop and target as decided (#1815)', () => {
    expect(gate().approveEntry(request()).order).toMatchObject({
      entry: expect.closeTo(20.1, 9),
      stop: 19.2,
      target: expect.closeTo(21.2, 9),
    });
    expect(gate().approveEntry(request({ decision: cfdShort })).order).toMatchObject({
      entry: expect.closeTo(19.9, 9),
      stop: 20.8,
      target: expect.closeTo(18.8, 9),
    });
    expect(gate().approveEntry(request({ decision: signalLong })).order).toMatchObject({
      entry: 20,
    });
  });

  it('offsets a Saxo LSE entry by the same 50 bps as an Alpaca one (#1815, 2026-09-30)', () => {
    const saxo = { ...decision, venue: 'saxo' as const };
    expect(gate().approveEntry(request({ decision: saxo })).order).toMatchObject({
      venue: 'saxo',
      entry: expect.closeTo(20.1, 9),
    });
    expect(gate().approveEntry(request({ decision: cfdShort })).order).toMatchObject({
      venue: 'saxo_cfd_usd',
      side: 'sell',
      entry: expect.closeTo(19.9, 9),
    });
  });

  it("tags an approved entry with the offset it used, and a sleeve's own limit with none", () => {
    expect(gate().approveEntry(request())).toMatchObject({ entryOffsetBps: 50 });
    expect(gate().approveEntry(request({ decision: cfdShort }))).toMatchObject({
      entryOffsetBps: 50,
    });
    const own = gate().approveEntry(request({ decision: signalLong }));
    expect(own.order).toBeDefined();
    expect(own).toMatchObject({ entryOffsetBps: undefined });
  });

  it('refuses an offset that carries the limit to or past the target', () => {
    for (const target_price of [20.05, 20.1]) {
      expect(
        gate().approveEntry(request({ decision: { ...decision, target_price } })),
      ).toMatchObject({ order: undefined, refusal: 'offset_past_target' });
    }
    expect(
      gate().approveEntry(request({ decision: { ...cfdShort, target_price: 19.95 } })),
    ).toMatchObject({ order: undefined, refusal: 'offset_past_target' });
    expect(
      gate().approveEntry(request({ decision: { ...signalLong, target_price: 20.05 } })).order,
    ).toBeDefined();
  });

  it('sizes the risk from the limit to the stop, not from the close', () => {
    const wide = { ...decision, atr: 0.6, stop_price: 18.8 };
    const sized = (entry: SleeveDecision) =>
      gate().approveEntry(request({ equityGbp: 10_000, decision: entry })).size;
    expect(sized(wide)).toBe(48);
    expect(sized({ ...wide, entry_limit: 20 })).toBe(52);
  });

  it('mints shorts as sells with the target below the entry', () => {
    const approval = gate().approveEntry(request({ decision: cfdShort }));
    expect(approval.order).toMatchObject({ side: 'sell', target: expect.closeTo(18.8, 9) });
  });

  it('refuses a short on any venue that is not a CFD, whatever else is true', () => {
    for (const venue of ['alpaca', 'saxo'] as const) {
      expect(gate().approveEntry(request({ decision: { ...cfdShort, venue } }))).toEqual({
        size: 0,
        order: undefined,
        refusal: 'short_requires_cfd',
      });
    }
  });

  it('refuses a long on either CFD venue whatever else is true', () => {
    for (const venue of ['saxo_cfd_gbp', 'saxo_cfd_usd'] as const) {
      expect(gate().approveEntry(request({ decision: { ...decision, venue } }))).toEqual({
        size: 0,
        order: undefined,
        refusal: 'long_on_cfd',
      });
    }
  });

  it('lets a long through on a non-CFD venue and a short through on either CFD venue', () => {
    expect(gate().approveEntry(request()).order).toBeDefined();
    for (const venue of ['saxo_cfd_gbp', 'saxo_cfd_usd'] as const) {
      expect(
        gate().approveEntry(request({ decision: { ...cfdShort, venue } })).order,
      ).toBeDefined();
    }
  });

  it('refuses every CFD entry when no venue refusal is injected, and leaves cash venues alone', () => {
    const closed = gate({ venueRefusal: undefined });
    for (const venue of ['saxo_cfd_gbp', 'saxo_cfd_usd'] as const) {
      expect(closed.approveEntry(request({ decision: { ...cfdShort, venue } }))).toEqual({
        size: 0,
        order: undefined,
        refusal: 'cfd_cost_model_unset',
      });
    }
    expect(closed.approveEntry(request()).order).toBeDefined();
  });

  it('applies the injected venue refusal to the routed venue and names it', () => {
    const refusing = gate({
      venueRefusal: (venue) => (venue === 'saxo_cfd_usd' ? 'cfd_cost_model_unset' : undefined),
    });
    expect(refusing.approveEntry(request({ decision: cfdShort }))).toEqual({
      size: 0,
      order: undefined,
      refusal: 'cfd_cost_model_unset',
    });
    expect(refusing.approveEntry(request()).order).toBeDefined();
  });

  it('caps a CFD short so a +30% gap costs at most 10% of the sleeve loss cap', () => {
    const sized = (lossCapGbp: number, capitalShare = 1) =>
      gate({ capital: { ...year, lossCapGbp }, spec: { ...SPEC, capitalShare } }).approveEntry(
        request({ decision: cfdShort }),
      ).size;
    expect(sized(1_500)).toBe(6);
    expect(sized(160)).toBe(3);
    expect(sized(100)).toBe(2);
    expect(sized(20)).toBe(0);
    expect(sized(100, 0.3)).toBe(0);
  });

  it('does not gap-cap a long', () => {
    const tiny = gate({ capital: { ...year, lossCapGbp: 20 } });
    expect(tiny.approveEntry(request()).size).toBe(6);
  });

  it('builds the entry room from cash and the gap between equity and gross notional', () => {
    expect(gate().entryRoom(1_000, 700, 300)).toEqual({ cashGbp: 700, grossGbp: 700 });
    expect(gate().entryRoom(1_000, 1_900, 900)).toEqual({ cashGbp: 1_900, grossGbp: 100 });
  });

  it('refuses on a NaN room or notional rather than letting the entry through', () => {
    const room = { cashGbp: 500, grossGbp: 100 };
    expect(gate().entryRoomRefusal(Number.NaN, room)).toBe('insufficient_cash');
    expect(gate().entryRoomRefusal(10, { cashGbp: Number.NaN, grossGbp: 100 })).toBe(
      'insufficient_cash',
    );
    expect(gate().entryRoomRefusal(10, { cashGbp: 500, grossGbp: Number.NaN })).toBe('gross_cap');
    expect(gate().entryRoom(Number.NaN, 500, 0).grossGbp).toBeNaN();
  });

  it('refuses on room: cash first, then the 1x gross cap', () => {
    const room = { cashGbp: 500, grossGbp: 100 };
    expect(gate().entryRoomRefusal(100, room)).toBeUndefined();
    expect(gate().entryRoomRefusal(100.01, room)).toBe('gross_cap');
    expect(gate().entryRoomRefusal(500.01, room)).toBe('insufficient_cash');
  });

  it('converts only US prices by the year-start rate', () => {
    const saxo = { ...decision, venue: 'saxo' as const };
    expect(gate().approveEntry(request({ decision: saxo })).size).toBe(4);
    expect(gate().approveEntry(request()).size).toBe(6);
  });

  it('halves the primary on a macro day but never the no-macro-gate shadow', () => {
    expect(gate().approveEntry(request({ macroDay: true })).size).toBe(3);
    expect(gate().approveEntry(request({ macroDay: true, book: shadow })).size).toBe(6);
    const ungated = gate({ spec: { ...SPEC, macroGate: false } });
    expect(ungated.approveEntry(request({ macroDay: true })).size).toBe(6);
  });

  it('applies a same-day tightening to entries before the next mark', () => {
    const state = { ytdLossGbp: 800, sizeMultiplier: 0.5 as const };
    expect(gate({ state }).approveEntry(request()).size).toBe(3);
    const tightened = gate({ state, capital: { ...year, lossCapGbp: 1_200 } });
    expect(tightened.approveEntry(request()).size).toBe(1);
    const halted = gate({ state, capital: { ...year, lossCapGbp: 600 } });
    expect(halted.approveEntry(request())).toEqual({
      size: 0,
      order: undefined,
      refusal: 'zero_size',
    });
  });

  it("starts a new year at full size but keeps the previous close's daily-cap block", () => {
    const state = { ytdLossGbp: 1_400, sizeMultiplier: 0.25 as const };
    const nextYear = { ...year, year: 2027, effectiveFrom: '2027-01-01' };
    expect(gate({ state, capital: nextYear }).approveEntry(request()).size).toBe(6);
    const blocked = gate({
      state: { ...state, entriesBlockedAtNextFill: true },
      capital: nextYear,
    });
    expect(blocked.approveEntry(request()).size).toBe(0);
    const halted = gate({
      state: { ...state, sizeMultiplier: 0, halted: true, entriesBlockedAtNextFill: true },
      capital: nextYear,
    });
    expect(halted.approveEntry(request()).size).toBe(6);
  });

  it('refuses a stop on the wrong side of the entry and a target at or below zero', () => {
    for (const stop_price of [20, 20.4]) {
      expect(gate().approveEntry(request({ decision: { ...decision, stop_price } }))).toMatchObject(
        { order: undefined, refusal: 'stop_wrong_side' },
      );
    }
    for (const stop_price of [20, 19.6]) {
      expect(gate().approveEntry(request({ decision: { ...cfdShort, stop_price } }))).toMatchObject(
        { order: undefined, refusal: 'stop_wrong_side' },
      );
    }
    expect(
      gate().approveEntry(
        request({
          decision: { ...cfdShort, price: 1.2, atr: 0.4, stop_price: 1.5 },
        }),
      ),
    ).toMatchObject({ order: undefined, refusal: 'target_not_positive' });
    expect(
      gate().approveEntry(request({ decision: { ...cfdShort, price: 3, atr: 1, stop_price: 4 } })),
    ).toMatchObject({ order: undefined, refusal: 'target_not_positive' });
  });

  it('brackets at the decision target when one is given, else the ATR multiple', () => {
    const atrTarget = gate().approveEntry(request()).order;
    expect(atrTarget).toMatchObject({ stop: 19.2, target: 21.2 });
    const given = gate().approveEntry(request({ decision: { ...decision, target_price: 23.5 } }));
    expect(given.order).toMatchObject({ stop: 19.2, target: 23.5 });
    const shortTarget = gate().approveEntry(
      request({ decision: { ...cfdShort, target_price: 17.5 } }),
    );
    expect(shortTarget.order).toMatchObject({ side: 'sell', target: 17.5 });
  });

  it('refuses a given target at or behind the entry', () => {
    for (const target_price of [20, 19.9]) {
      expect(
        gate().approveEntry(request({ decision: { ...decision, target_price } })),
      ).toMatchObject({ order: undefined, refusal: 'target_wrong_side' });
    }
    for (const target_price of [20, 20.1]) {
      expect(
        gate().approveEntry(request({ decision: { ...cfdShort, target_price } })),
      ).toMatchObject({ order: undefined, refusal: 'target_wrong_side' });
    }
    expect(
      gate().approveEntry(request({ decision: { ...cfdShort, target_price: 0 } })),
    ).toMatchObject({ order: undefined, refusal: 'target_not_positive' });
  });

  it('carries an entry trigger between the stop and the limit onto the approved bracket', () => {
    expect(gate().approveEntry(request()).order).toMatchObject({ entryTrigger: undefined });
    for (const entry_trigger of [19.5, 20]) {
      expect(
        gate().approveEntry(request({ decision: { ...signalLong, entry_trigger } })).order,
      ).toMatchObject({
        kind: 'bracket_entry',
        entry: 20,
        entryTrigger: entry_trigger,
        stop: 19.2,
      });
    }
    expect(
      gate().approveEntry(request({ decision: { ...signalShort, entry_trigger: 20.5 } })).order,
    ).toMatchObject({ side: 'sell', entry: 20, entryTrigger: 20.5 });
    expect(
      gate().approveEntry(request({ decision: { ...signalShort, entry_trigger: 20 } })).order,
    ).toMatchObject({ side: 'sell', entryTrigger: 20 });
  });

  it('refuses an entry trigger beyond the limit or at or past the stop', () => {
    const refusal = (overrides: Partial<SleeveDecision>, base = signalLong) =>
      gate().approveEntry(request({ decision: { ...base, ...overrides } }));
    expect(refusal({ entry_trigger: 20.01 })).toMatchObject({
      order: undefined,
      refusal: 'trigger_beyond_limit',
    });
    for (const entry_trigger of [19.2, 19.1]) {
      expect(refusal({ entry_trigger })).toMatchObject({
        order: undefined,
        refusal: 'trigger_at_or_past_stop',
      });
    }
    expect(refusal({ entry_trigger: 19.99 }, signalShort)).toMatchObject({
      refusal: 'trigger_beyond_limit',
    });
    for (const entry_trigger of [20.8, 20.9]) {
      expect(refusal({ entry_trigger }, signalShort)).toMatchObject({
        refusal: 'trigger_at_or_past_stop',
      });
    }
  });

  it('sizes by the previous mark multiplier and to zero when entries are blocked', () => {
    expect(gate({ state: { sizeMultiplier: 0.5 } }).approveEntry(request()).size).toBe(3);
    const blocked = gate({ state: { sizeMultiplier: 1, entriesBlockedAtNextFill: true } });
    expect(blocked.approveEntry(request())).toEqual({
      size: 0,
      order: undefined,
      refusal: 'zero_size',
    });
  });

  it('refuses non-entry actions, a missing ATR, and a missing stop', () => {
    for (const action of ['skip', 'none'] as const) {
      expect(gate().approveEntry(request({ decision: { ...decision, action } }))).toMatchObject({
        size: 0,
        refusal: 'zero_size',
      });
    }
    expect(
      gate().approveEntry(request({ decision: { ...decision, atr: undefined } })),
    ).toMatchObject({ size: 0, refusal: 'zero_size' });
    expect(
      gate().approveEntry(request({ decision: { ...decision, stop_price: undefined } })),
    ).toEqual({ size: 6, order: undefined, refusal: 'no_stop_price' });
  });

  it('refuses an allocation only to a sleeve whose minimum exceeds the year start capital', () => {
    const spec = { ...SPEC, minimumCapitalGbp: 2_000, capacityGbp: 500 };
    expect(gate().allocationRefusal({ id: 'debate', spec }, '2026-09-25')).toBeUndefined();
    expect(
      gate().allocationRefusal(
        { id: 'trend', spec: { ...spec, minimumCapitalGbp: 2_001 } },
        '2026-09-25',
      ),
    ).toBe(
      "sleeve trend gets £0 of its £2000 share of 2026's £2000 (minimum £2001, capacity £500): no allocation (doc 66 D8)",
    );
    expect(
      gate().allocationRefusal({ id: 'full', spec: { ...spec, capacityGbp: 0 } }, '2026-09-25'),
    ).toBe(
      "sleeve full gets £0 of its £2000 share of 2026's £2000 (minimum £2000, capacity £0): no allocation (doc 66 D8)",
    );
    expect(
      gate({ capital: undefined }).allocationRefusal({ id: 'trend', spec }, '2027-01-04'),
    ).toBeUndefined();
  });

  it('refuses a sleeve whose share of start capital, not the whole of it, is below its minimum', () => {
    const spec = { ...SPEC, capitalShare: 0.3, minimumCapitalGbp: 601 };
    expect(gate({ spec }).allocationRefusal({ id: 'debate', spec }, '2026-09-25')).toBe(
      "sleeve debate gets £0 of its £600 share of 2026's £2000 (minimum £601, capacity £Infinity): no allocation (doc 66 D8)",
    );
    expect(gate({ spec }).approveEntry(request())).toMatchObject({ refusal: 'no_allocation' });
    const covered = { ...spec, minimumCapitalGbp: 600 };
    expect(
      gate({ spec: covered }).allocationRefusal({ id: 'debate', spec: covered }, '2026-09-25'),
    ).toBeUndefined();
  });

  it("steps size against the sleeve's share of the loss cap, not the account's", () => {
    const state = { ytdLossGbp: 150 };
    const whole = gate({ state }).approveEntry(request()).size;
    const halved = gate({ state: { ...state, sizeMultiplier: 0.5 } }).approveEntry(request()).size;
    const shared = gate({ state, spec: { ...SPEC, capitalShare: 0.3 } }).approveEntry(request());
    expect(halved).toBeLessThan(whole);
    expect(shared.size).toBe(halved);
    const halt = gate({ state: { ytdLossGbp: 450 }, spec: { ...SPEC, capitalShare: 0.3 } });
    expect(halt.approveEntry(request())).toMatchObject({ size: 0, refusal: 'zero_size' });
  });

  it('refuses an entry for a sleeve with no allocation before sizing it', () => {
    const starved = gate({ spec: { ...SPEC, minimumCapitalGbp: 2_001 } });
    expect(starved.approveEntry(request())).toEqual({
      size: 0,
      order: undefined,
      refusal: 'no_allocation',
    });
  });

  it('caps size at the declared share of average daily notional and refuses without covered volume', () => {
    const thin = gate({ bars: liquidBars(20, 300) });
    expect(thin.approveEntry(request()).size).toBe(2);
    expect(thin.approveEntry(request({ decision: signalLong })).size).toBe(3);
    expect(gate({ bars: liquidBars(20, 0) }).approveEntry(request())).toMatchObject({
      size: 0,
      refusal: 'zero_size',
    });
    for (const bars of [
      liquidBars(19),
      liquidBars(20, 1_000_000, '2026-09-19'),
      [...liquidBars(1, 1_000_000, '2026-08-01'), ...liquidBars(19)],
    ]) {
      expect(gate({ bars }).approveEntry(request())).toEqual({
        size: 0,
        order: undefined,
        refusal: 'no_adv',
      });
    }
    expect(
      gate({ bars: liquidBars(20, 1_000_000, '2026-09-20') }).approveEntry(request()).size,
    ).toBe(6);
  });

  it('refuses every entry without a capital config in force but still approves exits', () => {
    const noCapital = gate({ capital: undefined });
    expect(noCapital.capitalRefusal('2027-01-04')).toBe(
      'no capital config in force on 2027-01-04: entries refused until David sets the year (doc 66 D8)',
    );
    expect(gate().capitalRefusal('2026-09-25')).toBeUndefined();
    expect(noCapital.approveEntry(request())).toMatchObject({ size: 0, order: undefined });
    const held: Position = {
      instrument: 'AAPL',
      venue: 'alpaca',
      qty: -4,
      avgPriceGbp: 16,
      stopGbp: undefined,
      targetGbp: undefined,
      clientOrderId: 'c0',
      exitClientOrderId: undefined,
      openedDate: '2026-09-01',
      marksHeld: 10,
      stray: false,
      splitFactor: 1,
      splitAnchorDate: undefined,
    };
    const exit = noCapital.approveExit({ book: shadow, held, clientOrderId: 'x1' });
    expect(exit).toEqual({
      kind: 'flatten',
      approvalId: 'exit:x1:4',
      clientOrderId: 'x1',
      bookId: 'debate/no-macro-gate',
      bookVariant: 'no-macro-gate',
      venue: 'alpaca',
      instrument: 'AAPL',
      side: 'buy',
      size: 4,
      entryClientOrderId: 'c0',
      rearmStop: undefined,
      rearmTarget: undefined,
    });
    expect(isRiskApproved(exit)).toBe(true);
    const halted = gate({ state: { halted: true, sizeMultiplier: 0 } });
    expect(
      halted.approveExit({ book: primary, held: { ...held, qty: 4 }, clientOrderId: 'x2' }),
    ).toMatchObject({ side: 'sell', size: 4 });
    expect(() =>
      gate().approveExit({ book: primary, held: { ...held, qty: 0 }, clientOrderId: 'x3' }),
    ).toThrow(/no exit for AAPL at qty 0/);
  });

  it('refuses every entry on a stale year-start fix but still approves exits (#2009)', () => {
    const stale = gate({ fixDate: '2025-12-19' });
    expect(stale.fxRefusal('2026-01-05')).toBe(
      'last BoE XUDLUSS fix on or before 2026-01-01 is 2025-12-19, more than 7 days before it: entries refused (postmortem §2, #2009)',
    );
    expect(gate().fxRefusal('2026-09-25')).toBeUndefined();
    expect(stale.approveEntry(request())).toEqual({
      size: 0,
      order: undefined,
      refusal: 'fx_year_start_stale',
    });
    expect(stale.approveEntry(request({ decision: { ...decision, venue: 'saxo' } }))).toMatchObject(
      { size: 0, refusal: 'fx_year_start_stale' },
    );
    expect(gate({ fixDate: '2025-12-25' }).approveEntry(request()).size).toBe(6);
    for (const action of ['skip', 'exit', 'none'] as const) {
      expect(stale.approveEntry(request({ decision: { ...decision, action } }))).toEqual({
        size: 0,
        order: undefined,
        refusal: 'zero_size',
      });
    }
    expect(stale.approveEntry(request({ decision: cfdShort }))).toMatchObject({
      size: 0,
      refusal: 'fx_year_start_stale',
    });
    const held: Position = {
      instrument: 'AAPL',
      venue: 'alpaca',
      qty: 4,
      avgPriceGbp: 16,
      stopGbp: undefined,
      targetGbp: undefined,
      clientOrderId: 'c0',
      exitClientOrderId: undefined,
      openedDate: '2026-09-01',
      marksHeld: 10,
      stray: false,
      splitFactor: 1,
      splitAnchorDate: undefined,
    };
    expect(stale.approveExit({ book: primary, held, clientOrderId: 'x1' })).toMatchObject({
      kind: 'flatten',
      side: 'sell',
      size: 4,
    });
  });

  it('carries the entry order id and native rearm prices on a flatten, and mints a rearm order', () => {
    const held: Position = {
      instrument: 'AAPL',
      venue: 'alpaca',
      qty: -4,
      avgPriceGbp: 16,
      stopGbp: undefined,
      targetGbp: undefined,
      clientOrderId: 'c0',
      exitClientOrderId: undefined,
      openedDate: '2026-09-01',
      marksHeld: 10,
      stray: false,
      splitFactor: 1,
      splitAnchorDate: undefined,
    };
    const exit = gate().approveExit({
      book: primary,
      held,
      clientOrderId: 'x1',
      rearm: { stop: 21, target: 18 },
    });
    expect(exit).toMatchObject({ entryClientOrderId: 'c0', rearmStop: 21, rearmTarget: 18 });

    const rearm = gate().approveRearm({
      book: primary,
      held,
      clientOrderId: 'r1',
      stop: 21,
      target: 18,
    });
    const longRearm = gate().approveRearm({
      book: primary,
      held: { ...held, qty: 4 },
      clientOrderId: 'r3',
      stop: 19,
      target: 22,
    });
    expect(longRearm).toMatchObject({ kind: 'rearm', side: 'sell', size: 4 });
    expect(rearm).toEqual({
      kind: 'rearm',
      approvalId: 'rearm:r1:4',
      clientOrderId: 'r1',
      bookId: 'debate/primary',
      bookVariant: 'primary',
      venue: 'alpaca',
      instrument: 'AAPL',
      side: 'buy',
      size: 4,
      entryClientOrderId: 'c0',
      stop: 21,
      target: 18,
    });
    expect(isRiskApproved(rearm)).toBe(true);
    expect(() =>
      gate().approveRearm({
        book: primary,
        held: { ...held, qty: 0 },
        clientOrderId: 'r2',
        stop: 1,
        target: 1,
      }),
    ).toThrow(/no rearm for AAPL at qty 0/);
  });

  it('never approves a copy or a look-alike', () => {
    const order = gate().approveEntry(request()).order;
    expect(order).toBeDefined();
    expect(isRiskApproved({ ...order })).toBe(false);
    expect(isRiskApproved({ kind: 'flatten', approvalId: 'exit:x:1' })).toBe(false);
  });
});
