# Infra / Ops Track — Consolidated

**Created:** 2026-08-08 (consolidation). Navigation + summary; individual docs remain authoritative (see `README.md`).

## Paper-soak readiness (`12-soak-readiness-2026-08-06.md`) — GATE PASS

| Check | Result |
|---|---|
| `yarn typecheck` / `lint` / `build` | 0 errors |
| `yarn vitest run` | 2282 passed, 1 skipped |
| `yarn smoke` | PASS — full 6-stage transaction, fill ingested |
| `paperStartingProfile.llmBudgetUsd` | 50 (ADR-0008: $50/14d) |
| `paperStartingProfile.tickIntervalMs` | 15 min (~296 instrument-passes/day, ≈$42 projected) |

Three things true before starting #238, none a build defect: (per doc — the system boots, transacts end-to-end, and is configured to ADR-0008's budget).

## Dashboard (`13-dashboard-framework-and-hosting-2026-08-06.md` + ADR-0010)

- Resolved the open question in `techstack.md` (framework if dashboard grows past one static page).
- Decision: Vite + React rewrite (ADR-0010 `0010-dashboard-vite-react-rewrite.md`); single-operator console on localhost, no public surface, exposure (if any) behind Cloudflare Zero Trust / Tailscale.
- Doc 13's key findings: the premise was right, the diagnosis off by one, hosting question is not a hosting question (see doc for the full reasoning — it locks nothing per Standing Pipeline Rule 1, it is evidence to grill against).

## Stack (`techstack.md`)

Living reference — libraries, versions, why-chosen. Update as stack choices lock in.

## Historical

- `trading-agent-handover.md` (2026-07) — scoping brief: crypto + stocks, UK hosting, Mac server, Kraken/IBKR, ccxt. Superseded in detail by ADRs/specs; kept for origin context.
