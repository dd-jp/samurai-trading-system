# Saxo SIM CFD resting-stop drill, 2026-10-16

Refs #1400 #1916 #1914. Verdict: **PASSED**.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (EUR). Run 2026-10-16T13:43:24.391Z to 2026-10-16T13:51:37.732Z. Full record: sim-cfd-stop-drill-2026-10-16T134324Z.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|
| ISF:xlon | CfdOnEtf | passed | - | 1059.6 | 1163.8 | Working | 1060.2 | FinalFill | 1060 |
| RR:xlon long | CfdOnStock | passed | - | 1357.4 | 1223 | Working | 1356.6 | FinalFill | 1355.8 |

- Flat before (2026-10-16T13:43:24.602Z): 0 net positions, 0 open orders
- Flat after (2026-10-16T13:51:37.663Z): 0 net positions, 0 open orders
- Cleanup: 0 orders cancelled, 0 positions flattened, 0 errors
