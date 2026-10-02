import type { BookSpec } from '../../../contracts/index.js';
import type { Clock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { type CycleDeps, type FlattenPassReport, runFlattenPass } from './cycle.js';
import { describeHolder, type RunLease } from './run-lease.js';

export const FLATTEN_POLL_MS = 60_000;

export interface FlattenTarget {
  readonly controlId: number;
  readonly tradingDate: string;
}

export interface FlattenResult {
  readonly outcome: 'closed' | 'failed';
  readonly detail: string;
}

export type FlattenPass =
  | { readonly ran: true; readonly result: FlattenResult }
  | { readonly ran: false; readonly reason: 'lease_held'; readonly detail: string };

interface DueRow {
  control_id: number;
  action: string;
  started_date: string | null;
  finished: number;
}

export class FlattenLedger {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  due(today: string): FlattenTarget | undefined {
    const row = this.db
      .prepare(
        `SELECT c.control_id, c.action, s.trading_date AS started_date,
           EXISTS (SELECT 1 FROM v2_flattens f
                   WHERE f.control_id = c.control_id AND f.event = 'finished') AS finished
         FROM v2_controls c
         LEFT JOIN v2_flattens s ON s.control_id = c.control_id AND s.event = 'started'
         ORDER BY c.control_id DESC LIMIT 1`,
      )
      .get() as DueRow | undefined;
    if (row?.action !== 'halt' || row.finished === 1) return undefined;
    return { controlId: row.control_id, tradingDate: row.started_date ?? today };
  }

  start(target: FlattenTarget): void {
    this.db
      .prepare(
        `INSERT INTO v2_flattens (control_id, event, trading_date, outcome, detail, recorded_at)
         SELECT ?, 'started', ?, NULL, NULL, ?
         WHERE NOT EXISTS (SELECT 1 FROM v2_flattens WHERE control_id = ? AND event = 'started')`,
      )
      .run(target.controlId, target.tradingDate, this.#now(), target.controlId);
  }

  finish(target: FlattenTarget, result: FlattenResult): void {
    this.db
      .prepare(
        `INSERT INTO v2_flattens (control_id, event, trading_date, outcome, detail, recorded_at)
         VALUES (?, 'finished', ?, ?, ?, ?)`,
      )
      .run(target.controlId, target.tradingDate, result.outcome, result.detail, this.#now());
  }

  #now(): string {
    return this.clock.now().toISOString();
  }
}

export interface FlattenDeps {
  readonly cycle: CycleDeps;
  readonly ledger: Pick<FlattenLedger, 'start' | 'finish'>;
  readonly prime: () => Promise<void>;
}

function allBooks(deps: CycleDeps): BookSpec[] {
  return deps.registry.ids().flatMap((sleeveId) => [...deps.books.forSleeve(sleeveId)]);
}

function leftOpen(deps: CycleDeps): string[] {
  return allBooks(deps).flatMap((book) =>
    deps.books
      .positions(book.id)
      .filter((held) => held.exitClientOrderId === undefined)
      .map((held) => `${book.id} ${held.instrument}`),
  );
}

function leftResting(deps: CycleDeps): string[] {
  return allBooks(deps).flatMap((book) =>
    deps.journal.restingEntries(book.id).map((order) => order.client_order_id),
  );
}

function resultOf(deps: CycleDeps, report: FlattenPassReport): FlattenResult {
  const open = leftOpen(deps);
  const resting = leftResting(deps);
  const failures = [
    ...(open.length === 0 ? [] : [`no exit in flight for ${open.join(', ')}`]),
    ...(resting.length === 0 ? [] : [`entries still resting: ${resting.join(', ')}`]),
    ...report.refusals,
  ];
  const summary =
    `cancelled ${report.cancelled} resting entries; ${report.exits} exits: ` +
    `submitted ${report.submitted_orders}, simulated ${report.simulated_orders}, ` +
    `dry-run ${report.dry_run_refusals}, rejected ${report.rejected_orders}`;
  if (open.length === 0 && resting.length === 0) return { outcome: 'closed', detail: summary };
  return { outcome: 'failed', detail: `${summary}; ${failures.join('; ')}` };
}

export async function flattenControl(
  deps: FlattenDeps,
  target: FlattenTarget,
): Promise<FlattenResult> {
  deps.ledger.start(target);
  await deps.prime();
  const report = await runFlattenPass(deps.cycle, target.tradingDate);
  const result = resultOf(deps.cycle, report);
  deps.ledger.finish(target, result);
  const base = {
    trace_id: `v2-flatten-${target.controlId}`,
    stage: 'v2',
    message: `flatten of control ${target.controlId} (${target.tradingDate}): ${result.detail}`,
  };
  if (result.outcome === 'failed') {
    deps.cycle.logger?.log({ ...base, level: 'error', event: 'v2_flatten_leg_failed' });
  } else {
    deps.cycle.logger?.log({ ...base, level: 'info', event: 'v2_flatten_closed' });
  }
  return result;
}

export async function flattenUnderLease(
  lease: Pick<RunLease, 'tryAcquire' | 'current'>,
  deps: FlattenDeps,
  target: FlattenTarget,
): Promise<FlattenPass> {
  const release = lease.tryAcquire('flatten');
  if (release === undefined) {
    return { ran: false, reason: 'lease_held', detail: describeHolder(lease.current()) };
  }
  try {
    return { ran: true, result: await flattenControl(deps, target) };
  } finally {
    release();
  }
}
