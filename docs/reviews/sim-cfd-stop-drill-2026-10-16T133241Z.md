# Saxo SIM CFD resting-stop drill, 2026-10-16

Refs #1400 #1916 #1914. Verdict: **FAILED**.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (EUR). Run 2026-10-16T13:32:41.389Z to 2026-10-16T13:42:47.533Z. Full record: sim-cfd-stop-drill-2026-10-16T133241Z.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|
| AAPL:xnas | CfdOnStock | failed | drill_stop_not_triggered | 346.93 | 376.22 | Working | 347.11 | - | - |

- Flat before (2026-10-16T13:32:41.569Z): 0 net positions, 0 open orders
- Flat after (2026-10-16T13:42:47.439Z): 0 net positions, 0 open orders
- Cleanup: 2 orders cancelled, 1 positions flattened, 0 errors
- Failure: drill_stop_not_triggered: AAPL:xnas
