# Saxo SIM CFD resting-stop drill, 2026-10-16

Refs #1400 #1916 #1914 #2107. Mode: kill-place. Verdict: **PASSED**.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (EUR). Run 2026-10-16T15:08:30.672Z to 2026-10-16T15:08:32.516Z. Full record: sim-cfd-stop-drill-2026-10-16T150830Z-kill-place.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|
| AAPL:xnas | CfdOnStock | passed | - | 346.18 | 379.5 | Working | - | - | - |

- Flat before (2026-10-16T15:08:30.861Z): 0 net positions, 0 open orders
- Flat after: not read
- Cleanup: 0 orders cancelled, 0 positions flattened, 0 errors
