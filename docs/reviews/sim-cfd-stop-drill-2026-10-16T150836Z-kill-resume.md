# Saxo SIM CFD resting-stop drill, 2026-10-16

Refs #1400 #1916 #1914 #2107. Mode: kill-resume. Verdict: **PASSED**.

Resumes sim-cfd-stop-drill-2026-10-16T150830Z-kill-place.json.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (EUR). Run 2026-10-16T15:08:36.344Z to 2026-10-16T15:08:39.106Z. Full record: sim-cfd-stop-drill-2026-10-16T150836Z-kill-resume.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|
| AAPL:xnas | CfdOnStock | passed | - | - | 379.5 | - | - | - | - |

- AAPL:xnas: stop 5040931361 still Working in a fresh process after the placing process exited: yes
- Flat before: not read
- Flat after (2026-10-16T15:08:38.991Z): 0 net positions, 0 open orders
- Cleanup: 2 orders cancelled, 1 positions flattened, 0 errors
