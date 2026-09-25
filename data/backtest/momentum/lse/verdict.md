# Momentum sub-book verdict: LSE

Evaluated 2017-06-30 to 2026-09-24 (9.23 years), 8 trials counted (Grid A), MinBTL limit at Sharpe 0.6: 16 (within).

LSE window from 2016-06-21 (binding line IITU); 22 lines, each with a measured half spread (p25 of the burst half spreads, bps of mid (median alongside); Saxo GET /trade/v1/infoprices/list, FieldGroups=Quote, one burst of 5 reads spaced 2 s at a single time point (delayed 15 min), measured once; raw in data/bars/saxo-spreads.csv); custody 0.12%/yr accrued daily; no delisting haircut and no coverage stop (ruling (h)).

LSE coverage: 1.5% of line-sessions without a Saxo bar inside the window, on ICDU, IESU, IITU, SGLN, SPOG, SSLN, UIFS, VUTY.

Spliced lines: none.

Excluded from the run: IHCU — GBX line starts 2021-10-21 (under ten years); sibling splice exceeds the pre-declared tolerance (mean abs return diff 15.00 bps/day > 1) — STOP for David; CMFP — GBX line starts 2019-02-20 (under ten years); sibling splice exceeds the pre-declared tolerance (mean abs return diff 16.39 bps/day > 1) — STOP for David.

## £1000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.537 | |
| minus delisting haircut 0.00 | 0.537 | |
| × 0.6 haircut | 0.322 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.565 | |
| DSR (selected trial #1, N=8) | 0.636 | < 0.95 |
| DSR (walk-forward path) | 0.549 | |
| PBO (CSCV, 16 folds) | 0.044 | <= 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 12.7% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £7898 | |

Walk-forward window 2018-01-26 to 2026-09-24; trial selected per fold: 1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.595 | 4.3% | 7.5% | 12.7% | 1473 | 915 | 0 | 1 | 257 | 66 | 0/0/0/85 |
| #2 | 0.489 | 3.0% | 6.5% | 11.4% | 1314 | 1164 | 254 | 1 | 265 | 84 | 0/0/0/50 |
| #3 | 0.221 | 1.5% | 8.1% | 19.7% | 1145 | 1036 | 0 | 3 | 268 | 80 | 0/0/0/77 |
| #4 | 0.132 | 0.7% | 6.5% | 16.1% | 1062 | 1341 | 324 | 3 | 276 | 101 | 0/0/0/48 |
| benchmark (fractional) | 0.588 | 5.0% | 9.1% | 20.9% | 1578 | 2274 | 0 | 1 | 0 | 30 | 0/0/0/128 |
| benchmark (whole shares) | 0.570 | | | 12.7% | 1328 | 600 | | 1 | 485 | 21 | |

## £1000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.414 | |
| minus delisting haircut 0.00 | 0.414 | |
| × 0.6 haircut | 0.248 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.565 | |
| DSR (selected trial #1, N=8) | 0.509 | < 0.95 |
| DSR (walk-forward path) | 0.407 | |
| PBO (CSCV, 16 folds) | 0.245 | > 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 20.9% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £5288 | |

Walk-forward window 2018-01-26 to 2026-09-24; trial selected per fold: 1, 1, 1, 1, 2, 4, 4, 4, 4, 4, 1, 1, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.487 | 4.6% | 10.4% | 18.9% | 1522 | 1585 | 0 | 1 | 0 | 82 | 0/0/0/176 |
| #2 | 0.429 | 3.4% | 8.7% | 18.1% | 1364 | 1832 | 299 | 1 | 0 | 109 | 0/0/0/124 |
| #3 | 0.255 | 2.2% | 10.7% | 24.5% | 1221 | 1652 | 0 | 3 | 0 | 106 | 0/0/0/157 |
| #4 | 0.245 | 1.7% | 8.6% | 20.9% | 1174 | 1908 | 357 | 3 | 0 | 139 | 0/0/0/108 |
| benchmark (fractional) | 0.588 | 5.0% | 9.1% | 20.9% | 1578 | 2274 | 0 | 1 | 0 | 30 | 0/0/0/128 |
| benchmark (fractional) | 0.588 | | | 20.9% | 1578 | 2274 | | 1 | 0 | 30 | |

## £5000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.293 | |
| minus delisting haircut 0.00 | 0.293 | |
| × 0.6 haircut | 0.176 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.455 | |
| DSR (selected trial #1, N=8) | 0.519 | < 0.95 |
| DSR (walk-forward path) | 0.277 | |
| PBO (CSCV, 16 folds) | 0.222 | > 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 21.9% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £5555 | |

Walk-forward window 2018-01-26 to 2026-09-24; trial selected per fold: 1, 1, 3, 1, 2, 2, 4, 4, 4, 4, 1, 1, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.495 | 4.3% | 9.5% | 18.0% | 7414 | 1336 | 0 | 1 | 45 | 383 | 40/0/0/138 |
| #2 | 0.437 | 3.1% | 7.7% | 17.9% | 6641 | 1587 | 289 | 1 | 50 | 481 | 129/0/0/81 |
| #3 | 0.133 | 0.8% | 9.5% | 22.9% | 5389 | 1430 | 0 | 3 | 62 | 456 | 176/0/0/106 |
| #4 | 0.236 | 1.6% | 7.9% | 20.6% | 5767 | 1731 | 353 | 3 | 55 | 651 | 55/0/0/87 |
| benchmark (fractional) | 0.485 | 3.9% | 8.6% | 20.9% | 7112 | 2304 | 0 | 1 | 0 | 153 | 157/1/0/95 |
| benchmark (whole shares) | 0.455 | | | 18.8% | 6708 | 1460 | | 1 | 140 | 144 | |

## £5000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.273 | |
| minus delisting haircut 0.00 | 0.273 | |
| × 0.6 haircut | 0.164 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.455 | |
| DSR (selected trial #1, N=8) | 0.447 | < 0.95 |
| DSR (walk-forward path) | 0.259 | |
| PBO (CSCV, 16 folds) | 0.255 | > 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 21.5% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £5108 | |

Walk-forward window 2018-01-26 to 2026-09-24; trial selected per fold: 1, 1, 1, 1, 2, 4, 4, 4, 4, 4, 4, 2, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.436 | 4.0% | 10.3% | 19.6% | 7213 | 1600 | 0 | 1 | 0 | 399 | 80/0/0/161 |
| #2 | 0.403 | 3.1% | 8.4% | 19.6% | 6614 | 1832 | 299 | 1 | 0 | 511 | 165/0/0/109 |
| #3 | 0.147 | 1.0% | 10.3% | 25.3% | 5472 | 1675 | 0 | 3 | 0 | 470 | 225/0/0/123 |
| #4 | 0.245 | 1.7% | 8.1% | 21.4% | 5832 | 1909 | 357 | 3 | 0 | 655 | 152/0/0/92 |
| benchmark (fractional) | 0.485 | 3.9% | 8.6% | 20.9% | 7112 | 2304 | 0 | 1 | 0 | 153 | 157/1/0/95 |
| benchmark (fractional) | 0.485 | | | 20.9% | 7112 | 2304 | | 1 | 0 | 153 | |

