# Saxo SIM CFD resting-stop drill, 2026-10-16

Refs #1400 #1916 #1914 #2107. Mode: target. Verdict: **FAILED**.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (EUR). Run 2026-10-16T14:57:45.770Z to 2026-10-16T15:07:52.424Z. Full record: sim-cfd-stop-drill-2026-10-16T145745Z-target.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|
| AAPL:xnas | CfdOnStock | failed | drill_target_not_filled | 345.47 | 379.09 | Working | - | - | - |

- Flat before (2026-10-16T14:57:45.987Z): 0 net positions, 0 open orders
- Flat after (2026-10-16T15:07:51.953Z): 0 net positions, 0 open orders
- Cleanup: 2 orders cancelled, 1 positions flattened, 0 errors
- Failure: drill_target_not_filled: AAPL:xnas
