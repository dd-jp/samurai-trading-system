# Saxo SIM CFD resting-stop drill, 2026-10-09

Refs #1400 #1916. Verdict: **PASSED**.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (EUR). Run 2026-10-09T17:23:29.159Z to 2026-10-09T17:23:58.244Z. Full record: sim-cfd-stop-drill-2026-10-09T172329Z.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|
| AAPL:xnas | CfdOnStock | passed | - | 334.71 | 368.47 | Working | 334.88 | FinalFill | 334.89 |
| ISF:xlon | CfdOnEtf | skipped | market_closed | - | - | - | - | - | - |

- Flat before (2026-10-09T17:23:29.360Z): 0 net positions, 0 open orders
- Flat after (2026-10-09T17:23:58.173Z): 0 net positions, 0 open orders
- Cleanup: 0 orders cancelled, 0 positions flattened, 0 errors
