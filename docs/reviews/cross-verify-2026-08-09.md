# Cross-Spec Verification Pass — 2026-08-09

**Scope.** All 18 specs in `docs/specs/`, `CONTEXT.md`, and `docs/adr/`. Two jobs in one pass:

1. **Drain the three prior passes.** `cross-verify-2026-07-26.md`, `-07-28.md` and `-07-31.md` held 17 findings with no living home. Every one was re-verified against current code and specs; the survivors are consolidated here and into `../specs/cross-spec-contracts.md`.
2. **Verify the specs against [ADR-0013](../adr/0013-no-human-gate-anywhere.md)**, accepted this date, which removes every remaining human gate.

**Filing change.** The three prior passes lived in `docs/specs/`, which CLAUDE.md's Docs Convention reserves for `<stage>-spec.md` PRDs while giving dated audit reports to `docs/reviews/`. They are moved here in this change, drained rather than deleted — `shared-sqlite-store-spec.md:393` cites the 2026-07-26 pass by path as the provenance for `verdict_log`, so they remain the audit trail and are preserved verbatim apart from a superseded-by pointer. This closes finding F9 of [`spec-research-alignment-2026-08-09.md`](spec-research-alignment-2026-08-09.md).

---

## Part 1 — disposition of the 17 prior findings

**Resolved since they were written (4) — not re-filed:**

| Finding | Closed by |
|---|---|
| 26-GAP-4 — dashboard `*Row` types had no source; no Verdict table | `verdict_log` added per [#206](../../issues/206); `shared-sqlite-store-spec.md:393` names the finding it closes |
| 26-security — no `breaker_state` table | Added per [#203](../../issues/203); 4 references in the store spec |
| 31-GAP-7 — `peak_equity` had no durable home | Fixed in that pass; `account_state` table added |
| 31-GAP-8 — blended `daily_pnl_pct` from Alpaca's `last_equity` | [#332](../../issues/332); `session_equity` table, per-asset-class |

**Still live (13).** Verified individually against current files, not assumed from the prior write-up:

| # | Finding | Evidence at this date |
|---|---|---|
| **CV-1** | Three specs' `mode` union lacks `'paper'` | `risk-manager-spec.md:89`, `verdict-spec.md:91`, `feedback-loop-spec.md:92` all `'live' \| 'backtest'`. **Partly dissolved by ADR-0013** — see Part 2 |
| **CV-2** | Risk has no stated behaviour on upstream read failure | 0 matches for "fail closed" in the spec that bills itself "must be trusted absolutely under stress" |
| **CV-3** | Kill-line and breaker thresholds are config, not fixed constants (was 28-GAP-6) | `cost-model-backtest-spec.md` still lists "the PBO threshold value" as config. **Escalated to blocking** — see Part 2 |
| **CV-4** | `risk-manager-spec.md:11` "fully mechanical and deterministic" contradicts its own Risk Critic LLM step | Unchanged |
| **CV-5** | `risk-manager-spec.md:77` `// Fully deterministic given its inputs.` — same contradiction at the interface | Unchanged |
| **CV-6** | `stale_feed` gate described as live by two specs, absent from Verdict | 0 matches in `verdict-spec.md`; `market-data-service-spec.md` and the registry §3 both describe it |
| **CV-7** | `Direction` undefined at spec level; `debate-engine-spec.md:126` hand-rolls the union | 0 matches for `type Direction` in `cross-spec-contracts.md`. **Code has it, and [#627](../../issues/627) improved on it** — `Direction` now lives in `contracts/primitives.ts:22`, a canonical shared home, which is exactly what this finding asked for at code level. The spec registry still does not name it, so the drift is spec-only and narrower than when filed |
| **CV-8** | Registry lists `ClosedTrade` as a dashboard read source; the dashboard never reads it | 0 matches in `dashboard-spec.md` |
| **CV-9** | `trader-spec.md` still says `DebateResult.direction`/`debate_id` "must be reconciled" | Reconciled long ago on the Debate Engine side |
| **CV-10** | `trader-spec.md` specs position-aware branching as MVP; [#224](../../issues/224) deferred it | The only "deferred" match in the file (`:282`) is unrelated |
| **CV-11** | `trader-spec.md:233` tests a `flip` routing case its `intent_type` union does not contain | Unchanged |
| **CV-12** | `risk-manager-spec.md` stale "v1 static concentration buckets" reference | Superseded by the dynamic correlation matrix in the same spec |
| **CV-13** | `AlpacaClient` names two unrelated interfaces; no transport↔`BrokerAdapter` cross-reference; `DateRange` consumed by three specs, defined by none (31-GAP-9/10/11) | Two `export interface AlpacaClient` in `src/`; 0 `BrokerAdapter` in `transport-layer-spec.md`; 0 `DateRange` in the registry |

**Moot (1):** 26-security's `ApprovalChannel` authn/authz gap. Nothing authorises a decision any more. But see CV-14 — the channel's *alerting* job is now more important, not less.

---

## Part 2 — new findings, this pass

### CV-14 — HIGH. One field, two jobs: removing the approval gate would silently remove breach alerting

`feedback-loop-spec.md:91`:

```ts
approvals: ApprovalChannel;   // for gated risk-threshold loosening + breach alerts
```

`ApprovalChannel` is a single type with a single method (`server/pipeline/verdict/types.ts:44`, `requestApproval`). ADR-0013 removes the **gated loosening**. If the field goes with it, **breach alerting goes too** — and under full automation that alert is the only way an operator ever learns the edge died.

This is the repo's documented dominant defect shape in advance: a control that reads as present while doing nothing. The two concerns must be split before the gate is removed in code, not after.

### CV-15 — HIGH, blocking. With no approval gate, the threshold clamp is the only remaining control

This is CV-3 re-ranked rather than a new observation, and the re-ranking is the finding. ADR-0007 said "the breakers are now the only stop." ADR-0013 goes further: **the numeric thresholds are now the only stop**, because nothing re-arms by hand and nothing gates a loosening.

`risk-manager-spec.md` says "all caps and breaker thresholds are config, tuned in paper trading; not fixed here." `cost-model-backtest-spec.md` lists the PBO threshold value as config while its body states "Reject if PBO > 0.05" as though fixed. So **a config edit is now the entire distance between the running system and an arbitrary risk limit.**

The clamp the 2026-07-28 pass asked for — config values hard-limited in code so no setting can cross the research-mandated line — is a **precondition of ADR-0013 being safe**, not a tidiness item. Filed as a blocker on the live path.

### CV-16 — MEDIUM. Two specs still route decisions to a human

Both fixed in this change, recorded because they show the propagation surface an ADR leaves behind:

- `debate-engine-spec.md:415–416` — a non-converged debate routed to "Risk Manager: may require **manual approval**" and "Verdict: may defer execution or require **human review**." Neither path exists. Rewritten to the mechanical response (the Trader's existing non-convergence haircut).
- `cost-model-backtest-spec.md:309` — "FL owns the live cadence and the **human-owned** kill decision." Amended; the ownership boundary is unchanged, only the actor.

`cross-spec-contracts.md:53` carried the same "human-owned kill" phrase and is amended alongside.

### CV-17 — LOW. `TELEGRAM_ALLOWED_USER_IDS` is validated at boot for a gate that cannot fire

ADR-0007 left this as an explicit loose end. ADR-0013 closes the question: with no approval anywhere, the allowlist has nothing to authorise. The transport itself **stays** — it is the alerting path (CV-14). The boot requirement should be relaxed to "required only if an approval transport is ever re-armed."

### CV-19 — HIGH. The client/server/contracts split left ~180 dead `src/` citations across 44 docs

[#627](../../issues/627) landed between this pass starting and finishing. It split `src/` into `client/`, `server/` and `contracts/` — **`src/` no longer exists** — and every documentation reference to a `src/…` path died with it: **~180 references across 44 files** in `docs/`, `CONTEXT.md` and `CLAUDE.md`.

No link checker catches these. They are inline path citations in backticks, not markdown links, so they fail exactly the way [#626](../../issues/626)'s bare-filename problem did — one directory level up, and for the same reason.

**Line numbers drifted too**, so a path-only sweep would land on the wrong lines while looking correct. Two confirmed: `ApprovalChannel` moved `src/verdict/types.ts:41` → `server/pipeline/verdict/types.ts:44`; `type Direction` left `src/debate-engine/types.ts:13` entirely for `contracts/primitives.ts:22`.

This matters beyond tidiness — ADR-0007 cites `src/verdict/index.ts` and `src/orchestrator/tick-loop.ts` as the evidence for its central serialization argument, and a reader who cannot resolve those cannot check the reasoning.

Filed as [#645](../../issues/645), including the full path mapping and a request to extend the link checker so the next refactor fails loudly. **The documents authored in this pass are already correct and re-verified against the new layout.**

---

### CV-18 — Confirmed clean, checked because it looked like a contradiction

`execution-spec.md:316` keeps a **manual sign-off** for the broker cutover (Alpaca → ccxt/IBKR), and already carries an explicit rationale for surviving ADR-0007: a broker swap is an infrequent operator action *outside* the tick loop, not a per-trade gate inside it. **That reasoning holds under ADR-0013 too**, whose subject is gates in the trading loop. Re-affirmed rather than changed.

Also clean: `dashboard-spec.md:99` and `:176` already treat the HITL badge as expected-never-to-fire with an ADR-0007 citation; `devils-advocate-spec.md:259` correctly states the HITL path is structurally unreachable.

### CV-1 revisited — partly dissolved

ADR-0013 makes breaker re-arm automatic in **all** modes, which removes the sharpest edge of CV-1: the question "what does `paper` inherit on a safety-relevant switch" no longer has a live-vs-backtest fork to inherit from. What remains is narrower — the `mode` unions still omit `'paper'` while `execution-spec.md:103` includes it and the store provisions one DB file per environment, so the type still lies about the environments the system runs in. Downgraded from safety-relevant to type-accuracy.

---

## Where these live now

Findings are registered in [`../specs/cross-spec-contracts.md`](../specs/cross-spec-contracts.md) — the living register they should have been feeding from the start. This document is the pass record. The three prior passes are archived beside it, drained.
