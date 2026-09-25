# Momentum sub-book verdict: US

Evaluated 2017-01-31 to 2026-09-23 (9.64 years), 8 trials counted (Grid A), MinBTL limit at Sharpe 0.6: 18 (within).

US coverage: 0.3% of member-sessions without a bar, across 40 names; 2% stop within; 0.05 Sharpe delisting haircut applied. Half-spread measured for 503 names, fallback median 1.34 bps for the rest.

Missing: AABA, AGN, AMCR, ANDV, ANSS, APTV, ARNC, ATVI, AVB, BHGE, CTLT, CTXS, CXO, DAY, ETFC, FBHS, FRC, FTI, HES, HOLX, IR, JNPR, MRO, MXIM, NBL, NFX, PXD, RHT, RTN, SIVB, SNDK, STI, TE, TSS, TWTR, UAA, VAR, WCG, WYND, XLNX

## £1000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.856 | |
| minus delisting haircut 0.05 | 0.806 | |
| × 0.6 haircut | 0.483 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.679 | |
| DSR (selected trial #7, N=8) | 0.883 | < 0.95 |
| DSR (walk-forward path) | 0.865 | |
| PBO (CSCV, 16 folds) | 0.255 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 21.7% / 37.1% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £4609 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.485 | 6.5% | 15.5% | 21.8% | 2257 | 578 | 0 | 0 | 532 | 7 | 0/0/0/252 |
| #6 | 0.573 | 6.9% | 13.2% | 19.0% | 2342 | 767 | 184 | 0 | 515 | 9 | 0/0/0/216 |
| #7 | 0.857 | 14.3% | 17.4% | 21.7% | 4463 | 897 | 0 | 1 | 402 | 18 | 0/0/0/368 |
| #8 | 0.586 | 6.7% | 12.3% | 20.1% | 2288 | 1017 | 262 | 1 | 486 | 13 | 0/0/0/209 |
| benchmark (fractional) | 0.690 | 11.3% | 17.8% | 37.1% | 3442 | 47855 | 0 | 0 | 0 | 3 | 0/0/0/460 |
| benchmark (whole shares) | -0.590 | | | 0.7% | 1222 | 13 | | 6 | 58020 | 0 | |

## £1000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.601 | |
| minus delisting haircut 0.05 | 0.551 | |
| × 0.6 haircut | 0.330 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.679 | |
| DSR (selected trial #7, N=8) | 0.801 | < 0.95 |
| DSR (walk-forward path) | 0.634 | |
| PBO (CSCV, 16 folds) | 0.771 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 34.2% / 37.1% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £2888 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 7, 7, 6, 6, 7.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.626 | 16.1% | 32.0% | 46.1% | 5151 | 1283 | 0 | 0 | 0 | 18 | 0/0/0/567 |
| #6 | 0.731 | 17.0% | 26.1% | 35.7% | 5558 | 1480 | 302 | 0 | 0 | 23 | 0/0/0/546 |
| #7 | 0.745 | 18.1% | 27.4% | 34.6% | 6103 | 1352 | 0 | 0 | 0 | 34 | 0/0/0/616 |
| #8 | 0.657 | 13.2% | 22.9% | 31.7% | 4058 | 1669 | 390 | 1 | 0 | 32 | 0/0/0/486 |
| benchmark (fractional) | 0.690 | 11.3% | 17.8% | 37.1% | 3442 | 47855 | 0 | 0 | 0 | 3 | 0/0/0/460 |
| benchmark (fractional) | 0.690 | | | 37.1% | 3442 | 47855 | | 0 | 0 | 3 | |

## £5000 start capital, whole shares: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.526 | |
| minus delisting haircut 0.05 | 0.476 | |
| × 0.6 haircut | 0.286 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.635 | |
| DSR (selected trial #7, N=8) | 0.713 | < 0.95 |
| DSR (walk-forward path) | 0.548 | |
| PBO (CSCV, 16 folds) | 0.824 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 29.3% / 23.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £2798 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 6, 6, 7.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.535 | 10.9% | 25.4% | 47.5% | 16616 | 1054 | 0 | 0 | 83 | 60 | 17/4/201/415 |
| #6 | 0.601 | 11.2% | 21.7% | 25.0% | 17146 | 1352 | 302 | 0 | 82 | 74 | 123/0/0/410 |
| #7 | 0.653 | 13.9% | 24.7% | 35.7% | 21593 | 1335 | 0 | 0 | 58 | 122 | 231/13/0/478 |
| #8 | 0.593 | 10.0% | 19.2% | 29.3% | 15415 | 1613 | 400 | 1 | 59 | 113 | 306/0/0/364 |
| benchmark (fractional) | 0.655 | 8.5% | 13.9% | 23.9% | 13485 | 51894 | 0 | 0 | 0 | 18 | 235/113/0/370 |
| benchmark (whole shares) | 0.509 | | | 1.5% | 6385 | 420 | | 6 | 57324 | 1 | |

## £5000 start capital, fractional: FAIL

Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10.

| Check | Value | Result |
| --- | --- | --- |
| Walk-forward strategy Sharpe | 0.531 | |
| minus delisting haircut 0.05 | 0.481 | |
| × 0.6 haircut | 0.289 | does not beat |
| Benchmark Sharpe (same window, fractional, same budget rules) | 0.635 | |
| DSR (selected trial #6, N=8) | 0.690 | < 0.95 |
| DSR (walk-forward path) | 0.554 | |
| PBO (CSCV, 16 folds) | 0.952 | > 0.10 |
| Coverage stop | 0.3% missing | within 2% |
| Walk-forward max drawdown (strategy / benchmark) | 35.7% / 23.9% | |
| Capital ceiling £1,500 / (selected max DD × 1.5) | £2801 | |

Walk-forward window 2017-09-07 to 2026-09-23; trial selected per fold: 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 6, 6, 6.

| Trial | Sharpe | CAGR | Vol | Max DD | Final equity | Fills | Stops | Skipped fills | Zero-share targets | Cost | Half/Quarter/Halt/Cap days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5 | 0.550 | 12.8% | 30.4% | 52.6% | 19652 | 1219 | 0 | 0 | 0 | 72 | 26/7/201/472 |
| #6 | 0.632 | 13.8% | 25.8% | 35.7% | 21413 | 1515 | 311 | 0 | 0 | 97 | 168/3/0/484 |
| #7 | 0.550 | 11.9% | 27.4% | 44.0% | 18206 | 1315 | 0 | 0 | 0 | 118 | 76/2/203/455 |
| #8 | 0.494 | 8.6% | 21.4% | 31.7% | 13632 | 1696 | 404 | 1 | 0 | 141 | 384/28/0/436 |
| benchmark (fractional) | 0.655 | 8.5% | 13.9% | 23.9% | 13485 | 51894 | 0 | 0 | 0 | 18 | 235/113/0/370 |
| benchmark (fractional) | 0.655 | | | 23.9% | 13485 | 51894 | | 0 | 0 | 18 | |

