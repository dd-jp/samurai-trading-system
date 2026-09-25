# Momentum sub-book verdict: LSE

Evaluated 2017-06-30 to 2026-09-25 (9.24 years), 8 trials counted (Grid A), MinBTL limit at Sharpe 0.6: 16 (within).

LSE window from 2016-06-21 (binding line IITU); 22 lines, each with a measured half spread (p25 of the burst half spreads, bps of mid (median alongside); Saxo GET /trade/v1/infoprices/list, FieldGroups=Quote, one burst of 5 reads spaced 2 s at a single time point (delayed 15 min), measured once; raw in data/bars/saxo-spreads.csv); custody 0.12%/yr accrued daily; no delisting haircut and no coverage stop (ruling (h)).

LSE coverage: 1.5% of line-sessions without a Saxo bar inside the window, on ICDU, IESU, IITU, SGLN, SPOG, SSLN, UIFS, VUTY.

Spliced lines: none.

Excluded from the run: IHCU — GBX line starts 2021-10-21 (under ten years); sibling splice exceeds the pre-declared tolerance (mean abs return diff 15.00 bps/day > 1) — STOP for David; CMFP — GBX line starts 2019-02-20 (under ten years); sibling splice exceeds the pre-declared tolerance (mean abs return diff 16.39 bps/day > 1) — STOP for David.

## £1000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.548 | |
| minus delisting haircut 0.00 | 0.548 | |
| × 0.6 haircut | 0.329 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.571 | |
| DSR (selected trial #1, N=8) | 0.647 | < 0.95 |
| DSR (walk-forward path) | 0.561 | |
| PBO (CSCV, 16 folds) | 0.050 | <= 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 12.4% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £8052 | |

Walk-forward window 2018-01-26 to 2026-09-25; trial selected per fold: 1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.605 | 4.3% | 7.4% | 12.4% | 1479 | 912 | 0 | 1 | 260 | 65 | 0/0/0/83 |
| #2 | 0.494 | 3.0% | 6.4% | 11.4% | 1317 | 1164 | 253 | 1 | 268 | 83 | 0/0/0/49 |
| #3 | 0.223 | 1.5% | 8.1% | 19.7% | 1147 | 1032 | 0 | 3 | 271 | 80 | 0/0/0/77 |
| #4 | 0.126 | 0.6% | 6.5% | 16.0% | 1058 | 1331 | 324 | 3 | 281 | 100 | 0/0/0/48 |
| benchmark (fractional) | 0.594 | 5.1% | 9.1% | 20.9% | 1586 | 2272 | 0 | 1 | 0 | 30 | 0/0/0/128 |
| benchmark (whole shares) | 0.585 | | | 12.7% | 1338 | 608 | | 1 | 487 | 21 | |

## £1000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.356 | |
| minus delisting haircut 0.00 | 0.356 | |
| × 0.6 haircut | 0.214 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.571 | |
| DSR (selected trial #1, N=8) | 0.510 | < 0.95 |
| DSR (walk-forward path) | 0.342 | |
| PBO (CSCV, 16 folds) | 0.264 | > 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 22.6% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £5288 | |

Walk-forward window 2018-01-26 to 2026-09-25; trial selected per fold: 1, 1, 3, 1, 2, 4, 4, 4, 4, 4, 1, 1, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.488 | 4.6% | 10.4% | 18.9% | 1521 | 1589 | 0 | 1 | 0 | 80 | 0/0/0/170 |
| #2 | 0.430 | 3.4% | 8.7% | 18.1% | 1364 | 1835 | 299 | 1 | 0 | 107 | 0/0/0/119 |
| #3 | 0.258 | 2.2% | 10.7% | 24.6% | 1225 | 1652 | 0 | 3 | 0 | 106 | 0/0/0/155 |
| #4 | 0.248 | 1.8% | 8.6% | 20.9% | 1177 | 1907 | 355 | 3 | 0 | 139 | 0/0/0/107 |
| benchmark (fractional) | 0.594 | 5.1% | 9.1% | 20.9% | 1586 | 2272 | 0 | 1 | 0 | 30 | 0/0/0/128 |
| benchmark (fractional) | 0.594 | | | 20.9% | 1586 | 2272 | | 1 | 0 | 30 | |

## £5000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.288 | |
| minus delisting haircut 0.00 | 0.288 | |
| × 0.6 haircut | 0.173 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.462 | |
| DSR (selected trial #1, N=8) | 0.522 | < 0.95 |
| DSR (walk-forward path) | 0.273 | |
| PBO (CSCV, 16 folds) | 0.188 | > 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 21.5% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £5748 | |

Walk-forward window 2018-01-26 to 2026-09-25; trial selected per fold: 1, 1, 3, 1, 2, 2, 4, 4, 4, 4, 1, 1, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.498 | 4.3% | 9.4% | 17.4% | 7412 | 1338 | 0 | 1 | 49 | 374 | 42/0/0/132 |
| #2 | 0.440 | 3.1% | 7.6% | 17.9% | 6640 | 1588 | 288 | 1 | 53 | 471 | 131/0/0/75 |
| #3 | 0.131 | 0.8% | 9.6% | 22.9% | 5380 | 1437 | 0 | 3 | 64 | 459 | 170/0/0/106 |
| #4 | 0.235 | 1.5% | 7.9% | 20.7% | 5764 | 1721 | 353 | 3 | 58 | 648 | 54/0/0/87 |
| benchmark (fractional) | 0.492 | 3.9% | 8.6% | 20.9% | 7150 | 2303 | 0 | 1 | 0 | 154 | 157/1/0/95 |
| benchmark (whole shares) | 0.460 | | | 18.8% | 6735 | 1454 | | 1 | 143 | 145 | |

## £5000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.210 | |
| minus delisting haircut 0.00 | 0.210 | |
| × 0.6 haircut | 0.126 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.462 | |
| DSR (selected trial #1, N=8) | 0.449 | < 0.95 |
| DSR (walk-forward path) | 0.202 | |
| PBO (CSCV, 16 folds) | 0.301 | > 0.10 |
| Coverage stop | 1.5% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 23.3% / 20.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £5175 | |

Walk-forward window 2018-01-26 to 2026-09-25; trial selected per fold: 1, 1, 3, 1, 2, 4, 4, 4, 4, 4, 4, 2, 1, 1, 1.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 0.437 | 4.0% | 10.3% | 19.3% | 7208 | 1605 | 0 | 1 | 0 | 389 | 81/0/0/155 |
| #2 | 0.405 | 3.1% | 8.3% | 19.6% | 6613 | 1836 | 299 | 1 | 0 | 501 | 168/0/0/106 |
| #3 | 0.154 | 1.1% | 10.4% | 24.6% | 5512 | 1665 | 0 | 3 | 0 | 481 | 216/1/0/129 |
| #4 | 0.248 | 1.7% | 8.1% | 21.4% | 5848 | 1908 | 355 | 3 | 0 | 651 | 151/0/0/92 |
| benchmark (fractional) | 0.492 | 3.9% | 8.6% | 20.9% | 7150 | 2303 | 0 | 1 | 0 | 154 | 157/1/0/95 |
| benchmark (fractional) | 0.492 | | | 20.9% | 7150 | 2303 | | 1 | 0 | 154 | |

