# Client module design — deep-module review, 2026-09-04

**Subject.** Every module under `client/` (~6,400 lines, v3 Rail client, merged 2026-09-04 at
`43f1a41` / [#1092](https://github.com/dd-jp/samurai-trading-system/issues/1092)), assessed on one
axis: **is each module deep — a lot of behaviour behind a small interface — and is its seam in the
right place?** Vocabulary is the `codebase-design` skill's: *module*, *interface* (everything a
caller must know, not just the type), *seam*, *adapter*, *depth-as-leverage*.

**This is a design review, not an implementation.** Standing Pipeline Rule 1 bars implementation
without a resolved wayfinder map and a written spec. Every finding below states a **proposed
interface as a signature**, so a map/spec can lift it directly. Nothing here was applied to the
code.

**Prior reports.** [`orchestrator-dashboard-architecture-2026-08-07.md`](orchestrator-dashboard-architecture-2026-08-07.md)
is the only earlier review touching the dashboard, and it explicitly records *"There is no `client/`
yet; v2 is spec-only"* — so it filed **no client-side findings**, and none are re-litigated here.
Its server-side conclusions (the `DashboardQueryStore` port, the 3s poll as the event seam per
ADR-0011) are unchallenged and are treated as settled inputs.

**Verification.** Every finding was checked against the tree at `6087581`; `git diff eb616bf..6087581
-- client/ contracts/` is empty, so every `file:line` here is equally valid at `eb616bf`, the head at
which the review was started. Two candidate findings
were **falsified during verification and are recorded as such in §9** rather than filed — including
one that looked like a live-surface defect and is not.

---

## 1. What is already deep — do not "improve" these

Stated first because the largest risk a review like this carries is a refactor that flattens
something already well-shaped.

| Module | Interface | Why it is deep |
|---|---|---|
| `hooks/useSnapshot.ts` | `SnapshotFeed` (4 fields) + `UseSnapshotOptions` | ~200 lines of poll scheduling, staleness watchdog, per-invocation timeout, abort handling and wire-boundary narrowing sit behind four fields. `fetchImpl`/`now` are injected, so the **interface is the test surface** — and there are two real adapters (global `fetch`, test fake), which is what makes the seam real rather than hypothetical. Textbook. |
| `components/Track.tsx` | `{fraction, tone, label, thick?}` | Hides the `barWidth` decision that `null ≠ 0%` — a missing figure renders nothing, not an empty meter. One small interface, one invariant, five call sites. |
| `lib/format.ts` | 14 functions, one contract | The interface is wide in *count* but each function is learnable in one glance, and the leverage is the single `UNKNOWN` contract: no formatter can emit `NaN` into visible text or a CSS length. The wide surface is the right shape here; do not collapse it. |
| `lib/glance.ts`, `lib/ledger.ts` | Pure functions over wire rows | In-process dependencies only (DEEPENING §1), tested directly through their interfaces with no DOM. `ledger.ts`'s `seen`-set dedupe and NaN-safe comparator are exactly the kind of complexity that belongs behind a small interface. |

The findings below are all in the **component layer**, which is where this client's depth runs out.

---

## 2. F1 (HIGH) — the lane matrix drops #1080's degraded-decision gloss

**This is the one finding where the shallow-module diagnosis predicts a defect rather than
describing a smell.**

Two modules render a lane's stage cells, and both re-derive the same knowledge independently:

- `components/TraceSections.tsx:63-110` (`Timeline`, the drawer) walks `PIPELINE_STAGES`, resolves
  `cellsByStageOf(lane)`, handles the absent cell, and renders the decision through
  **`decisionText(cell)`** (`TraceSections.tsx:50-61`).
- `components/tabs/LiveTab.tsx:54-95` (`LaneRow`, the lane matrix) walks `PIPELINE_STAGES`, resolves
  `cellsByStageOf(lane)`, handles the absent cell, and renders the decision as **bare
  `decisionOf(cell)`** (`LiveTab.tsx:88`).

`decisionText` is where [#1080](https://github.com/dd-jp/samurai-trading-system/issues/1080)'s gloss
lives: a degraded decision renders as `budget_exhausted — <the DEGRADED_DECISIONS sentence>`, which
is the whole point — the ticket exists to separate *a starved debate* from *a debate that genuinely
found nothing*, which otherwise renders as the equally bare `neutral`. `LaneRow` never calls it.

**These words are written, not merely contracted.** The runner writes a degraded word into
`audit_log` on every tick that produces one — `tick-runner.ts:436` records
`debateDecisionWord(debate)`, which returns `not_admitted` / `budget_exhausted` /
`timed_out_partial` (`debate-decision.ts:44-52`), and `tick-runner.ts:388` records
`analystsSkipDecisionWord(...)` for the two `quorum_skip_*` words. `contracts/pipeline.ts:108`
records that in the 2026-09-03 session this fired on 22 of 26 timed-out debates. So the finding is
a live divergence, not a latent one: the value reaches `PipelineCell.decision`, and the matrix
renders it bare.

**Consequence.** The same stage of the same lane reads **glossed in the drawer and unglossed in the
lane matrix**. The lane matrix is the surface an operator scans first. #1080 merged at `c0bdec2`
(four commits before this review) to make starved debates legible; half of it did not reach the
matrix. `TraceSections.tsx:85` even sets `data-degraded` on the timeline row so tests and
stylesheets can select degraded rows — `LiveTab`'s cells carry no such attribute, so no test could
have caught the divergence.

**Why it happened, in design terms.** "The stage cells of a lane, resolved for display" is a real
module that was never given an interface. Its knowledge is currently spread across two renderers
plus two `lib/` helpers, so a change to one renderer does not reach the other — the exact loss of
**locality** that depth buys.

**Proposed interface.**

```ts
// client/src/lib/lane-cells.ts
export interface ResolvedCell {
  stage: PipelineStage;
  /** `false` when the wire carried no cell for this stage. */
  present: boolean;
  /** The state word, already resolved against the lane's outcome. */
  word: string;
  tone: StateTone;
  /** The decision text, glossed when degraded (#1080). `null` when there is none to show. */
  decision: string | null;
  degraded: boolean;
  attempts: number;
  recordedAt: string | null;
  durationMs: number | null;
}

export function resolveLaneCells(lane: PipelineLane): readonly ResolvedCell[];
```

Both renderers then map over one array and choose only *how much* of each `ResolvedCell` to paint.
Dependencies are in-process (DEEPENING §1): merge and test through the new interface directly, with
no DOM — a test that asserts `resolveLaneCells` glosses a degraded cell covers both surfaces at once,
which is precisely what the current shape cannot express.

---

## 3. F2 (HIGH) — the trace and trade joins are the client's domain knowledge, and they live inline in two drawers

`lib/trace.ts` is ten one-line `find`/`filter` wrappers. Judged alone it is **shallow** — its
interface is nearly as large as its implementation, and the deletion test is ambiguous: delete it and
ten `find` calls reappear, which is not much complexity recovered.

But that framing misses where the complexity actually is. The module's own docblock
(`trace.ts:1-19`) carries the real knowledge — *which key joins what, and which joins are exact
versus approximate*:

> `closed_trades[]` carry their `debate_id`, so a closed trade's debate is an exact join; a live
> lane's debate is **NOT** (`DebateRow` has no `trace_id`), so the Live drawer shows the instrument's
> most recent completed debate and says so.

That knowledge is enforced **nowhere**. It is prose in a docblock, and the actual join sequences live
inline in two components:

- `LiveTab.tsx:157-164` — a seven-step dance: lane → traceId → verdict → riskCritic → debate →
  position → fills, plus the `settledOutcome` derivation.
- `ReviewTab.tsx:441-446` — a *different* six-step dance running the other way: trade → debate →
  riskCritic → **traceId (recovered from the critic row)** → verdict → lane → fills.

The second is the subtler one: `ReviewTab` recovers a `trace_id` from the Risk-critic row because
that is the only bridge from a closed trade back to its stage record, and if none is in the
recent-decisions window the Timeline degrades to a named empty state. That is genuine, hard-won
domain reasoning — and it is currently expressible only by rendering a React tree.

**Consequence.** The joins are testable only through `ReviewTab.test.tsx` / `App.test.tsx` with a
DOM. [#1066](https://github.com/dd-jp/samurai-trading-system/issues/1066)-class mis-attribution
bugs — the reason `riskCriticFor` matches on *both* `trace_id` and `instrument` — live exactly here,
in the least-tested layer of the client.

**Proposed interface.** Two deep modules; `lib/trace.ts` becomes their private implementation
(an internal seam, not an exposed one — DEEPENING §"Seam discipline").

```ts
// client/src/lib/resolve-trace.ts
export interface TraceDetail {
  instrument: string;
  traceId: string | null;
  lane: PipelineLane | undefined;
  /** `null` when the lane is absent or idle — the drawer's Timeline gate. */
  cells: readonly ResolvedCell[] | null;
  verdict: VerdictRow | undefined;
  riskCritic: RiskCriticRow | undefined;
  debate: DebateRow | undefined;
  /** How `debate` was found — drives the caveat the drawer prints. */
  debateLinkedBy: 'debate_id' | 'instrument';
  position: PositionRow | undefined;
  fills: readonly FillRow[];
  settled: SettledOutcome | null;
  /** Why a field is absent, when absence has a reason worth printing. */
  absence: { lane: 'aged_out' | 'idle' | 'none' | null };
}

export function resolveTrace(snapshot: WireSnapshot, selection: Selection): TraceDetail;
export function resolveTrade(snapshot: WireSnapshot, idempotencyKey: string): TradeDetail | null;
```

Both drawers become pure renderers of a resolved object. The join logic gains unit tests that cross
its own interface and survive a re-layout of the drawer — **replace, don't layer**: the DOM-level
assertions currently standing in for join tests should be deleted once these exist, not kept
alongside.

---

## 4. F3 (MEDIUM) — a state's word and its colour are two modules that cannot be kept in sync by construction

Every wire enum on this page needs two things: a **word** (`lib/vocabulary.ts`) and a **tone**
(`components/StateWord.tsx`). They are maintained as parallel tables in two files:

| Wire enum | Word | Tone |
|---|---|---|
| `PipelineCellState` | `cellStateWord(state, laneOutcome)` | `cellTone(state)` |
| `EvaluatedConditionWire['state']` | `CONDITION_STATE_WORD` | `CONDITION_TONE` |
| `RiskCriticRow['critic_verdict']` | `criticVerdictWord` | `criticTone` |
| `CloseReason` | `CLOSE_REASON_WORD` | `closeReasonTone` |

The caller performs the join, at every site:

```tsx
<StateWord tone={conditionTone(condition.state)}>{CONDITION_STATE_WORD[condition.state]}</StateWord>
```

That is a **shallow interface**: `StateWord` accepts a tone and a string and knows nothing about how
they relate, so the burden of pairing them correctly falls on 9 `StateWord tone=` call sites.

**The precise defect is not a mis-render** — walking every case, no pair currently reads wrong
(`idle`/`wait`, `not reached`/`wait` and the rest are all fine). It is that **the two tables take
different inputs and therefore cannot be kept in sync by construction**: `cellStateWord(state,
laneOutcome)` is a function of the lane's outcome as well as the cell's state, while `cellTone(state)`
is not. Adding a state, or making a tone outcome-sensitive, is an edit in two files with no compiler
link between them. The dashboard spec's accessibility floor — *"colour is never the sole carrier of a
signal"* — is currently upheld by **convention at every call site**, when it could be structural.

**Proposed interface.** One function per wire enum returning the pair, so the invariant is
unrepresentable-if-violated:

```ts
// client/src/lib/state-presentation.ts
export interface Presented { word: string; tone: StateTone; }

export function presentCell(state: PipelineCellState, laneOutcome: PipelineOutcome): Presented;
export function presentCondition(state: EvaluatedConditionWire['state']): Presented;
export function presentCriticVerdict(v: RiskCriticRow['critic_verdict']): Presented;
export function presentCloseReason(r: CloseReason): Presented;
```

`StateWord`'s interface then narrows to `{ state: Presented; title?: string }` — a caller can no
longer supply a colour without the word that carries the same information. `vocabulary.ts` keeps the
words that have no tone (`OUTCOME_WORD`, `SEAL_GLYPH`, `stageName`, `sideWord`); it is not dissolved.

**Standards fallout:** recorded in `docs/coding-standards.md` in this same change.

---

## 5. F4 (MEDIUM) — `WireSnapshot | null` is propagated to every leaf, so each leaf re-learns the whole wire

`snapshot: WireSnapshot | null` is threaded from `App` down to individual cards, and **22
optional-chain sites** across the non-test client re-derive the same defaults independently:

```
Rail.tsx        12 sites   (generated_at ?? '', tick_status ?? null, llm_spend?.all_time, …)
ReviewTab.tsx    6 sites   (closed_trades ?? [], debates ?? [], metrics ?? null, as_of ?? '', …)
GlanceTab.tsx    2 sites   (positions ?? [], providers.alpaca.balance?.equity ?? null)
LiveTab.tsx      1 site    (pipeline.lanes ?? [])
App.tsx          1 site    (verdicts ?? [])
```

The null policy is **not uniform**, and that is the cost. Some components early-return
`WAITING_FOR_FIRST_SNAPSHOT` (`PnlCard`, `TradeDrawer`); some render an empty list silently
(`AnalystsCard`, `ArmCard` receive `?? []` and cannot tell "no snapshot" from "snapshot with no
rows"); `Rail`'s blocks each invent their own. Every one of ~14 components must learn the full wire
shape *and* the degradation convention — a large interface for a small implementation, at each leaf.

**The clearest evidence is a default that can never fire.** `ReviewTab.tsx:412` passes
`asOf={snapshot?.as_of ?? ''}`, but `TradeRow` is only reached by mapping `trades`, and when
`snapshot === null` `trades` is `[]` — so no row ever renders with `asOf: ''`. *(Traced through
`formatWhen('', …)` to confirm it would also not blank the column: `formatDateUtc('')` is `UNKNOWN`,
the guard returns the real date. It is dead, not dangerous.)* The default exists **purely because the
interface forces every child to accept `WireSnapshot | null`** — defensive code answering a shape
problem, not a data problem.

**Proposed interface.** Gate once, at the composition root, and hand the tabs a non-null snapshot:

```ts
// App.tsx renders the waiting state itself; tabs never see null.
export interface GlanceTabProps { snapshot: WireSnapshot; /* … */ }
export interface LiveTabProps   { snapshot: WireSnapshot; /* … */ }
export interface ReviewTabProps { snapshot: WireSnapshot; /* … */ }
```

Two caveats, both real:

1. **The Rail must keep `| null`.** It renders `WAITING` / `STALE` and is the surface that reports
   *not having* a snapshot; it cannot be gated behind one.
2. This trades ~20 optional chains for **one** decision about what the page shows before the first
   poll. That is a policy choice with an operator-visible consequence, so it belongs in a wayfinder
   grilling question, not in a refactor: *does the whole panel area go to one waiting state, or do
   individual cards each say what they are waiting for?* The current code answers "both,
   inconsistently", which is the least defensible of the three.

---

## 6. F5 (MEDIUM) — the LLM cap denominator is duplicated on both sides of the wire, and the wire does not carry it

`Rail.tsx:8` hardcodes the meter's denominator:

```ts
const LLM_SPEND_CAP_USD = 50;
```

The enforcer's budget is a **separate constant** in `server/apps/orchestrator/paper-profile.ts:1889`
(`llmBudgetUsd: 50`), read as `ProductionConfig.llmBudgetUsd`. `contracts/` carries **no cap field** —
`llm_spend` sends the three spend windows and nothing about what they are measured against. The two
constants agree today and are linked by nothing.

ADR-0008 is explicit that the figure moves: David's own decision quote is *"for paper trading lets
keep 50$ / 14 day budget. **can increase for live trading**"*, and `production.ts:1209` treats
`llmBudgetUsd` as optional configuration that can be raised or left unset entirely (in which case
*"LLM spend is UNCAPPED"*). The first live profile that sets a different budget makes the rail's
meter, its `over cap` word, and its `bad` tone **silently wrong on a live-money surface** — the rail
would report a breach of a cap that is not the cap being enforced, or miss one that is.

This is **latent, not live**: paper is at 50 on both sides today. Filed at MEDIUM for that reason.

**Proposed interface.** The cap is a fact about the run, so it belongs on the wire beside the spend
it bounds:

```ts
// contracts/ — LlmSpendSummary gains:
/** The enforced budget, or `null` when the run is uncapped (`llmBudgetUsd` unset). */
cap_usd: number | null;
```

`SpendBlock` then renders the enforcer's own denominator, and `null` gets an honest word
(`uncapped — no budget configured`) rather than a meter drawn against an imagined 50. Note this is a
**`contracts/` change**, so it is a cross-cutting ticket, not a client-only one.

*(A stronger version of this finding — that the rail divides an all-time figure by a 14-day windowed
cap — was investigated and **falsified**; see §9.)*

---

## 7. F6 (LOW) — `SpendBlock` and `DrawdownBlock` are the same module written twice

`Rail.tsx:155-193` and `Rail.tsx:195-222` both: read an optional figure, divide by a policy constant,
test `Number.isFinite`, render a head with `value / cap`, render either a `Track` or a "meter not
drawable" note, pick a `bad` tone above 1, and print a footnote. The two "not drawable" sentences
have already drifted apart (`no spend figure on this snapshot — meter not drawable` vs `no daily
suite yet — meter not drawable`), which is the drift a shared module prevents by construction.

```ts
// components/CapMeter.tsx
export interface CapMeterProps {
  label: string;
  value: number | undefined;
  cap: number;
  format: (n: number) => string;
  /** Tone below the cap; at or above it the meter always reads `bad`. */
  tone: MeterTone;
  /** What the note says when `value` is undefined — the reason, not a generic string. */
  unavailable: string;
  footnote: React.ReactNode;
}
```

Deliberately **not** collapsed further: the two footnotes carry genuinely different domain content
(unpriced calls and unattributed debate ids; the #798 tolerance choice), so they stay caller-supplied.

---

## 8. F7 (LOW) — `App.tsx` holds two state machines that are only testable through a rendered tree

`App.tsx` is a good composition root, and its docblock correctly identifies its job: state that
outlives a poll. But two of the three pieces are non-trivial *rules*, not just state:

- **Equity sampling** (`App.tsx:68-86`) — a dedupe rule (same `observed_at` **and** same `equity` is
  not a new sample), a finiteness guard, and a 120-sample cap.
- **Ledger accumulation** (`App.tsx:62-66`) — a thin effect, but the pairing of "fold every snapshot"
  with `lib/ledger.ts`'s `seen`-set contract is a rule in its own right.

Both are reachable only by rendering `<App/>`. `lib/ledger.ts` is already a well-tested pure module;
the *hook that drives it* is not.

```ts
// hooks/useEquitySamples.ts
export function useEquitySamples(snapshot: WireSnapshot | null): readonly EquitySample[];
// hooks/useLedger.ts
export function useLedger(snapshot: WireSnapshot | null): readonly LedgerEntry[];
```

In-process dependencies (DEEPENING §1), testable with a hook renderer and no DOM assertions. Small
change, and it makes the composition root read as pure composition.

---

## 9. Falsified during verification — recorded, not filed

Both were plausible, and both are wrong. They are recorded because a future review will re-derive
them from the same surface reading.

**(a) "The rail measures an all-time spend figure against a 14-day windowed cap, so the meter
saturates permanently."** ADR-0008's cap *is* windowed on its face — *"$50 for the whole 14 days"* —
and `SpendBlock` divides `all_time.cost_usd` by 50, which looks like a units error on a live surface.
It is not. `server/pipeline/debate-engine/llm/spend-cap.ts:67` records the decision explicitly:
*"The window is the whole table, deliberately"* — a per-process or rolling baseline *"would hand a
fresh $50 to every restart"*, which a 14-day soak across restarts must not permit. The enforcer sums
the whole table, so **all-time is exactly the enforced quantity** and the rail's denominator matches
its numerator. No defect. What survives is the weaker, real F5: the *number* 50 is duplicated rather
than the *window* being wrong.

**(b) "`asOf={snapshot?.as_of ?? ''}` blanks the Closed column when there is no snapshot."** Traced:
`formatWhen(closed_at, '')` → `formatDateUtc('')` is `UNKNOWN`, but the guard compares it against the
*trade's* day, which is a real date, so the function returns the date rather than `UNKNOWN` — no
blanked column. And it is unreachable regardless (§5). The honest finding is the better one: the
default is dead code that exists only because the interface forces it.

---

## 10. Ranked summary

| # | Sev | Finding | Shape |
|---|---|---|---|
| F1 | **HIGH** | Lane matrix drops #1080's degraded-decision gloss; drawer keeps it | Verified divergence |
| F2 | **HIGH** | Trace/trade joins are inline in two drawers, testable only with a DOM | Missing module |
| F3 | MEDIUM | Word and tone are parallel tables that cannot be synced by construction | Shallow interface |
| F4 | MEDIUM | `WireSnapshot \| null` propagated to every leaf; 22 sites, inconsistent policy | Seam misplaced |
| F5 | MEDIUM | LLM cap constant duplicated across the wire; latent lie if the live budget differs | Missing wire field |
| F6 | LOW | `SpendBlock` / `DrawdownBlock` are one module written twice, already drifting | Duplication |
| F7 | LOW | `App.tsx`'s equity-sampling and ledger rules testable only through a tree | Missing hook seam |

**F1 is the only one that is a defect today.** F5 is the only one that could become one without any
further code change — a live profile with a different `llmBudgetUsd` is enough. F2, F3, F4, F6 and F7
are design debt with no current mis-render, ranked by how much they would cost to leave in place as
the client grows.

**Suggested route.** F1 and F5 are narrow enough to be implementation tickets against this report.
F2, F3 and F4 change interfaces across the component layer and want a wayfinder map first — F4 in
particular carries an operator-facing policy question (§5) that is David's to settle, not a
refactor's.
