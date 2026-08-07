# ADR-0011 — Pipeline theater: motion permitted, but only as replay of recorded transitions

- **Status:** Accepted
- **Date:** 2026-08-07
- **Decided by:** David — dashboard v2 brief (rooms + walking persona + decision log), resolved in session on 2026-08-07
- **Related:** [Wayfinder: dashboard v2](https://github.com/dd-jp/samurai-trading-system/issues/533) (decisions 3, 4, 10), [#421](https://github.com/dd-jp/samurai-trading-system/issues/421) (the grilling ticket that produced the rule this reverses), [#412](https://github.com/dd-jp/samurai-trading-system/issues/412) (the stage-rail primitive it was decided under), [#535](https://github.com/dd-jp/samurai-trading-system/issues/535) (`PipelineCell.recorded_at`, the precondition), [dashboard-spec.md](../specs/dashboard-spec.md) "Motion", [ADR-0010](0010-dashboard-vite-react-rewrite.md)

## Context

[#421](https://github.com/dd-jp/samurai-trading-system/issues/421) asked what
should move on the pipeline view at a 3-second poll, and resolved to the
strictest possible answer, written into the v1 spec as:

> Motion is confined to a single ring on whatever actually changed between two
> polls — **nothing travels across the page.** A chip that moved station
> disappears from the old one and appears at the new one already settled; there
> is no transit animation, because the poll never observed the transit, only two
> positions 3s apart, and animating the path between them would assert a
> continuity the data does not have.

That argument is correct **about the information the client had at the time**,
and it is the kind of correctness this project should be reluctant to give up.
A UI that draws a smooth path between two sampled positions is telling the
operator a story about the interval it did not observe. On a page whose whole
purpose is to be trusted about live money, an invented continuity is a lie with
good manners.

Two things changed.

1. **The v2 brief makes the walk the point.** The hero is a rooms grid with one
   persona per instrument; "where is the load, where are ticks dying" is meant to
   be readable as movement, not inferred from chips that teleport. Under the old
   rule the theater is a slideshow.
2. **The transitions are not unobserved. They are in the database.** `audit_log`
   stamps every stage a trace reached with a timestamp. What the v1 rule
   identified as missing was not the transition — it was the *client's knowledge*
   of it, because the wire shape projected `state`, `duration_ms`, `decision` and
   `attempts` but no per-stage time. The information existed and was being thrown
   away at the wire boundary.

## Decision

**Motion across the page is permitted, and only ever as time-compressed replay
of transitions the store actually recorded.** Interpolation between two
observations remains forbidden.

The distinction is the whole ADR. The client is not drawing a plausible path
between two sampled positions; it is reading a list of timestamped rows and
retelling them in order. `PipelineCell.recorded_at` ([#535](https://github.com/dd-jp/samurai-trading-system/issues/535))
puts those timestamps on the wire, which is why that ticket is a hard
precondition and not a nicety — without it, the animation would be exactly the
fabrication #421 refused.

The rule, as specced:

1. A chip walks room-to-room **only** along transitions present in `audit_log`
   (via `recorded_at`) or `current_tick`.
2. Hop durations are **proportional to the recorded gaps**, clamped to
   **150–450 ms** per hop and **≤1.2 s total per poll** — a compressed retelling
   that always finishes before the next poll arrives.
3. **First paint places without walking** — no previous snapshot, so no recorded
   transition to replay.
4. **A hidden tab snaps on return** — those transitions were never observed by
   this client, and a marathon replay of a background hour is not a retelling of
   anything the operator was watching.
5. **`prefers-reduced-motion` snaps, with a settle ring** — the change is still
   signalled, exactly as v1 signalled every change.
6. **Skipped stages are never walked through.** A `null` `recorded_at` means the
   stage was not visited; the chip hops over that room rather than through it.
7. **A rotated trace walks to Analysts first, then forward** — a new trace began
   at the start; it did not cut diagonally from where the last one died.
8. **Aging to idle snaps to the Lobby** — the 15-minute window closing is the
   clock passing, not an action of the system, so it is not narrated as one.
9. **A new poll mid-walk cancels outstanding hops and snaps to observed state.**
   The data is the authority; the animation yields to it.
10. **No `requestAnimationFrame` for critical rendering** — CSS keyframes and
    transitions only, chained on `transitionend` with a `setTimeout` fallback.
    Prototyping found rAF callbacks never firing in a sandboxed frame, and a page
    whose chips only appear if a frame callback runs is a page that can render
    empty.

**The exclusions are not special cases; they are the principle.** Every one of
items 3–8 is the same test applied: *is there a recorded transition to replay?*
Where the answer is no — no prior observation, no observation by this client, no
visit to that stage, no system action at all — nothing travels. The rule is
therefore one sentence with a consistent set of consequences, not a permission
with a list of exceptions, and a future case not enumerated above should be
resolved by asking that question rather than by analogy to the nearest item.

## Consequences

- **The animation can lag reality by up to ~1.2 s**, by construction. Accepted:
  the numeric readouts (telemetry strip, drawer stage strip, ledger) always show
  the newest poll, so no *number* is ever behind. Only the chip's position is
  mid-retelling, and rule 9 collapses it the moment new data lands.
- **A tick shorter than the poll interval is replayed in one go** — several hops
  in ≤1.2 s. That is a faithful compression of what happened, not a distortion,
  and it is how a fast pipeline should look.
- **The replay engine is real logic that must be tested as such.** `walk-plan.ts`
  is a pure function of `(prev, next, opts)`; every rule above is a test case.
  Motion correctness is not a visual-review question.
- **The v1 ring survives** for everything that is not a recorded transition:
  appearance, disappearance, value changes, reduced-motion settle. v2 adds a
  mode of motion; it does not remove the old one.
- **It is now possible to get this wrong in a new way** — a future change that
  animates on anything other than a recorded row re-introduces exactly the lie
  #421 refused. That is what makes this an ADR rather than a spec paragraph.

## Alternatives considered

- **Keep the #421 rule; build the rooms with teleporting chips.** Fully honest,
  zero new risk, and it was the incumbent. Rejected on the brief: the walk is
  what makes the theater legible at a glance, and teleporting chips in a rooms
  grid read worse than they did on a rail — a persona that blinks between rooms
  looks like a rendering bug rather than a deliberate restraint.
- **Interpolate freely; animate any position change smoothly.** Simplest to
  implement, and what most dashboards do. Rejected outright: this is precisely
  the invented continuity #421 identified, and it would make the page assert
  intermediate states that never existed — including walking a persona through
  a skipped stage.
- **Move to SSE/WebSocket so transitions are observed live.** Removes the
  argument entirely by making the client a real-time observer. Rejected ([map #533](https://github.com/dd-jp/samurai-trading-system/issues/533)
  decision 4): a new liveness transport is a new failure mode, a new
  reconnect/backpressure surface and a change to the server's posture, bought to
  solve a problem that timestamps already in the database solve for free.
- **Animate only the live lane, snap everything else.** A tempting middle
  ground. Rejected as arbitrary — the live lane's *current* stage is the one
  transition that has no completed `audit_log` row yet, so it is the weakest
  case for animation, not the strongest.
