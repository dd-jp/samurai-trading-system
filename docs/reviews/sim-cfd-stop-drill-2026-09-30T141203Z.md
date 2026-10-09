# Saxo SIM CFD resting-stop drill, 2026-09-30

Refs #1400 #1916. Verdict: **FAILED**.

Gateway https://gateway.saxobank.com/sim/openapi, Saxo trial account (-). Run 2026-09-30T14:12:03.615Z to 2026-09-30T14:12:03.908Z. Full record: sim-cfd-stop-drill-2026-09-30T141203Z.json.

A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.

| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |
|---|---|---|---|---|---|---|---|---|---|

- Flat before: not read
- Flat after: not read
- Cleanup: 0 orders cancelled, 0 positions flattened, 0 errors
- Failure: saxo_sim_unauthorized: the SIM token is expired or invalid; ask David for a fresh one
