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

One constraint arrived with the mockup and had to be refused: it drew a £30 daily-loss stop, a three-position cap, a flat-by-close countdown and GBP figures. **None of those are on `DashboardSnapshot`.** The rail and Glance render what the wire carries — the ADR-0008 $50 LLM cap and `CONTEXT.md`'s 26.2% index-bracket drawdown tolerance are the only limits drawn, both cited on screen — and figures stay USD, because that is what the wire denominates.

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
