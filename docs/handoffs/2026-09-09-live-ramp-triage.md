# Handoff — open-issue triage and the path to the live ramp (2026-09-09)

Written after the 2026-09-08/09 triage session. Read `CLAUDE.md` first; this file only carries what that briefing and the ADRs do not.

## Goal, restated

Prove, then trade, one hypothesis: LLM analysts debating news, sentiment and technicals produce better intraday flat-by-close entries than the same technical rule alone (`CONTEXT.md` falsification test, falsifier arm 2). Paper soak runs the live arm and the control arm side by side on the same tape with separate books (`server/apps/orchestrator/control-arm.ts`). If the live arm beats the control risk-adjusted, DSR-significant, PBO ≤ 0.05, after Saxo's 16 bps, trade it live on £1,000 in the Saxo GIA on LSE leveraged ETPs. If not, rework the architecture, not re-tune it.

Break-even accuracy the signal must clear (doc 54): 51.3% PLTR, 53.0% QQQ, 54.2% SPY, 57.2% MSTR.

## Where we stand

Engineering confidence high: ~2900 tests, invariants pinned, defects found by measurement. Trading confidence low: no measured evidence the edge exists. Stage 2 killed on the proxy, PBO/DSR rejected the 12/24 survivors, cost floors were undersized when that was measured. The arm comparison has produced no number yet; the control arm first traded 2026-09-08.

Not live-ready. Live venue is unwired: `SaxoBrokerAdapter` is never constructed (#1400), GBX pence lines are unscaled (#1302). Flat-by-close failed on 2026-09-08 and seven control lots carried overnight (#1389, #1388; #1390 closed since). Two live-money gates open (#895 mark vendor, #900 single outage exit path). No clean 14-day soak (#238), and the soak runs on US proxies the live book will never hold (#1149 ruled: move it to the LSE-ETP pool).

## What the triage did (2026-09-08)

- Labeled 10 unlabeled issues on the to-tickets scheme (`size:*`, `model:*`, `ready-for-agent` / `needs-decision`).
- Closed #1305, #1304 (Saxo data-surface research, resolved by doc 44 / D1 #1309 / D2 #1310) and #1219 (folded into #751 as an acceptance criterion).
- Marked #1034/#1035 (DMD registration) `needs-decision`: Saxo `infoprices` may supersede it per #1310. #1153 `needs-decision`, same delete ruling as #1152. Removed `future-crypto-system` from #1157 (ruling is delete).
- Filed #1400 (Saxo adapter unwired), #1401 (pool file cites closed #1053 as open), #1412 (edge verdict), #1413 (live ramp go/no-go checklist).

## Critical path, in order

1. Flatten: #1388 (Verdict gate 4 refuses in-window flatten), #1389 (window is one-shot, cannot re-open after the bell). Verify: a paper session ends with zero held lots.
2. #1302 pence scaling, then #1400 Saxo adapter wiring. Verify: Saxo SIM boot, one tick, order sized in GBP.
3. Move the soak to the LSE-ETP pool: #1149 (ruled), #1119 (build). Width per #1310's ruling; sterling lines only per #1220, about four today.
4. Restart #238 for 14 clean days. Only #1080 (22 of 26 debates synthesise nothing) touches the trading path meanwhile.
5. Day 14: #1412 verdict, then #1413 checklist. David signs the go; nothing autonomous flips `SAMURAI_MODE=live`.

Diagnostics that make the soak readable, do alongside: #1394, #1396, #1393, #1392, #1391, #1383, #1082, #1085, #1104.

Edge inputs worth landing before the verdict, or a "dead" ruling is ambiguous: sentiment analyst is built but dark (#961 finding); #522 map, #976, #1042, #1164.

Hygiene with no PnL effect, cheap models in parallel, never on the trading path during the soak: #1179 map and its children, #1158, #1160, #1162 (partly done), #1170, #1171, #1177, #1178, #1218, #1397, #1398, #1401, #1133.

## Rulings waiting on David

#1301 protective-leg commission vs exclude (biases the arm comparison), #1346 authorise the Alpaca reused-id probe, #1311 submit the Saxo live-app request (long lead time), #1034/#1035 drop DMD?, #1316, #1153, #1308 D5, #1144, #900 posture, #1019 rescope, #1002, #1412, #1413. #976 waits on Reddit, not David.

## Hazards for whoever picks this up

- Cited issues must stay OPEN: #895, #900 in `LIVE_MONEY_GATES`; #1387 in the calendar guard and its test; #1135, #1019 in code comments. `yarn check:live-gates` before closing anything they cite.
- `gh issue view --comments` in a non-TTY prints comments only; fetch bodies with `--json body`.
- Board Todo is not startable: `needs-decision` and blocked-in-prose tickets render as takable. Read the last comment before claiming.
- #1216 still open after PR #1454; check the comment for the remaining delta before re-filing.
