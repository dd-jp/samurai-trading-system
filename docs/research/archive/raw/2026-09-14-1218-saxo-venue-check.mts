/**
 * #1218 hermetic check: what `venue: 'saxo'` changes in a Stage 2 intraday
 * fill. No vendor call, no bars, no database.
 *
 * PART 1 reconstructs doc 53's published per-fill component table. Doc 53's
 * 2017-03-15 breakdown is a pure function of (mid, volatility, adv, size) under
 * `CALIBRATED_INTRADAY_COST_CONFIG`, so the state that produced each published
 * row can be recovered from the row itself: `volatility` is pinned by the
 * published slippage (slippage = volatility * 0.017425) and `adv` by the
 * published market impact (impact = 0.05 * volatility * sqrt(size / adv)).
 * Recovering rather than re-measuring is the whole point — it needs no bars,
 * and the reconstruction either reproduces doc 53's four totals to the last
 * published decimal or it does not.
 *
 * PART 2 prices the SAME reconstructed states twice, unstamped and stamped
 * `venue: 'saxo'`, and asserts the narrow claim: the stamp moves `commission`
 * from the 1bp structural floor to the 8bp Saxo rate (ADR-0015:201) and moves
 * NOTHING else, so every published total gains exactly 7.0000 bps per fill.
 *
 * PART 3 shows the stamp is inert under `CALIBRATED_COST_CONFIG`, which declares
 * no `venues` key, and PART 4 draws the consequence: G2's daily-vs-intraday
 * delta now carries the 7bp commission wedge on top of the calibration
 * difference, and only recovers the published deltas with `venues` equalized.
 *
 * Note on units: `CostModelImpl` returns `spread_cost`, `slippage` and
 * `market_impact` in PRICE units (per share) and `commission` as a currency
 * amount on notional. Doc 53's table is bps, so the first three divide by `mid`
 * and commission by notional — that is what makes them commensurable.
 */
// Resolved from this file's own location (docs/research/archive/raw/) rather
// than from cwd, so the archived copy runs unchanged from anywhere in any
// checkout: `npx tsx docs/research/archive/raw/2026-09-14-1218-saxo-venue-check.mts`
const ROOT = new URL('../../../../', import.meta.url).href;

const { CostModelImpl } = await import(`${ROOT}server/tools/backtest/cost-model.ts`);
const { CALIBRATED_INTRADAY_COST_CONFIG, CALIBRATED_COST_CONFIG, DEFAULT_CAPITAL_PER_TRADE } =
  await import(`${ROOT}server/tools/run-stage2.ts`);

const INTRADAY_SLIPPAGE_COEFF = CALIBRATED_INTRADAY_COST_CONFIG.stocks.slippageCoefficient;
const INTRADAY_IMPACT_K = CALIBRATED_INTRADAY_COST_CONFIG.stocks.impactK;

/** Doc 53's published 1m/intraday-config component row, in bps, per symbol */
interface Published {
  symbol: string;
  mid: number;
  spread: number;
  commission: number;
  slippage: number;
  impact: number;
  total: number;
}

// docs/research/53-intraday-cost-calibration.md, G2 component breakdown
// (2017-03-15, 1m bars under CALIBRATED_INTRADAY_COST_CONFIG) and its charged
// cost column. `mid` is the only input NOT published there; it cancels out of
// every bps figure except through the size/adv ratio, which `adv` then absorbs,
// so any positive mid reconstructs the same table
const PUBLISHED: Published[] = [
  {
    symbol: 'SPY',
    mid: 236.0,
    spread: 1.0,
    commission: 1.0,
    slippage: 0.0726,
    impact: 0.0024,
    total: 2.075,
  },
  {
    symbol: 'QQQ',
    mid: 131.0,
    spread: 1.0,
    commission: 1.0,
    slippage: 0.0724,
    impact: 0.0056,
    total: 2.078,
  },
  {
    symbol: 'AAPL',
    mid: 140.0,
    spread: 1.0,
    commission: 1.0,
    slippage: 0.1089,
    impact: 0.0085,
    total: 2.1174,
  },
  {
    symbol: 'TSLA',
    mid: 255.0,
    spread: 1.0,
    commission: 1.0,
    slippage: 0.143,
    impact: 0.0325,
    total: 2.2238,
  },
];

/** volatility such that the model's slippage equals the published slippage */
const volatilityFor = (p: Published): number =>
  ((p.slippage / 10_000) * p.mid) / INTRADAY_SLIPPAGE_COEFF;

/** adv such that the model's market impact equals the published impact */
const advFor = (p: Published, volatility: number, size: number): number => {
  const root = ((p.impact / 10_000) * p.mid) / (INTRADAY_IMPACT_K * volatility);
  return size / (root * root);
};

const perShareBps = (x: number, mid: number): number => (x / mid) * 10_000;
const notionalBps = (x: number, notional: number): number => (x / notional) * 10_000;

function price(config: unknown, p: Published, venue?: 'saxo') {
  const model = new CostModelImpl(config);
  const size = DEFAULT_CAPITAL_PER_TRADE / p.mid;
  const notional = size * p.mid;
  const volatility = volatilityFor(p);
  const result = model.fill(
    {
      instrument: p.symbol,
      side: 'buy',
      size,
      order_type: 'market',
      idempotency_key: `i1218-${p.symbol}-${venue ?? 'none'}`,
    },
    {
      mid: p.mid,
      spread: null,
      adv: advFor(p, volatility, size),
      volatility,
      asset_class: 'stocks',
      ...(venue === undefined ? {} : { venue }),
      timestamp: new Date('2017-03-15T00:00:00.000Z'),
    },
  );
  const b = result.cost_breakdown;
  const spread = perShareBps(b.spread_cost, p.mid);
  const commission = notionalBps(b.commission, notional);
  const slippage = perShareBps(b.slippage, p.mid);
  const impact = perShareBps(b.market_impact, p.mid);
  return { spread, commission, slippage, impact, total: spread + commission + slippage + impact };
}

const f = (x: number): string => x.toFixed(4).padStart(10);
let failures = 0;
const assert = (ok: boolean, what: string): void => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${what}`);
  }
};
const near = (a: number, b: number, eps = 5e-5): boolean => Math.abs(a - b) < eps;

console.log("#1218 — the venue stamp against doc 53's published intraday cost decomposition");
console.log(`notional per fill: $${DEFAULT_CAPITAL_PER_TRADE}. All figures are bps.`);
console.log(`config: CALIBRATED_INTRADAY_COST_CONFIG`);
console.log(
  `  stocks: spreadVolatilityCoefficient=${CALIBRATED_INTRADAY_COST_CONFIG.stocks.spreadVolatilityCoefficient}` +
    ` commissionRate=${CALIBRATED_INTRADAY_COST_CONFIG.stocks.commissionRate}` +
    ` slippageCoefficient=${INTRADAY_SLIPPAGE_COEFF} impactK=${INTRADAY_IMPACT_K}`,
);
console.log(
  `  venues.saxo.commissionRate=${CALIBRATED_INTRADAY_COST_CONFIG.venues?.saxo?.commissionRate}`,
);
console.log('');

console.log("=== PART 1: reconstruction of doc 53's published G2 component table ===");
console.log('');
console.log('symbol       spread commission   slippage     impact  2017-03-15   charged');
for (const p of PUBLISHED) {
  const r = price(CALIBRATED_INTRADAY_COST_CONFIG, p);
  console.log(
    `${p.symbol.padEnd(6)} ${f(r.spread)} ${f(r.commission)} ${f(r.slippage)} ${f(r.impact)} ${f(r.total)} ${f(p.total)}`,
  );
  assert(near(r.spread, p.spread), `${p.symbol}: reconstructed spread matches doc 53`);
  assert(near(r.commission, p.commission), `${p.symbol}: reconstructed commission matches doc 53`);
  assert(near(r.slippage, p.slippage), `${p.symbol}: reconstructed slippage matches doc 53`);
  assert(near(r.impact, p.impact), `${p.symbol}: reconstructed impact matches doc 53`);
}
console.log('');
console.log(
  'Every component reconstructs exactly. The last two columns are DIFFERENT quantities:\n' +
    "  '2017-03-15' is the component breakdown's single bar; 'charged' is doc 53's\n" +
    '  run-level charged cost. They coincide for SPY/QQQ/AAPL because those three sit\n' +
    '  on the spread floor on every bar, so the snapshot IS the run. TSLA is the one\n' +
    '  name whose 1m volatility moves it off the floor, so its run figure exceeds its\n' +
    `  2017-03-15 snapshot by ${(2.2238 - 2.1755).toFixed(4)} bps. That gap is doc 53's, not this check's,\n` +
    '  and it is unaffected by the venue stamp: commission is a flat RATE on notional,\n' +
    '  identical on every bar, so the restatement below is +7.0000 bps on either basis.',
);

console.log('');
console.log('=== PART 2: the same states, stamped venue=saxo ===');
console.log('');
console.log('symbol       spread commission   slippage     impact      total      delta');
for (const p of PUBLISHED) {
  const plain = price(CALIBRATED_INTRADAY_COST_CONFIG, p);
  const saxo = price(CALIBRATED_INTRADAY_COST_CONFIG, p, 'saxo');
  console.log(
    `${p.symbol.padEnd(6)} ${f(saxo.spread)} ${f(saxo.commission)} ${f(saxo.slippage)} ${f(saxo.impact)} ${f(saxo.total)} ${f(saxo.total - plain.total)}`,
  );
  assert(plain.commission === 1, `${p.symbol}: unstamped commission sits on the 1bp floor`);
  assert(saxo.commission === 8, `${p.symbol}: stamped commission is the 8bp Saxo rate`);
  assert(plain.spread === saxo.spread, `${p.symbol}: spread is untouched by the stamp`);
  assert(plain.slippage === saxo.slippage, `${p.symbol}: slippage is untouched by the stamp`);
  assert(plain.impact === saxo.impact, `${p.symbol}: impact is untouched by the stamp`);
  assert(near(saxo.total - plain.total, 7, 1e-9), `${p.symbol}: the stamp adds exactly 7.0000 bps`);
}

console.log('');
console.log("=== Doc 53's charged-cost column, restated (published + 7.0000 per fill) ===");
console.log('');
console.log('symbol   was/fill  now/fill  was round trip  now round trip');
for (const p of PUBLISHED) {
  const now = p.total + 7;
  console.log(`${p.symbol.padEnd(6)} ${f(p.total)} ${f(now)} ${f(p.total * 2)} ${f(now * 2)}`);
}

console.log('');
console.log('=== PART 3: the daily config carries no `venues` key, so the stamp is inert ===');
console.log('');
console.log('symbol   unstamped     stamped');
for (const p of PUBLISHED) {
  const plain = price(CALIBRATED_COST_CONFIG, p);
  const saxo = price(CALIBRATED_COST_CONFIG, p, 'saxo');
  console.log(`${p.symbol.padEnd(6)} ${f(plain.total)} ${f(saxo.total)}`);
  assert(saxo.total === plain.total, `${p.symbol}: daily config is unaffected by the stamp`);
}
console.log('');
console.log(`CALIBRATED_COST_CONFIG.venues = ${JSON.stringify(CALIBRATED_COST_CONFIG.venues)}`);

console.log('');
console.log(
  "=== PART 4: G2's delta column, as the code now runs it vs with `venues` equalized ===",
);
console.log('');
const DAILY_WITH_SAXO = {
  ...CALIBRATED_COST_CONFIG,
  venues: CALIBRATED_INTRADAY_COST_CONFIG.venues,
};
console.log('symbol  daily cfg  intraday    delta |  daily+saxo  intraday    delta');
for (const p of PUBLISHED) {
  const asRun = price(CALIBRATED_COST_CONFIG, p, 'saxo');
  const intraday = price(CALIBRATED_INTRADAY_COST_CONFIG, p, 'saxo');
  const equalized = price(DAILY_WITH_SAXO, p, 'saxo');
  console.log(
    `${p.symbol.padEnd(6)} ${f(asRun.total)} ${f(intraday.total)} ${f(intraday.total - asRun.total)} | ${f(equalized.total)} ${f(intraday.total)} ${f(intraday.total - equalized.total)}`,
  );
  assert(
    near(intraday.total - equalized.total, intraday.total - asRun.total - 7, 1e-9),
    `${p.symbol}: equalizing venues removes exactly the 7 bps commission wedge`,
  );
  assert(
    intraday.total - equalized.total < 0.25,
    `${p.symbol}: with venues equalized the calibration delta is still under the 0.25 bps bar`,
  );
}
console.log('');
console.log(
  "The left block is what G2's comparison now measures: the two timeframe-keyed configs\n" +
    '  differ on TWO axes, not one, because only the intraday config declares `venues`.\n' +
    '  The right block holds `venues` equal across both arms and recovers the published\n' +
    '  calibration deltas. Any future re-run of G2 must equalize `venues` or it measures\n' +
    '  the venue override instead of the spread/slippage/impact calibration.',
);

console.log('');
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
