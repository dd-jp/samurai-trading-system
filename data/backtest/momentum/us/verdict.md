# Momentum sub-book verdict: US

Evaluated 2017-01-31 to 2026-09-23 (9.64 years), 8 trials counted (Grid A), MinBTL limit at Sharpe 0.6: 18 (within).

US coverage: 0.3% of member-sessions without a bar, across 40 names; 2% stop within; 0.05 Sharpe delisting haircut applied. Half-spread measured for 503 names, fallback median 1.34 bps for the rest.

Missing: AABA, AGN, AMCR, ANDV, ANSS, APTV, ARNC, ATVI, AVB, BHGE, CTLT, CTXS, CXO, DAY, ETFC, FBHS, FRC, FTI, HES, HOLX, IR, JNPR, MRO, MXIM, NBL, NFX, PXD, RHT, RTN, SIVB, SNDK, STI, TE, TSS, TWTR, UAA, VAR, WCG, WYND, XLNX

## £1000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.293 | |
| minus delisting haircut 0.05 | 0.243 | |
| × 0.6 haircut | 0.146 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.677 | |
| DSR (selected trial #7, N=8) | 0.806 | < 0.95 |
| DSR (walk-forward path) | 0.283 | |
| PBO (CSCV, 16 folds) | 0.476 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 27.3% / 37.1% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £3669 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 7, 7, 6, 8, 8, 6, 8, 7, 8, 8, 6, 7.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.485 | 6.5% | 15.5% | 21.8% | 2257 | 578 | 0 | 0 | 532 | 7 | 0/0/0/252 |
| #6 | 0.569 | 6.9% | 13.3% | 19.2% | 2334 | 769 | 185 | 0 | 514 | 9 | 0/0/0/216 |
| #7 | 0.754 | 11.5% | 16.2% | 27.3% | 3515 | 854 | 0 | 1 | 441 | 16 | 0/0/0/329 |
| #8 | 0.638 | 7.7% | 13.0% | 20.9% | 2520 | 1049 | 268 | 1 | 473 | 14 | 0/0/0/230 |
| benchmark (fractional) | 0.688 | 11.2% | 17.8% | 37.1% | 3430 | 47837 | 0 | 403 | 0 | 3 | 0/0/0/458 |
| benchmark (whole shares) | -0.590 | | | 0.7% | 1222 | 13 | | 6 | 58020 | 0 | |

## £1000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.570 | |
| minus delisting haircut 0.05 | 0.520 | |
| × 0.6 haircut | 0.312 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.677 | |
| DSR (selected trial #6, N=8) | 0.788 | < 0.95 |
| DSR (walk-forward path) | 0.598 | |
| PBO (CSCV, 16 folds) | 0.872 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 39.9% / 37.1% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £2801 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 8, 8, 8, 8, 7, 6, 7, 7, 6, 6, 6, 6.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.626 | 16.1% | 32.0% | 46.1% | 5151 | 1283 | 0 | 0 | 0 | 18 | 0/0/0/567 |
| #6 | 0.731 | 17.0% | 26.1% | 35.7% | 5558 | 1480 | 302 | 0 | 0 | 23 | 0/0/0/546 |
| #7 | 0.682 | 16.7% | 28.8% | 41.2% | 5450 | 1386 | 0 | 78 | 0 | 33 | 0/0/0/601 |
| #8 | 0.517 | 9.9% | 23.7% | 39.4% | 3046 | 1727 | 416 | 79 | 0 | 28 | 0/0/0/454 |
| benchmark (fractional) | 0.688 | 11.2% | 17.8% | 37.1% | 3430 | 47837 | 0 | 403 | 0 | 3 | 0/0/0/458 |
| benchmark (fractional) | 0.688 | | | 37.1% | 3430 | 47837 | | 403 | 0 | 3 | |

## £5000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.499 | |
| minus delisting haircut 0.05 | 0.449 | |
| × 0.6 haircut | 0.270 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.634 | |
| DSR (selected trial #6, N=8) | 0.655 | < 0.95 |
| DSR (walk-forward path) | 0.516 | |
| PBO (CSCV, 16 folds) | 0.993 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 28.4% / 23.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £3997 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 6, 6, 8.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.535 | 10.9% | 25.4% | 47.5% | 16616 | 1054 | 0 | 0 | 83 | 60 | 17/4/201/415 |
| #6 | 0.601 | 11.2% | 21.7% | 25.0% | 17145 | 1352 | 302 | 0 | 82 | 74 | 123/0/0/411 |
| #7 | 0.572 | 11.9% | 25.2% | 45.4% | 18083 | 1315 | 0 | 0 | 80 | 106 | 277/7/0/430 |
| #8 | 0.594 | 10.4% | 20.0% | 28.4% | 15890 | 1639 | 405 | 1 | 60 | 114 | 184/0/0/369 |
| benchmark (fractional) | 0.654 | 8.5% | 13.9% | 23.9% | 13469 | 51893 | 0 | 403 | 0 | 18 | 233/113/0/363 |
| benchmark (whole shares) | 0.563 | | | 1.5% | 6423 | 418 | | 6 | 57325 | 1 | |

## £5000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.465 | |
| minus delisting haircut 0.05 | 0.415 | |
| × 0.6 haircut | 0.249 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.634 | |
| DSR (selected trial #6, N=8) | 0.690 | < 0.95 |
| DSR (walk-forward path) | 0.475 | |
| PBO (CSCV, 16 folds) | 0.944 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 35.7% / 23.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £2801 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 6, 6, 6.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.550 | 12.8% | 30.4% | 52.6% | 19652 | 1219 | 0 | 0 | 0 | 72 | 26/7/201/472 |
| #6 | 0.632 | 13.8% | 25.8% | 35.7% | 21413 | 1515 | 311 | 0 | 0 | 97 | 168/3/0/484 |
| #7 | 0.575 | 13.2% | 28.7% | 47.3% | 20204 | 1437 | 0 | 78 | 0 | 128 | 252/9/0/499 |
| #8 | 0.542 | 10.2% | 22.5% | 32.2% | 15599 | 1719 | 414 | 79 | 0 | 133 | 343/12/0/432 |
| benchmark (fractional) | 0.654 | 8.5% | 13.9% | 23.9% | 13469 | 51893 | 0 | 403 | 0 | 18 | 233/113/0/363 |
| benchmark (fractional) | 0.654 | | | 23.9% | 13469 | 51893 | | 403 | 0 | 18 | |

