# Samurai v2 — north star

**Status:** Draft, written 2026-09-19 at David's instruction. Supersedes every prior stated
goal for Samurai — CLAUDE.md's project identity, CONTEXT.md's edge thesis, and ADR-0014
through ADR-0018 — **on vision, not as a repeal of the code**. Those documents still describe
what exists and why it was built; this document describes what gets built next and why.
Companion: `docs/v1-postmortem.md`, which is the evidence this vision is meant to act on.

This is a vision statement, not a spec. Per the repo's own Standing Pipeline Rule 1, nothing
here should be implemented against directly — it needs a wayfinder map, grilled one decision
at a time, before any code changes. Several numbers below are stated by David and have not
yet been reconciled against each other (see **Open questions** at the end) — do not treat
them as internally consistent until those are resolved.

## The vision, as given

> A self-improving AI trading system, running intraday and momentum/swing trades (swing
> holds allowed — not flat-by-close), with the sole intent of holding losses to a maximum of
> £1,500 in a year, while attempting 0.5-2% profit per day, on a daily trading capital of
> £1,000-5,000 — whichever capital level fits the vision.

## What changes from Samurai v1

| Axis | Samurai v1 (superseded) | Samurai v2 |
|---|---|---|
| Horizon | Intraday only, flat by close, no overnight carry (ADR-0014) | Intraday **and** swing — overnight/multi-day holds are in scope |
| Self-improvement | Explicitly excluded from the edge claim — feedback loop only tunes weights, never the model (CONTEXT.md) | Self-improving is the point — the system is meant to adapt |
| Risk framing | Per-subclass drawdown *tolerance* (26.2%/41.8%, accepted as the cost of the sizing) | Hard annual loss ceiling: **£1,500/year**, framed as the primary constraint |
| Return framing | No stated daily target; Sharpe ~1.5 aspirational (CONTEXT.md) | Explicit daily attempt: **0.5-2%/day** |
| Capital | Fixed £1,000, all equity (ADR-0015, 2026-08-18) | £1,000-5,000, sized to fit the vision — not yet fixed |
| Scope | Equities only, GBP LSE-listed ETPs, crypto explicitly out (ADR-0015 2026-08-16 amendment) | Not yet restated — carried as an open question, not assumed |

## Why this is a real pivot, not a parameter change

Four structural pieces of Samurai v1 exist *because* of constraints v2 explicitly drops, and
none of them survive unmodified:

1. **The entire flatten subsystem** — `withinFlattenWindow`, the post-close grace tail,
   carried-lot alerting, the #1389 fix landed nine days before this document — was built to
   enforce "no overnight carry." Swing holds make this subsystem either dead code or, more
   likely, the wrong shape entirely: swing needs *managed* overnight risk (gap stops, sizing
   against gap risk, an overnight dead-man's-switch), not an alarm that fires when a position
   survives past a deadline it was never supposed to reach.
2. **The instrument universe** (3× leveraged LSE ETPs, ADR-0016) was chosen *because*
   intraday-only, flat-by-close needs enough volatility to hit a same-day take-profit inside
   one session. Leveraged products decay on multi-day holds (volatility drag) — they are close
   to the wrong instrument for swing, not just a suboptimal one.
3. **The validation model** (PBO ≤ 0.05, MinBTL trial budget, DSR significance — CONTEXT.md,
   `server/tools/backtest/overfitting.ts`) assumes a *fixed* strategy tested out-of-sample.
   "Self-improving" — if it means the strategy logic or thresholds change themselves during
   live operation, not just Feedback-Loop-style weight recalibration inside a fixed
   model — burns a fresh trial on every self-edit. Left unaddressed, this makes every PBO/DSR
   number the system reports meaningless. This needs its own decision (see open questions).
4. **The risk sizing model** (per-subclass deployment caps sized to hold a *tolerated*
   drawdown envelope, ADR-0018 D5) optimizes for a different quantity than v2's constraint.
   V1 accepts a wide drawdown range as the cost of a sizing choice; v2 states a hard
   *annual loss ceiling*. These need different sizing math — a ceiling implies either a
   circuit-breaker that halts trading once approached, or per-trade risk budgeted explicitly
   against the number of trading days left in the year, not a static fraction of capital.

## What is explicitly carried forward from the postmortem

Independent of the vision change, `docs/v1-postmortem.md` names six pitfalls that bind
regardless of which strategy gets built:

- Validate the core signal-generation mechanism standalone, before building the full pipeline
  around it (postmortem §1).
- Any windowed data read needs an explicit, tested coverage invariant (postmortem §2).
- Any time-triggered mandatory action needs to survive process downtime — venue-enforced
  where possible, watchdog-backed otherwise (postmortem §3). This bites *harder* under swing,
  not less: overnight risk with no flatten deadline still needs something that fires if the
  system is down when a stop should renew or a gap check should run.
- Front-load grilling on capital, venue, universe, and risk tolerance before marking any of
  them "Accepted" (postmortem §4).
- Give the highest-conviction component (whatever v2's edge claim rests on) module-boundary
  discipline from day one (postmortem §5).
- State the "how would we know this worked" sample-size arithmetic before locking instrument
  and window scope (postmortem §6) — for v2 this means working out trades-per-month under a
  swing-eligible universe *before* deciding the universe, not after.

## Open questions — need David's ruling before a wayfinder map can open

These were raised during the vision discussion and are not yet resolved. Listed here so the
vision doc doesn't silently pick an answer for you.

1. **Is £1,500/year a soft target or a hard kill-switch?** As a soft target it's a look-back
   metric. As a hard kill-switch, the system needs to halt trading for the remainder of the
   year once realized losses approach it — a circuit-breaker requirement that changes the
   architecture, not just the tuning.
2. **Is 0.5-2%/day a per-trade expectancy, a per-session-average target, or a literal
   compounding daily target?** Taken literally and compounded, 2%/day over a ~250-day trading
   year is roughly a 150x annual return — not a realistic sustained target for an equity
   momentum/swing system. Needs restating as either a per-trade number with an implied win
   rate, or an explicit acknowledgment that most days are flat/small and the 0.5-2% describes
   winning days only.
3. **Does the instrument universe stay leveraged ETPs, or open up?** Leveraged products were
   picked for intraday physics specifically; swing holds argue for unleveraged equities,
   liquid large-caps, or futures instead. This also interacts with the CGT/GIA venue
   machinery already built (Saxo) — worth confirming that stays fit for purpose before ruling
   on the universe.
4. **What does "self-improving" mean, concretely?** (a) Feedback-loop-style recalibration of
   weights/thresholds within a fixed strategy shape — v1 already does a bounded version of
   this and it's compatible with the existing PBO/MinBTL validation model. (b) The strategy
   logic itself changes during live operation — a materially bigger build, and it needs a
   different overfitting-control story before any live capital touches it, because the
   existing one assumes a frozen model under test.
5. **Capital: fixed, or system-selected daily within £1,000-5,000?** If the system varies
   deployed capital day to day, that's a vol-targeting/sizing model to design, not a constant
   to set — a materially different scope than v1's fixed per-position split.

## Suggested next step

Per Standing Pipeline Rule 1: open a wayfinder map issue for "Samurai v2 north star", with
the five open questions above as its first five child tickets, grilled one at a time with
David before any spec or code work starts. This document is the map's starting brief, not a
substitute for it.
