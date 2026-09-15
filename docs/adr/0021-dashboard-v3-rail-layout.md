# ADR-0021 — Dashboard v3: the Rail layout, three tabs, no motion

- **Status:** Accepted
- **Date:** 2026-09-04
- **Decided by:** David — grilled live under [Wayfinder map: dashboard v3 — Rail client rewrite](https://github.com/dd-jp/samurai-trading-system/issues/1090), 2026-09-04, against three design artboards and two further variations; the Rail variation was locked with one comment fixed
- **Related:** [#1090](https://github.com/dd-jp/samurai-trading-system/issues/1090) (the map), [ADR-0010](0010-dashboard-vite-react-rewrite.md) (framework, unchanged), [ADR-0011](0011-pipeline-theater-replay-motion.md) (**superseded** by this record), [ADR-0019](0019-dashboard-hosting-topology.md) (hosting, unchanged), `docs/specs/dashboard-spec.md` (the v3 spec this record anchors)

## Context

The v2 dashboard (2026-08-07, ADR-0010/ADR-0011) rendered one mission-control screen: a telemetry strip, a 4×2 grid of "rooms" with sigil chips walking between them on recorded transitions, a hanko-stamped verdict ledger, and a bento of equal-citizen panels. It carried every datum the wire offers and every honesty convention the project holds.

David's verdict on it, 2026-09-04: *"i dont like the existing client i want a total rewrite from scratch."* Grilled one question at a time, the objections were the **layout** and the **density** — a single scrolling page where nothing is first, rooms that spend the hero on a metaphor while the per-stage record lives in a drawer, and a bento that gives P&L the same weight as a latency percentile. Not the palette, not the fonts, not the data.

Three design directions were drawn (Rail, and two others), then two more variations of the preferred one. The Rail won. Its defining moves, each a grilling answer:

- **Three tabs, not one page** — Glance (health, P&L today, open risk, the session's verdicts), Live (where every instrument is in the pipeline, with the trace detail beside it), Review (performance and the closed-trade record). Separate surfaces, because the three questions are asked at different moments and the answer to one is noise to the others.
- **A 240px left rail on every tab** carrying the always-on facts: brand, the tab list, bot ALIVE/STALE, mode, the live tick, both providers, the LLM cap bar, the drawdown bar, the snapshot clock.
- **One row per instrument, six stage cells** replaces the rooms. The lane matrix reads an instrument's whole journey across the pipeline in one line, which is exactly the read the rooms could not give (the v2 spec accepted that cost when it chose rooms; the Rail retires it).
- **A 460px drawer** on Live and Review — stage timeline with durations, gates and invalidation conditions, the debate's stances, the order and its fills; on Review, why the trade was taken and its P&L breakdown.
- **Type at 14px body, labels never below 11px, headline figures 28–40px.** Density was an objection; v2's 9–11px labels are gone.
- **Restraint on the motif.** Only the hanko seals (可 否 止 略) and the brand mark remain. Kanji watermarks, blade-cut corners, lacquer wedges and the ink-bleed wash are out.
- **Keep Blade & Ink** — the token palette and the four fonts are unchanged.

One constraint arrived with the mockup and had to be refused: it drew a £30 daily-loss stop, a three-position cap, a flat-by-close countdown and GBP figures. **None of those are on `DashboardSnapshot`.** The rail and Glance render what the wire carries — the ADR-0008 $50 LLM cap and `CONTEXT.md`'s 26.2% index-bracket drawdown tolerance are the only limits drawn, both cited on screen — and figures stay in the wire's own denomination — USD everywhere except the arm comparison's `basis`, which the Feedback Loop reports in GBP and the card labels as such.

## Decision

**The dashboard is rebuilt from scratch as the Rail: three tabs behind a persistent left rail, a lane matrix for the pipeline, a drawer for detail, and no motion.** ADR-0010's framework, build and dependency decisions stand. ADR-0011's replay motion is **superseded**: there is no walk, no settle ring, no reduced-motion branch, because nothing moves — a poll repaints the page and the rail's clock says when.

Everything v2 rendered still renders (the spec's Information Inventory is re-homed, not cut), and every honesty convention is kept: states are words with colour as a redundant channel, empty states name their reason, the mode is never defaulted, staleness marks the numbers rather than blanking them, `unpriced_calls` makes the spend meter a floor, and a hostile instrument string renders inert.

Two computed figures are new to the client and are computed there deliberately, because they are presentation over wire rows rather than backend facts: **P&L today** (realized on the snapshot's UTC date plus every open position's unrealized figure, with fees shown separately) and **open risk** (notional, stop distance and stop-to-target progress per position). Both are pure functions in `client/src/lib/glance.ts` with unit tests, and both are labelled with what they are computed from.

## Consequences

- **`docs/prototypes/dashboard-v2-mission-control.html` is no longer the visual source of truth.** The locked Rail canvas (design session, 2026-09-04) is; the spec's "Visual source of truth" section points at it. The prototype file stays in the tree as the v2 record.
- **`client/src/lib/room-layout.ts`, `walk-plan.ts` and `hooks/useWalkAnimation.ts` are deleted**, with their tests. Their responsibilities do not move anywhere — the lane matrix needs no placement algorithm and there is nothing to animate. `ledger.ts`, `format.ts` and `useSnapshot.ts` survive unchanged in role.
- **The e2e suite loses its replay spec.** `e2e/replay.spec.ts` and `e2e/support/motion.ts` sampled chip positions mid-walk; there is no walk. The boot and poll specs are rewritten against the Rail's regions and accessible names, over the same real fixture server.
- **Accessible names change shape.** A lane reads `"BTC-USD, crypto, go, at Execution"` (v2's chip read `"…, in Execution"`); the rail is the `complementary` region named `Rail`; the drawers are `Trace detail` and `Live`/`Trade detail`. Anything scripted against v2's names (`Telemetry`, `Pipeline rooms`, `Verdict ledger`, `Instrument detail`) must be updated.
- **No fabricated limits.** A daily-loss stop, a position cap or a flat-by-close clock reach the rail only when the wire carries them. Until then they are absent, not drawn from a config the client cannot see.
- **Review's "why taken" is a summary of the debate row** — direction, rounds, the lead analyst's influence — because arguments are not persisted (decision #10). It is not a transcript and is labelled as not one.

## Alternatives considered

- **Keep v2 and re-skin it.** Rejected by the owner outright ("total rewrite from scratch"); the objections were structural (one page, rooms as hero), and a re-skin keeps the structure.
- **The two other design directions** drawn alongside the Rail (a top-bar variant and a denser single-page variant). Rejected in grilling; the rail's persistence of health across tabs was the deciding read.
- **Keep the replay motion inside the lane matrix** (cells lighting in sequence). Rejected: ADR-0011's value was the chip's walk between rooms; a cell that lights up on the poll that recorded it is already what a repaint does, and keeping a motion layer for that keeps the reduced-motion branch, the `transitionend` chaining and the mid-walk-poll cancellation for no visible gain.
- **Render the mockup's £30 / 3-position / flat-by-close limits from client constants.** Rejected: the client would be asserting limits the runtime does not enforce on a live-money surface. If those limits are wanted on screen they arrive on the wire from the component that enforces them.

## Amendment — 2026-09-09: the arm comparison's `basis` is USD, and the card labels it `$` ([#1180](https://github.com/dd-jp/samurai-trading-system/issues/1180))

The Context section above records one exception to the "USD everywhere" rule: *"figures stay in the wire's own denomination — USD everywhere except the arm comparison's `basis`, which the Feedback Loop reports in GBP and the card labels as such."* **That exception is gone.** #1180 converted the Trader's sizing inlet and the Feedback Loop's denominator to the account's currency (`LIVE_BOOK_GBP * SIZING_USD_PER_GBP`), so `ArmComparisonRow.basis` is now a USD figure and `ReviewTab`'s arm card renders it with `formatUsd` — `$`, like every other cash figure on the page.

The layout decision is untouched: the rule was, and remains, that the client renders the wire's own denomination and never converts. Only the wire moved. `docs/specs/dashboard-spec.md`'s "Visual source of truth" section already says this; the sentence above is the one an implementer would otherwise have followed back to a `£`.

The declared book is still £1,000 (ADR-0015's 2026-08-18 amendment). The conversion is the sizing inlet's, not a re-denomination of the book, and the live-money currency guard (`same_currency_verified`, `risk-manager/types.ts`) is deliberately left refusing — see #1180 for why a static rate must not reach that gate.

## Amendment — 2026-09-15: an arm selector, overall and today's P&L, in GBP on a London day ([#1590](https://github.com/dd-jp/samurai-trading-system/issues/1590))

David, 2026-09-15: *"need overall PnL on glance along with today's PnL. have a mode selector Live arm or control arm. both should have all values dont mix them."* Grilled under map [#1590](https://github.com/dd-jp/samurai-trading-system/issues/1590); each point below is one of its resolved decisions.

**1. The dashboard gains an arm selector, and it switches the whole page.** Glance, Live and Review each render one arm — the live arm or the matched control (falsifier arm 2) — never a mix. The rail carries the selector; the arm lives in the URL hash beside the tab, is not remembered across sessions, and defaults to **Live** on load. The control view carries a persistent banner ("CONTROL ARM — simulated fills, no money") and a distinct accent tint, as words first and colour second, per this record's convention. The Review arm-comparison card is unaffected: it is already both arms together by rule, and stays so in either view.

**2. A figure an arm cannot have is an explicit N/A, never blank, zero, or the other arm's value.** The control arm has no LLM debate, no critic verdict, no broker equity, and no persisted tick status; its view names each absence ("Control arm: no LLM debate — not applicable"). System-health facts — providers, LLM spend, alert delivery — are not arm facts: they render identically in both views and are labelled as system.

**3. Glance gains overall P&L, and it is computed on the server.** Overall P&L is all-time per arm: closed-trade net plus open unrealized, always beside that arm's max drawdown and trade count (doc 12 D4 — never a return-only headline). This reverses the Decision section's "computed on the client" choice for P&L: an all-time sum is not presentation over the rows one snapshot carries (`closed_trades[]` is a recent window), so it is a backend fact, and the cumulative-P&L-and-drawdown computation already exists in the Feedback Loop's arm comparison to be reused rather than re-derived.

**4. "Today" is the Europe/London calendar day, not the snapshot's UTC date.** The book and its operator are in London; between 00:00 and 01:00 BST the UTC rule filed a London day's trades under the previous day. P&L today moves to the server with overall P&L, so both headline figures come from one aggregation.

**5. P&L figures are GBP, and the client still never converts.** Both headline figures and their percentage are in sterling, the percentage against the £1,000 declared book (ADR-0015's 2026-08-18 amendment), on the same basis for both arms. The rule from the 2026-09-09 amendment holds unchanged — the client renders the wire's own denomination; **the wire moves to GBP for these fields**, as it moved to USD for `basis`. Cash figures not named here stay USD until their own decision.

The rate is `SIZING_USD_PER_GBP` — the one static constant the sizing inlet and the Feedback Loop's `basis` already use (#1180) — so no second rate enters the system. The wire carries the rate and its source beside the GBP figures and the page states them, so a reader never takes a static sizing rate for a marked FX conversion. **The conversion is display-only**: it never reaches `same_currency_verified`, which stays refusing for #1180's reasons. When a live FX feed replaces the constant at the composition root, the dashboard follows with no client change. Per-fill `fx_rate_to_gbp` (#1521) is not the source: it is absent on book-currency fills and `not_reported_by_venue` on Saxo non-GBP fills, so it cannot price an all-time sum.

**What this amendment does not change.** The layout, the tabs, the drawers, the no-motion rule and every honesty convention stand. The dashboard remains read-only with no write path. The store's live-only reads ([#753](https://github.com/dd-jp/samurai-trading-system/issues/753), [#1318](https://github.com/dd-jp/samurai-trading-system/issues/1318), [#1319](https://github.com/dd-jp/samurai-trading-system/issues/1319)) were live-only so that control rows could never leak into live figures; parameterising them by arm keeps that guarantee — a read names exactly one arm, and no read returns both — rather than removing it.
