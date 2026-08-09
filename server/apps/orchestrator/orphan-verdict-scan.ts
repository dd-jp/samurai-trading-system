/**
 * Orphaned go-verdict scan (#209) — see docs/specs/orchestrator-spec.md.
 * Depends on #201 (`SqliteAuditLog` / `SqliteCurrentTickStore`, merged).
 *
 * Problem: a crash between Verdict emitting a `go` (a `verdict_log` row with
 * `status = 'go'`) and Execution completing the corresponding order leaves
 * that `go` with no matching `audit_log` row at `stage = 'execution'` for the
 * same `trace_id`. Nothing currently notices on restart. `scan()` finds those
 * rows and raises an alert per orphan — it does not retry them.
 *
 * "No matching execution attempt" is read directly off the tick runner's own
 * audit trail: `SequentialTickRunner` (tick-runner.ts) writes one `audit_log`
 * row per stage actually reached in a pass, `'execution'` included. So a
 * `verdict_log` `go` row with zero `audit_log` rows at `stage = 'execution'`
 * for that `trace_id` means Execution was never even invoked for that
 * verdict — exactly the "orphan" this scan targets. Reaching `'execution'`
 * with a failed attempt is a distinct, already-detectable Execution-side
 * failure mode, not this scan's job.
 *
 * AC2 ("orphaned entries are never auto-resubmitted to Execution") holds by
 * construction, not by a guard: this file has no import of, or call into,
 * anything in `../execution/`. There is no code path here by which an orphan
 * could be resubmitted even if a caller wanted that — the absence itself is
 * the mechanism.
 *
 * Matching is by `trace_id` only — `audit_log` carries no `idempotency_key`
 * column, so there is nothing else to join on. `idempotency_key` is still
 * carried on `OrphanGoVerdict` (read off `verdict_log`), for the human/
 * broker-side lookup an alert recipient needs — it is not part of the match.
 *
 * No time bound: every unalerted historical orphan is reported, not just
 * ones inside "the current tick window" (the ticket's phrasing). There is no
 * alert-dedup/acknowledgement table in the schema, so a bounded scan would
 * either need one (out of scope here) or risk silently dropping an orphan
 * that aged past the window before anyone restarted the process — worse than
 * one noisy restart. A caller wanting a bound can pre-filter by trace_id
 * before calling `scan`, or a future ticket can add a `since` parameter
 * backed by a dedup table.
 *
 * Alert delivery mirrors `Heartbeat.emit`'s discipline (heartbeat.ts): a
 * channel failure for one orphan must not stop the scan from alerting on
 * (and returning) the rest. It is logged, not thrown — under a synthetic
 * `stage: 'orphan-verdict-scan'`, the same non-`TickStage` convention
 * `Heartbeat` uses for `'heartbeat'`, since the failure happened in this
 * scan, not in the Verdict pipeline stage.
 */
import type { SharedStore } from '../../shared/store/index.js';
import type { Logger } from './types.js';

/** One `verdict_log` `go` row with no corresponding `execution`-stage `audit_log` row. */
export interface OrphanGoVerdict {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  verdict_timestamp: Date;
}

/** The notification surface this scan needs — a fire-and-forget alert, not an
 * approval round-trip (see `ApprovalChannel` in verdict/types.ts for that shape,
 * which does not fit here: there is nothing to approve or reject). */
export interface OrphanAlertChannel {
  postOrphanAlert(orphan: OrphanGoVerdict): Promise<void>;
}

interface OrphanRow {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  timestamp: string;
}

/**
 * Scans `verdict_log`/`audit_log` for orphaned `go` verdicts, alerts on each
 * one found via `channel`, and returns the full list. Called once at startup
 * by the production composition root (`production.ts`'s
 * `buildProductionOrchestrator().start()`, #236) before the tick loop begins
 * — it must read the audit trail before this run starts writing to it.
 * Still callable directly by any other operator tool that wants the same
 * read-only report.
 */
export class OrphanVerdictScanner {
  async scan(
    db: SharedStore,
    channel: OrphanAlertChannel,
    logger: Logger,
  ): Promise<OrphanGoVerdict[]> {
    const rows = db
      .prepare(
        `SELECT trace_id, idempotency_key, instrument, timestamp
           FROM verdict_log
          WHERE status = 'go'
            AND NOT EXISTS (
              SELECT 1 FROM audit_log
               WHERE audit_log.trace_id = verdict_log.trace_id
                 AND audit_log.stage = 'execution'
            )
          ORDER BY timestamp, trace_id`,
      )
      .all() as OrphanRow[];

    const orphans: OrphanGoVerdict[] = rows.map((row) => ({
      trace_id: row.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      verdict_timestamp: new Date(row.timestamp),
    }));

    for (const orphan of orphans) {
      try {
        await channel.postOrphanAlert(orphan);
      } catch (error) {
        logger.log({
          trace_id: orphan.trace_id,
          stage: 'orphan-verdict-scan',
          level: 'error',
          message: 'orphan go-verdict alert failed',
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    return orphans;
  }
}
