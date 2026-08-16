# Review index — Samurai

Audit and review reports. **Nothing here is deleted** — a report whose findings are all closed, or
whose substance has been folded into a successor document, moves to [`archive/`](archive/) with a
pointer to that successor. The reports are the audit trail behind live-money decisions, and live
code, specs and `docs/coding-standards.md` cite individual findings by ID.

## Conventions

- **File name is `<topic>-<date>.md`** (CLAUDE.md Docs Convention), in both the live directory and
  `archive/`. Unlike `docs/research/`, archived reviews are *not* renamed — a review is a dated
  artifact already, and finding IDs are cited from code by file name.
- **Findings are ranked, and prior findings are referenced rather than re-filed.** A new review
  states which earlier reports it does not re-litigate.
- **Standards fallout goes to `docs/coding-standards.md` in the same change.**
- **Archive, never delete.** Move a report only when every finding is closed *or* a named successor
  carries the substance, and record that pointer in the report itself — not only here — so a reader
  arriving from a stale link is not misled.

## Live reports

| Report | Subject | Status |
|---|---|---|
| [`indicator-characterisation-2026-08-16.md`](indicator-characterisation-2026-08-16.md) | What `computeIndicator` actually computes, against an independent reference | **OPEN** — F1/F2: the live RSI(14) is the unsmoothed seed, and the missing warm-up flips the analyst's classification on ~18% of bars. F2 owned by #703 step B2 |
| [`spec-research-alignment-2026-08-09.md`](spec-research-alignment-2026-08-09.md) | All 21 `docs/specs/` files + `CONTEXT.md` against the Stage 0 research layer (docs 10–15) | **OPEN** — F1 is cited by `CONTEXT.md:47`; decisions run through #631/#632 |
| [`orchestrator-dashboard-architecture-2026-08-07.md`](orchestrator-dashboard-architecture-2026-08-07.md) | Is the architecture good enough for the orchestrator + dashboard | Verdict: good bones, targeted refactors. No re-architecture |
| [`triage-2026-08-06.md`](triage-2026-08-06.md) | Which findings of the three earlier audits survive 54 commits | **The entry point** to the two 08-05 audits. F-5/F-9/F-10 cited from code and specs |
| [`codebase-review-2026-08-06.md`](codebase-review-2026-08-06.md) | Full-codebase hostile review: architecture, data/API cost flow, complexity | Its Polygon premise correction is cited by `server/shared/http/venue-pacing.ts` |
| [`spec-conformance-2026-08-05.md`](spec-conformance-2026-08-05.md) | Implementation vs specs | Survivors tracked in `triage-2026-08-06.md`; read that first |
| [`code-quality-2026-08-05.md`](code-quality-2026-08-05.md) | Duplication, performance, efficiency | Survivors tracked in `triage-2026-08-06.md`. Its comments-carry-reasons ruling is cited by `docs/coding-standards.md:91` |

## Archived

| Report | Why archived | Successor |
|---|---|---|
| [`archive/paper-trading-readiness-2026-08-03.md`](archive/paper-trading-readiness-2026-08-03.md) | Every item closed, verified at `9b026c4` against call sites | [`triage-2026-08-06.md`](triage-2026-08-06.md) — its surviving Tier-2 item 6 is owned there as F-7 |
| [`archive/edge-hypothesis-evaluation-audit-2026-08-08.md`](archive/edge-hypothesis-evaluation-audit-2026-08-08.md) | Its D1–D7 corrections were folded into the consolidated critique | [`../research/12-edge-hypothesis-critique.md`](../research/12-edge-hypothesis-critique.md) — which cites this audit as the source of record |
