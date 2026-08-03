# Code Review 2026-08-01 — Remediation Status

**Sources:** `code-review-2026-08-01.md` (consolidated, 35 items) and `code-review-security-2026-08-01.md` (17 findings — the companion to review A, **not** a separate item set; its numbering differs, e.g. security-H3 = consolidated-LOW "Simulated `getOrder` instrument param", security-H4 = consolidated-H3).

**Verified against code at** `dd2f443` (main @ 804f4ec + PR #290), 2026-08-03. Every row below was checked in the source, not taken from a PR description.

**Headline: 16 fixed, 1 partial, 11 deferred with tickets, 1 declined, 6 untracked.** Nothing critical to *paper* trading remains unaddressed — but see the two caveats at the end, and note that the remediation was split across two PRs (#297 merged, #290 open) that independently fixed the same seven findings.

---

## Fixed and verified (16)

| # | Finding | Where it landed | Evidence |
|---|---|---|---|
| C2 | Zero rate limiting | #297 | `TokenBucket` wired into all three adapters |
| C4 | Unbounded `IndicatorCache` | #290 | `indicator-cache.ts:36,50` — LRU with `maxEntries` |
| H1 | Credential leak via broker errors | #297 | `BrokerError` built only from curated fields, no `cause` |
| H2 | Null `filled_avg_price` → price 0 | #297 | `collectFill` now throws; also guards `NaN` `filled_qty` |
| H4 | `isUniqueConstraintError` ×3 | #290 | `shared/store/sqlite-utils.ts`; feeds #297's typed error |
| H5 | `AssetClass` ×4 | #290 | canonical in `shared/types.ts` |
| H7 | Feedback stores rebuilt per cycle | #290 | `production.ts:644` — constructed once, closed over |
| H9 | Unbatched bar writes | #290 | `sqlite-market-data-store.ts:53` — one transaction per batch |
| M2 | TOCTOU on dedup | #297 | typed `DuplicatePositionError`, discriminated in `execute.ts` |
| M3 | `syncBrackets` Map race | #297 + #290 | ccxt snapshot in #297; **Alpaca's `fetchNewFills` was missed and fixed in #290** |
| M4 | No retry jitter | #297 | full jitter on exponential delay |
| M5 | Missing mark → silent zero | #297 | `portfolio-view.ts` throws |
| M6 | `Logger`/`LogSink` two authorities | #290 | canonical in `shared/types.ts` |
| M8 | Tuning-store KV triplication | #290 | one `kvGet`/`kvSet` pair |
| LOW | Simulated `getOrder` drops `instrument` | #297 | `simulated-adapter.ts:118` — `_instrument` declared |
| LOW | `computeAtr` blocked by #65 | — | #65 is now **closed**; see untracked below |

## Partial (1)

**C5 — missing indexes.** Migration `0005_hot_path_indexes.sql` adds four: `fills(broker_fill_id)`, `closed_trades(closed_at)`, `debate_log(created_at)`, `verdict_log(timestamp)`. The review named **six**, across `analyst_weights` and `current_tick` too — neither is indexed. Likely defensible (`current_tick` is documented disposable and holds ~1 row; `analyst_weights` is small and PK-keyed), but it was not stated as a decision anywhere, so it reads as an oversight rather than a judgement. Worth one line either way.

## Deferred, ticket exists (11)

| # | Finding | Ticket | Verified still open in code |
|---|---|---|---|
| C1 | IBKR `getOrder` always throws | **#294** | `ibkr-adapter.ts:152` — unconditional throw |
| C3 | ccxt OCO bracket registry in-memory | **#287** | no `brackets` table in any migration |
| H3 | All adapters lose fill feeds on restart | **#295** | in-process `Map`s in all three adapters |
| H8 | N+1 mark queries | #289 | |
| H10 | ccxt over-fetch on short windows | #289 | |
| H11 | Duplicate ATR in replay loop | #289 | |
| M1 | Float64 money math | **#288** / #296 (dup) | no decimal lib in `package.json` |
| M7 | No shared SQLite store base | #289 | |
| M9 | `SharedStore` = raw handle | #289 | |
| M10 | Long-restart `since` window | #289 | `ingest-fills.ts:35` — still global `earliest(opened_at)` |
| LOW | `execute()` exit path returns `'error'` | **#74** | `execute.ts:66-68` |

## Declined — worth revisiting (1)

**H6 — `production.ts` god module.** Declined in #290 as overstated ("mostly doc comments, coherent composition root per ADR-0004"). That rationale is reasonable, but the file was **638 lines at review time and is 734 now** — it grew 15% during the very remediation that declined to split it. The decision isn't wrong; it's just no longer supported by the number it was argued from.

## Untracked — no issue exists (6)

1. **M11 — correlation warm-up blind spot.** Pairs under `min_bars` are omitted, so a genuinely correlated new pair reads as uncorrelated to the concentration check. `correlation.ts:15-17` documents it as intended (risk-manager-map.md AC3), and the review agreed it's documented — but explicitly called it "a real exposure blind spot" anyway. Neither fixed nor ticketed.
2. **`computeAtr` still in Trader** (`trader/decide.ts`). The review said this belongs to MDS and was blocked by #65 — **#65 is now closed**, so the blocker is gone and the move simply hasn't happened.
3. **C5 remainder** — the two un-added indexes above.
4. **Thin wrapper sprawl** — `analysts-adapter.ts` (5-line body); `logging-verdict.ts` + `notifying-verdict.ts` mergeable.
5. **`VerdictLogStore` port narrower than impl** (`getByTraceId` not on the port).
6. **Large mixed-domain type files** — `execution/types.ts`, `feedback-loop/types.ts`, `shared/types.ts`.

Items 4–6 are cosmetic. Items 1–3 are small but real, and per the project's track-everything-as-issues rule they should exist as tickets rather than living only in a review file.

---

## Two caveats worth your attention

**1. The remediation was done twice.** #297 (merged) and #290 (open) independently fixed the same seven findings — H1, H2, C2, M2, M3, M4, M5. #290 has now been merged down to take main's implementation on all seven. Two agents worked the same review without a claim step; the cost was a full conflict resolution. Worth a claim convention before the next review sweep.

**2. "Addressed" ≠ "exercised."** Every fix above is unit-tested (1140 tests green), but the live-money paths they protect have never run against a real venue. `ingestFills()`/`reconcile()` still have no scheduled caller anywhere in production (see `docs/paper-trading-readiness-2026-08-03.md`), so the H2 null-price guard, the M3 snapshot, the M2 dedup race and the H1 error boundary are all correct-by-test and untouched-by-traffic. The soak (#238) is what converts these from "fixed" to "known good."
