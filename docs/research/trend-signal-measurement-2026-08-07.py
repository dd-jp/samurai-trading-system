"""Time-series-momentum measurement over the free-stack history (2026-08-07).

Answers one question: does a trend signal add anything over simply holding the
same diversified basket at the same volatility target?  Everything here is
pre-registered — four literature-standard lookbacks, no search — so the trial
count stays inside MinBTL for the sample.

Data (fetched separately, see the companion report):
  equities  Alpaca /v2/stocks/bars, daily, 2016-01-04 onward
  crypto    Coinbase /products/<p>/candles, daily, BTC 2015-07-20, ETH 2016-05-18

Run:  python3 trend-signal-measurement-2026-08-07.py <data_dir>

No third-party dependencies — the box this ran on had no numpy, and a
dependency-free script is reproducible from the repo without a venv.
"""

import json
import math
import sys
from collections import OrderedDict

# ---------------------------------------------------------------- parameters

# Pre-registered, from the time-series-momentum literature. NOT searched.
LOOKBACKS = [21, 63, 126, 252]  # 1, 3, 6, 12 months of trading days

VOL_WINDOW = 60  # trailing days for realized vol
INSTRUMENT_VOL_TARGET = 0.10  # annualized, per instrument before correlation
PORTFOLIO_VOL_TARGET = 0.10  # annualized, after correlation
GROSS_CAP = 1.0  # cash account: no leverage
EXECUTION_LAG = 1  # signal at close t, traded at close t+1
CRYPTO_COST_BPS = 25.0  # Alpaca crypto taker, per side
EQUITY_COST_BPS_GRID = [2.0, 5.0, 10.0]  # spread per side; commission-free

WIDE = ['SPY', 'IWM', 'EFA', 'EEM', 'TLT', 'IEF', 'GLD', 'DBC', 'VNQ', 'XLE', 'BTC', 'ETH']
CURRENT = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC', 'ETH']
CRYPTO = {'BTC', 'ETH'}

TRADING_DAYS = 252

# ---------------------------------------------------------------- statistics


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_ppf(p):
    """Acklam's rational approximation to the inverse normal CDF."""
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def mean(xs):
    return sum(xs) / len(xs)


def stdev(xs):
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def moments(xs):
    """Sample skew and EXCESS kurtosis, matching the repo's DSR inputs."""
    n, m, s = len(xs), mean(xs), stdev(xs)
    if s == 0:
        return 0.0, 0.0
    skew = sum(((x - m) / s) ** 3 for x in xs) / n
    kurt = sum(((x - m) / s) ** 4 for x in xs) / n - 3.0
    return skew, kurt


def deflated_sharpe(daily_returns, n_trials, trial_sharpes):
    """Bailey / Lopez de Prado DSR. Inputs and output in per-period units."""
    sr = mean(daily_returns) / stdev(daily_returns)
    skew, kurt = moments(daily_returns)
    t = len(daily_returns)
    var_sr = stdev(trial_sharpes) if len(trial_sharpes) > 1 else 0.0
    gamma = 0.5772156649
    e = math.e
    sr_star = var_sr * (
        (1 - gamma) * norm_ppf(1 - 1.0 / n_trials)
        + gamma * norm_ppf(1 - 1.0 / (n_trials * e))
    )
    denom = math.sqrt(max(1e-12, 1 - skew * sr + ((kurt - 1) / 4.0) * sr ** 2))
    return norm_cdf(((sr - sr_star) * math.sqrt(t - 1)) / denom), sr, sr_star


def min_btl(n_trials):
    """Years of daily data needed before the best of N trials is credible."""
    gamma = 0.5772156649
    e = math.e
    expected_max = (1 - gamma) * norm_ppf(1 - 1.0 / n_trials) + \
        gamma * norm_ppf(1 - 1.0 / (n_trials * e))
    return (expected_max ** 2)  # years, for a target annual Sharpe of 1


# ---------------------------------------------------------------- data loading


def load(data_dir):
    prices = {}
    for sym in ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'TLT', 'IEF', 'GLD', 'DBC',
                'VNQ', 'XLE', 'AAPL', 'TSLA']:
        bars = json.load(open(f'{data_dir}/{sym}.json'))['bars'][sym]
        prices[sym] = {b['t'][:10]: b['c'] for b in bars}
    for sym in ['BTC', 'ETH']:
        prices[sym] = json.load(open(f'{data_dir}/cb_{sym}.json'))
    return prices


def build_panel(prices, symbols):
    """Align on the equity trading calendar; every symbol must have a mark."""
    calendar = sorted(prices['SPY'])
    start = max(min(prices[s]) for s in symbols)
    dates, panel = [], []
    last = {}
    for d in calendar:
        if d < start:
            continue
        row = {}
        ok = True
        for s in symbols:
            if d in prices[s]:
                last[s] = prices[s][d]
            if s not in last:
                ok = False
                break
            row[s] = last[s]
        if ok:
            dates.append(d)
            panel.append(row)
    return dates, panel


# ---------------------------------------------------------------- the backtest


def run(dates, panel, symbols, lookback, allow_short, equity_cost_bps,
        always_long=False, vol_target=PORTFOLIO_VOL_TARGET, gross_cap=GROSS_CAP,
        financing_rate=0.0):
    """One arm. `always_long=True` ignores the signal entirely — the control.

    `vol_target`/`gross_cap` are raised for the levered runs so the equity path
    is GENERATED at leverage rather than post-multiplied: compounding is
    non-linear, so scaling a daily return stream does not reproduce the
    drawdown a levered account would actually have experienced.
    `financing_rate` is charged annually on gross exposure above 1.0.
    """
    n = len(dates)
    rets = {s: [0.0] * n for s in symbols}
    for i in range(1, n):
        for s in symbols:
            rets[s][i] = panel[i][s] / panel[i - 1][s] - 1.0

    warmup = max(lookback, VOL_WINDOW) + EXECUTION_LAG + 1
    weights = {s: 0.0 for s in symbols}
    strat, turnover_series, gross_series = [], [], []
    strat_hist = []

    for i in range(warmup, n):
        # Rebalance on the first trading day of each month, acting on data
        # from EXECUTION_LAG days earlier — no same-bar information.
        is_rebalance = dates[i][:7] != dates[i - 1][:7]
        if is_rebalance:
            d = i - EXECUTION_LAG  # decision bar
            new = {}
            for s in symbols:
                window = rets[s][d - VOL_WINDOW + 1:d + 1]
                vol = stdev(window) * math.sqrt(TRADING_DAYS)
                if vol <= 0:
                    new[s] = 0.0
                    continue
                if always_long:
                    sig = 1.0
                else:
                    past = panel[d][s] / panel[d - lookback][s] - 1.0
                    if past > 0:
                        sig = 1.0
                    elif allow_short and s not in CRYPTO:
                        sig = -1.0  # crypto stays long/flat: Alpaca spot only
                    else:
                        sig = 0.0
                new[s] = sig * (INSTRUMENT_VOL_TARGET / vol) / len(symbols)

            # Portfolio-level vol targeting off the strategy's OWN trailing vol.
            scale = 1.0
            if len(strat_hist) >= VOL_WINDOW:
                realized = stdev(strat_hist[-VOL_WINDOW:]) * math.sqrt(TRADING_DAYS)
                if realized > 0:
                    scale = vol_target / realized
            new = {s: w * scale for s, w in new.items()}

            gross = sum(abs(w) for w in new.values())
            if gross > gross_cap:
                new = {s: w * gross_cap / gross for s, w in new.items()}

            traded = sum(abs(new[s] - weights[s]) for s in symbols)
            cost = sum(
                abs(new[s] - weights[s]) *
                (CRYPTO_COST_BPS if s in CRYPTO else equity_cost_bps) / 10_000.0
                for s in symbols
            )
            weights = new
            turnover_series.append(traded)
        else:
            cost = 0.0

        gross_now = sum(abs(w) for w in weights.values())
        financing = max(0.0, gross_now - 1.0) * financing_rate / TRADING_DAYS
        r = sum(weights[s] * rets[s][i] for s in symbols) - cost - financing
        strat.append(r)
        strat_hist.append(r)
        gross_series.append(sum(abs(w) for w in weights.values()))

    return strat, dates[warmup:], turnover_series, gross_series


def metrics(daily, dates):
    ann_ret = mean(daily) * TRADING_DAYS
    ann_vol = stdev(daily) * math.sqrt(TRADING_DAYS)
    sharpe = ann_ret / ann_vol if ann_vol else 0.0
    equity, peak, mdd = 1.0, 1.0, 0.0
    for r in daily:
        equity *= (1 + r)
        peak = max(peak, equity)
        mdd = min(mdd, equity / peak - 1)
    months = OrderedDict()
    for d, r in zip(dates, daily):
        months.setdefault(d[:7], []).append(r)
    monthly = [math.prod(1 + x for x in v) - 1 for v in months.values()]
    years = OrderedDict()
    for d, r in zip(dates, daily):
        years.setdefault(d[:4], []).append(r)
    yearly = OrderedDict((y, math.prod(1 + x for x in v) - 1) for y, v in years.items())
    return {
        'ann_ret': ann_ret, 'ann_vol': ann_vol, 'sharpe': sharpe, 'mdd': mdd,
        'daily_pct': mean(daily) * 100,
        'pos_months': sum(1 for m in monthly if m > 0) / len(monthly),
        'total': math.prod(1 + r for r in daily) - 1,
        'yearly': yearly, 'n': len(daily),
    }


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    prices = load(data_dir)
    results = {}

    for uname, syms in (('wide', WIDE), ('current', CURRENT)):
        dates, panel = build_panel(prices, syms)
        print(f'\n=== universe {uname}: {len(syms)} instruments, '
              f'{len(dates)} bars, {dates[0]} .. {dates[-1]} ===')

        for cost_bps in EQUITY_COST_BPS_GRID:
            # THE CONTROL ARM: identical sizing, vol target, rebalance — no signal.
            ctrl, cd, ct, cg = run(dates, panel, syms, LOOKBACKS[0], False,
                                   cost_bps, always_long=True)
            m = metrics(ctrl, cd)
            results[(uname, 'always-long', 0, cost_bps)] = (m, ctrl)
            print(f'[{cost_bps:>4.1f}bp] always-long (CONTROL)      '
                  f'Sharpe {m["sharpe"]:5.2f}  ret {m["ann_ret"]*100:6.2f}%  '
                  f'vol {m["ann_vol"]*100:5.2f}%  maxDD {m["mdd"]*100:6.1f}%  '
                  f'daily {m["daily_pct"]:.3f}%')

            for lb in LOOKBACKS:
                for allow_short in (False, True):
                    tag = 'long/short' if allow_short else 'long-only '
                    daily, dd, tt, gg = run(dates, panel, syms, lb, allow_short, cost_bps)
                    m = metrics(daily, dd)
                    results[(uname, tag.strip(), lb, cost_bps)] = (m, daily)
                    print(f'[{cost_bps:>4.1f}bp] trend {lb:>3}d {tag}       '
                          f'Sharpe {m["sharpe"]:5.2f}  ret {m["ann_ret"]*100:6.2f}%  '
                          f'vol {m["ann_vol"]*100:5.2f}%  maxDD {m["mdd"]*100:6.1f}%  '
                          f'daily {m["daily_pct"]:.3f}%  gross {mean(gg):.2f}')

    # ---- trial accounting on the pre-registered grid, at the base cost ----
    trials = {k: v for k, v in results.items() if k[2] != 0 and k[3] == EQUITY_COST_BPS_GRID[0]}
    sharpes_daily = [mean(v[1]) / stdev(v[1]) for v in trials.values()]
    best_key = max(trials, key=lambda k: trials[k][0]['sharpe'])
    best_daily = trials[best_key][1]
    n_trials = len(trials)
    dsr, sr, sr_star = deflated_sharpe(best_daily, n_trials, sharpes_daily)

    print(f'\n=== trial accounting ===')
    print(f'configs tested (pre-registered, no search): {n_trials}')
    print(f'best: {best_key[0]} / {best_key[1]} / {best_key[2]}d  '
          f'Sharpe {trials[best_key][0]["sharpe"]:.2f}')
    print(f'daily SR {sr:.4f}  expected-max-under-null SR* {sr_star:.4f}  DSR {dsr:.3f}')
    print(f'MinBTL for {n_trials} trials: {min_btl(n_trials):.1f} years '
          f'(sample: {trials[best_key][0]["n"]/TRADING_DAYS:.1f} years)')

    print(f'\n=== per-year, best config vs control ===')
    ctrl_m = results[(best_key[0], 'always-long', 0, EQUITY_COST_BPS_GRID[0])][0]
    print(f'{"year":<6}{"trend":>9}{"control":>10}')
    for y in trials[best_key][0]['yearly']:
        t = trials[best_key][0]['yearly'][y] * 100
        c = ctrl_m['yearly'].get(y, 0) * 100
        print(f'{y:<6}{t:>8.1f}%{c:>9.1f}%')

    # ---- does the signal survive being split in half? ----
    print(f'\n=== sample-half stability (Sharpe), 2.0bp ===')
    print(f'{"config":<34}{"1st half":>10}{"2nd half":>10}')
    for key in [('wide', 'long-only', 63), ('wide', 'always-long', 0),
                ('current', 'long-only', 21), ('current', 'always-long', 0)]:
        daily = results[(key[0], key[1], key[2], 2.0)][1]
        h = len(daily) // 2
        a, b = daily[:h], daily[h:]
        sa = mean(a) / stdev(a) * math.sqrt(TRADING_DAYS)
        sb = mean(b) / stdev(b) * math.sqrt(TRADING_DAYS)
        label = f'{key[0]}/{key[1]}' + (f'/{key[2]}d' if key[2] else '')
        print(f'{label:<34}{sa:>10.2f}{sb:>10.2f}')

    # ---- is trend distinguishable from the control at all? ----
    # Paired difference on the daily return streams: same bars, same sizing,
    # same vol target. The only difference is the signal.
    print(f'\n=== trend minus control, paired (2.0bp) ===')
    print(f'{"config":<26}{"dSharpe":>9}{"SE":>7}{"t(diff)":>9}{"maxDD tr":>10}{"maxDD ctl":>11}')
    for uni, lb in (('wide', 63), ('current', 21)):
        tr_m, tr = results[(uni, 'long-only', lb, 2.0)]
        ct_m, ct = results[(uni, 'always-long', 0, 2.0)]
        n = min(len(tr), len(ct))
        diff = [a - b for a, b in zip(tr[-n:], ct[-n:])]
        t_stat = mean(diff) / (stdev(diff) / math.sqrt(n))
        years = n / TRADING_DAYS
        se = math.sqrt((1 + 0.5 * tr_m['sharpe'] ** 2) / years)
        print(f'{uni + "/" + str(lb) + "d":<26}'
              f'{tr_m["sharpe"] - ct_m["sharpe"]:>9.2f}{se:>7.2f}{t_stat:>9.2f}'
              f'{tr_m["mdd"]*100:>9.1f}%{ct_m["mdd"]*100:>10.1f}%')

    # ---- what it costs to reach 0.05%/day, PATH GENERATED AT LEVERAGE ----
    # Solve for the vol target that delivers 12.6%/yr by re-running the whole
    # backtest at each candidate, so the drawdown reflects actual levered
    # compounding. Post-multiplying a daily return stream by a constant is the
    # LINEAR approximation and understates what a levered account lived through.
    FINANCING = 0.06  # Reg T-ish, charged on gross above 1.0
    print(f'\n=== 0.05%/day (12.6%/yr): path generated at leverage, '
          f'{FINANCING*100:.0f}% financing on gross>1 ===')
    print(f'{"config":<30}{"volTgt":>8}{"ret":>8}{"vol":>7}{"Sharpe":>8}'
          f'{"maxDD":>9}{"gross":>7}')
    for uni, arm, lb in [('wide', 'long-only', 63), ('wide', 'always-long', 0),
                         ('current', 'long-only', 21), ('current', 'always-long', 0)]:
        syms = WIDE if uni == 'wide' else CURRENT
        dts, pnl = build_panel(prices, syms)
        best = None
        for vt in [x / 100.0 for x in range(8, 251, 2)]:
            daily, dd, tt, gg = run(dts, pnl, syms, lb or LOOKBACKS[0], False, 2.0,
                                    always_long=(arm == 'always-long'),
                                    vol_target=vt, gross_cap=4.0,
                                    financing_rate=FINANCING)
            m = metrics(daily, dd)
            if best is None or abs(m['ann_ret'] - 0.126) < abs(best[1]['ann_ret'] - 0.126):
                best = (vt, m, mean(gg))
        vt, m, gross = best
        label = f'{uni}/{arm}' + (f'/{lb}d' if lb else '')
        print(f'{label:<30}{vt*100:>7.0f}%{m["ann_ret"]*100:>7.1f}%'
              f'{m["ann_vol"]*100:>6.1f}%{m["sharpe"]:>8.2f}'
              f'{m["mdd"]*100:>8.1f}%{gross:>7.2f}')


if __name__ == '__main__':
    main()
