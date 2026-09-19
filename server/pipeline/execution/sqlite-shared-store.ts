import type {
  ClosedTrade,
  ExitReason,
  Fill,
  LotHeldQuantity,
  OpenPosition,
  OrderState,
  TradingArm,
} from '../../shared/index.js';
import {
  type FillRow,
  fromFillRow,
  fromOpenPositionRow,
  fromStoredTimestamp,
  fromStoredTimestampOrNull,
  isUniqueConstraintError,
  type OpenPositionRow,
  parseModelledCostBreakdownColumn,
  type StoreHandle,
  TERMINAL_ORDER_STATES,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type {
  FlattenAttribution,
  FlattenSubmissionWriteAhead,
  LotAdvance,
  SharedStore,
  UnprotectedResidualLot,
  UnresolvedFlattenSubmission,
} from './types.js';

const SWEEPABLE_TERMINAL_STATES: readonly OrderState[] = TERMINAL_ORDER_STATES.filter(
  (state) => state !== 'closed' && state !== 'abandoned',
);

const LEG_PREDICATES = Object.freeze({
  entry: "leg = 'entry'",
  exit: "leg != 'entry'",
} as const);

function toSqliteBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function orNull<T>(value: T | undefined): T | null {
  return value ?? null;
}

function nullableStoredTimestamp(
  date: Date | undefined,
): ReturnType<typeof toStoredTimestamp> | null {
  return date === undefined ? null : toStoredTimestamp(date);
}

function nullableJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export class DuplicatePositionError extends Error {
  constructor(readonly idempotency_key: string) {
    super(
      `SqliteExecutionStore.writeAheadPosition: a position already exists for ` +
        `idempotency_key '${idempotency_key}' — execute()'s findByKey gate should ` +
        'have prevented this write.',
    );
    this.name = 'DuplicatePositionError';
  }
}

class DuplicateFlattenSubmissionError extends Error {
  constructor(readonly idempotency_key: string) {
    super(
      `SqliteExecutionStore.writeAheadFlatten: a flatten submission already exists for ` +
        `idempotency_key '${idempotency_key}' — execute()'s findByKey gate should ` +
        'have prevented this write.',
    );
    this.name = 'DuplicateFlattenSubmissionError';
  }
}

export class UnresolvedFlattenForInstrumentError extends Error {
  constructor(
    readonly idempotency_key: string,
    readonly instrument: string,
    readonly blocking_key: string,
  ) {
    super(
      `SqliteExecutionStore.writeAheadFlatten: refusing to journal flatten ` +
        `'${idempotency_key}' — flatten '${blocking_key}' on '${instrument}' is still ` +
        'unresolved, and two live flattens on one instrument can reverse the position (#516).',
    );
    this.name = 'UnresolvedFlattenForInstrumentError';
  }
}

export class SqliteExecutionStore implements SharedStore {
  private readonly arm: TradingArm;

  private readonly sizingCapitalCeiling: number | undefined;

  constructor(
    private readonly db: StoreHandle,
    arm: TradingArm = 'live',
    sizingCapitalCeiling?: number,
  ) {
    this.arm = arm;
    this.sizingCapitalCeiling = sizingCapitalCeiling;
  }

  async findByKey(idempotency_key: string): Promise<boolean> {
    const positionRow = this.db
      .prepare('SELECT 1 FROM open_positions WHERE idempotency_key = ?')
      .get(idempotency_key);
    if (positionRow !== undefined) return true;

    const flattenRow = this.db
      .prepare('SELECT 1 FROM flatten_submissions WHERE idempotency_key = ?')
      .get(idempotency_key);
    return flattenRow !== undefined;
  }

  async writeAheadPosition(position: OpenPosition): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO open_positions (
             idempotency_key, debate_id, instrument, asset_class, side, intent_type,
             requested_size, filled_size, avg_entry_price, stop, target,
             order_state, broker_order_ids, opened_at, decision_timestamp,
             conviction, converged, arm,
             decision_price, quote_bid, quote_ask, quote_mid, quote_observed_at,
             modelled_cost_breakdown_json, modelled_protective_exit_cost_breakdown_json,
             sizing_capital_ceiling
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          position.idempotency_key,
          position.debate_id,
          position.instrument,
          position.asset_class,
          position.side,
          position.intent_type,
          position.requested_size,
          position.filled_size,
          position.avg_entry_price,
          position.stop,
          position.target,
          position.order_state,
          JSON.stringify(position.broker_order_ids),
          toStoredTimestamp(position.opened_at),
          toStoredTimestamp(position.decision_timestamp),
          position.conviction,
          toSqliteBool(position.converged),
          this.arm,
          orNull(position.decision_price),
          orNull(position.quote_bid),
          orNull(position.quote_ask),
          orNull(position.quote_mid),
          nullableStoredTimestamp(position.quote_observed_at),
          nullableJson(position.modelled_cost_breakdown),
          nullableJson(position.modelled_protective_exit_cost_breakdown),
          orNull(this.sizingCapitalCeiling),
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new DuplicatePositionError(position.idempotency_key);
      }
      throw cause;
    }
  }

  async updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE open_positions SET order_state = ?, broker_order_ids = ? WHERE idempotency_key = ?`,
      )
      .run(update.order_state, JSON.stringify(update.broker_order_ids), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.updatePositionState: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  async getOpenPositions(): Promise<OpenPosition[]> {
    const placeholders = TERMINAL_ORDER_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions
          WHERE arm = ? AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(this.arm, ...TERMINAL_ORDER_STATES) as OpenPositionRow[];
    return rows.map(fromOpenPositionRow);
  }

  async sweepTerminalPositions(cutoff: Date): Promise<number> {
    const placeholders = SWEEPABLE_TERMINAL_STATES.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `DELETE FROM open_positions
          WHERE arm = ? AND order_state IN (${placeholders})
            AND filled_size = 0 AND decision_timestamp < ?`,
      )
      .run(this.arm, ...SWEEPABLE_TERMINAL_STATES, toStoredTimestamp(cutoff));
    return result.changes;
  }

  async abandonWedgedZeroFillLot(idempotency_key: string, reason: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET order_state = 'abandoned', abandon_reason = ?
          WHERE arm = ? AND idempotency_key = ?
            AND order_state IN ('filled', 'partially_filled') AND filled_size = 0`,
      )
      .run(reason, this.arm, idempotency_key);
    return result.changes > 0;
  }

  async hasFill({
    idempotency_key,
    broker_fill_id,
  }: Parameters<SharedStore['hasFill']>[0]): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM fills WHERE idempotency_key = ? AND broker_fill_id = ?')
      .get(idempotency_key, broker_fill_id);
    return row !== undefined;
  }

  private insertFill(fill: Fill): void {
    try {
      this.db
        .prepare(
          `INSERT INTO fills (
             idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp, cost_breakdown_json,
             exit_reason, flatten_idempotency_key, fee_currency, fx_rate_to_gbp, fx_rate_to_gbp_source
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fill.idempotency_key,
          fill.broker_fill_id,
          fill.leg,
          fill.price,
          fill.qty,
          fill.fee,
          toStoredTimestamp(fill.timestamp),
          fill.cost_breakdown === undefined ? null : JSON.stringify(fill.cost_breakdown),
          fill.exit_reason ?? null,
          fill.flatten_idempotency_key ?? null,
          fill.fee_currency ?? null,
          fill.fx_rate_to_gbp ?? null,
          fill.fx_rate_to_gbp_source ?? null,
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new Error(
          `SqliteExecutionStore.applyLotAdvance: broker_fill_id '${fill.broker_fill_id}' was ` +
            `already ingested for '${fill.idempotency_key}' — ingestFills()'s hasFill gate should ` +
            'have prevented this write.',
          { cause },
        );
      }
      throw cause;
    }
  }

  async getFills(idempotency_key: string): Promise<Fill[]> {
    const rows = this.db
      .prepare('SELECT * FROM fills WHERE idempotency_key = ? ORDER BY rowid')
      .all(idempotency_key) as FillRow[];
    return rows.map(fromFillRow);
  }

  async getEntryFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return this.fillSizesByLeg(idempotency_keys, 'entry');
  }

  async getExitFillSizes(idempotency_keys: readonly string[]): Promise<Map<string, number>> {
    return this.fillSizesByLeg(idempotency_keys, 'exit');
  }

  private async fillSizesByLeg(
    idempotency_keys: readonly string[],
    side: 'entry' | 'exit',
  ): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (idempotency_keys.length === 0) return sizes;

    const legPredicate = LEG_PREDICATES[side];
    const placeholders = idempotency_keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, SUM(qty) AS qty
           FROM fills
          WHERE idempotency_key IN (${placeholders}) AND ${legPredicate}
          GROUP BY idempotency_key`,
      )
      .all(...idempotency_keys) as { idempotency_key: string; qty: number }[];

    for (const row of rows) {
      sizes.set(row.idempotency_key, row.qty);
    }
    return sizes;
  }

  private updateLotState(
    idempotency_key: string,
    update: { filled_size: number; avg_entry_price: number; order_state: OrderState },
  ): void {
    this.db
      .prepare(
        `UPDATE open_positions
            SET filled_size = ?, avg_entry_price = ?, order_state = ?
          WHERE idempotency_key = ?`,
      )
      .run(update.filled_size, update.avg_entry_price, update.order_state, idempotency_key);
  }

  private insertClosedTrade(trade: ClosedTrade): void {
    try {
      this.db
        .prepare(
          `INSERT INTO closed_trades (
             idempotency_key, debate_id, instrument, asset_class, side,
             entry, stop, filled_size, realized_pnl_net, fees_total,
             opened_at, closed_at, close_reason, arm, sizing_capital_ceiling,
             modelled_cost_charged
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trade.idempotency_key,
          trade.debate_id,
          trade.instrument,
          trade.asset_class,
          trade.side,
          trade.entry,
          trade.stop,
          trade.filled_size,
          trade.realized_pnl_net,
          trade.fees_total,
          toStoredTimestamp(trade.opened_at),
          toStoredTimestamp(trade.closed_at),
          trade.close_reason,
          this.arm,
          this.sizingCapitalCeiling ?? null,
          trade.modelled_cost_charged ? 1 : 0,
        );
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new Error(
          `SqliteExecutionStore.applyLotAdvance: a closed trade already exists for ` +
            `idempotency_key '${trade.idempotency_key}' — a lot closes exactly once, ` +
            'on round-trip-to-flat.',
          { cause },
        );
      }
      throw cause;
    }
  }

  async applyLotAdvance(advance: LotAdvance): Promise<void> {
    this.db.transaction(() => {
      for (const fill of advance.fills) {
        this.insertFill(fill);
      }
      if (advance.position_update !== undefined) {
        this.updateLotState(advance.idempotency_key, advance.position_update);
      }
      if (advance.closed_trade !== undefined) {
        this.insertClosedTrade(advance.closed_trade);
      }
    })();
  }

  async writeAheadFlatten(submission: FlattenSubmissionWriteAhead): Promise<void> {
    try {
      this.db.transaction(() => {
        const blocking = this.db
          .prepare(
            `SELECT idempotency_key FROM flatten_submissions
              WHERE arm = ?
                AND instrument = ?
                AND idempotency_key <> ?
                AND (status = 'submitting'
                 OR (status = 'submitted' AND fills_swept_at IS NULL))
              LIMIT 1`,
          )
          .get(this.arm, submission.instrument, submission.idempotency_key) as
          | { idempotency_key: string }
          | undefined;
        if (blocking !== undefined) {
          throw new UnresolvedFlattenForInstrumentError(
            submission.idempotency_key,
            submission.instrument,
            blocking.idempotency_key,
          );
        }
        this.insertFlattenWriteAhead(submission);
      })();
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new DuplicateFlattenSubmissionError(submission.idempotency_key);
      }
      throw cause;
    }
  }

  private insertFlattenWriteAhead(submission: FlattenSubmissionWriteAhead): void {
    this.db
      .prepare(
        `INSERT INTO flatten_submissions (
             idempotency_key, instrument, asset_class, side, size,
             status, submitted_at, lot_idempotency_keys, lot_held_quantities, exit_reason,
             decision_price, quote_bid, quote_ask, quote_mid, quote_observed_at,
             modelled_cost_breakdown_json, arm
           ) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.idempotency_key,
        submission.instrument,
        submission.asset_class,
        submission.side,
        submission.size,
        toStoredTimestamp(submission.submitted_at),
        JSON.stringify(submission.lot_held_quantities.map((lot) => lot.idempotency_key)),
        JSON.stringify(submission.lot_held_quantities.map((lot) => lot.held)),
        submission.exit_reason,
        submission.decision_price,
        submission.quote_bid,
        submission.quote_ask,
        submission.quote_mid,
        submission.quote_observed_at === null
          ? null
          : toStoredTimestamp(submission.quote_observed_at),
        submission.modelled_cost_breakdown === null
          ? null
          : JSON.stringify(submission.modelled_cost_breakdown),
        this.arm,
      );
  }

  async resolveFlattenSubmitted(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
    resolved_at: Date,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE flatten_submissions
            SET status = 'submitted', order_state = ?, broker_order_ids = ?, resolved_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(
        update.order_state,
        JSON.stringify(update.broker_order_ids),
        toStoredTimestamp(resolved_at),
        idempotency_key,
      );

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenSubmitted: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  async resolveFlattenError(
    idempotency_key: string,
    reason: string,
    resolved_at: Date,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE flatten_submissions
            SET status = 'error', reason = ?, resolved_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(reason, toStoredTimestamp(resolved_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.resolveFlattenError: no write-ahead record for '${idempotency_key}'`,
      );
    }
  }

  async isRetryableFlattenError(idempotency_key: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT status FROM flatten_submissions WHERE idempotency_key = ?')
      .get(idempotency_key) as { status: string } | undefined;
    return row?.status === 'error';
  }

  async getFlattenAttribution(idempotency_key: string): Promise<FlattenAttribution | null> {
    const row = this.db
      .prepare(
        `SELECT lot_idempotency_keys, lot_held_quantities, exit_reason, size,
                instrument, side, modelled_cost_breakdown_json
           FROM flatten_submissions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as
      | {
          lot_idempotency_keys: string | null;
          lot_held_quantities: string | null;
          exit_reason: ExitReason | null;
          size: number;
          instrument: string;
          side: 'buy' | 'sell';
          modelled_cost_breakdown_json: string | null;
        }
      | undefined;
    if (row === undefined || row.lot_idempotency_keys === null) return null;

    const modelledCostBreakdown = parseModelledCostBreakdownColumn(
      row.modelled_cost_breakdown_json,
    );
    const keys = parseFlattenLotKeys(idempotency_key, row.lot_idempotency_keys);
    const lot_held_quantities = parseFlattenHeldQuantities(
      idempotency_key,
      keys,
      row.lot_held_quantities,
    );

    return {
      lot_idempotency_keys: keys,
      lot_held_quantities,
      exit_reason: row.exit_reason,
      instrument: row.instrument,
      side: row.side,
      modelled_cost_breakdown: modelledCostBreakdown,
      size: row.size,
    };
  }

  async getUnresolvedFlattens(): Promise<UnresolvedFlattenSubmission[]> {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, instrument, status, submitted_at, order_state, cancel_attempted_at,
                terminal_unswept_checked_at
           FROM flatten_submissions
          WHERE arm = ?
            AND (status = 'submitting'
             OR (status = 'submitted' AND fills_swept_at IS NULL))`,
      )
      .all(this.arm) as Array<{
      idempotency_key: string;
      instrument: string;
      status: 'submitting' | 'submitted';
      submitted_at: string;
      order_state: OrderState | null;
      cancel_attempted_at: string | null;
      terminal_unswept_checked_at: string | null;
    }>;

    return rows.map((row) => ({
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      status: row.status,
      submitted_at: new Date(row.submitted_at),
      order_state: row.order_state,
      cancel_attempted_at:
        row.cancel_attempted_at === null ? null : new Date(row.cancel_attempted_at),
      terminal_unswept_checked_at:
        row.terminal_unswept_checked_at === null ? null : new Date(row.terminal_unswept_checked_at),
    }));
  }

  async recordFlattenOrderStateObserved(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE flatten_submissions
            SET order_state = ?, broker_order_ids = ?
          WHERE idempotency_key = ?`,
      )
      .run(update.order_state, JSON.stringify(update.broker_order_ids), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.recordFlattenOrderStateObserved: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  async markFlattenCancelAttempted(idempotency_key: string, attempted_at: Date): Promise<void> {
    const result = this.db
      .prepare('UPDATE flatten_submissions SET cancel_attempted_at = ? WHERE idempotency_key = ?')
      .run(toStoredTimestamp(attempted_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenCancelAttempted: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  async markFlattenTerminalUnsweptChecked(
    idempotency_key: string,
    checked_at: Date,
  ): Promise<void> {
    const result = this.db
      .prepare(
        'UPDATE flatten_submissions SET terminal_unswept_checked_at = ? WHERE idempotency_key = ?',
      )
      .run(toStoredTimestamp(checked_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenTerminalUnsweptChecked: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  async markFlattenFillsSwept(idempotency_key: string, swept_at: Date): Promise<void> {
    const result = this.db
      .prepare('UPDATE flatten_submissions SET fills_swept_at = ? WHERE idempotency_key = ?')
      .run(toStoredTimestamp(swept_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markFlattenFillsSwept: no flatten_submissions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  async markResidualUnprotected(idempotency_key: string, observed_at: Date): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_unprotected_since = COALESCE(residual_unprotected_since, ?)
          WHERE idempotency_key = ?`,
      )
      .run(toStoredTimestamp(observed_at), idempotency_key);

    if (result.changes === 0) {
      throw new Error(
        `SqliteExecutionStore.markResidualUnprotected: no open_positions row for ` +
          `'${idempotency_key}'`,
      );
    }
  }

  async confirmResidualProtected(idempotency_key: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE open_positions
            SET residual_unprotected_since = NULL,
                residual_rearm_alerted_at = NULL,
                residual_rearm_unsupported_alerted_at = NULL
          WHERE idempotency_key = ?`,
      )
      .run(idempotency_key);
  }

  async markResidualAlerted(idempotency_key: string, alerted_at: Date): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_rearm_alerted_at = ?
          WHERE idempotency_key = ? AND residual_rearm_alerted_at IS NULL`,
      )
      .run(toStoredTimestamp(alerted_at), idempotency_key);

    return result.changes > 0;
  }

  async markResidualRearmUnsupportedAlerted(
    idempotency_key: string,
    alerted_at: Date,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE open_positions
            SET residual_rearm_unsupported_alerted_at = ?
          WHERE idempotency_key = ? AND residual_rearm_unsupported_alerted_at IS NULL`,
      )
      .run(toStoredTimestamp(alerted_at), idempotency_key);

    return result.changes > 0;
  }

  async getResidualRearmUnsupportedAlertedAt(idempotency_key: string): Promise<Date | null> {
    const row = this.db
      .prepare(
        `SELECT residual_rearm_unsupported_alerted_at
           FROM open_positions WHERE idempotency_key = ?`,
      )
      .get(idempotency_key) as { residual_rearm_unsupported_alerted_at: string | null } | undefined;

    return row === undefined
      ? null
      : fromStoredTimestampOrNull(row.residual_rearm_unsupported_alerted_at);
  }

  async getUnprotectedResidualLots(): Promise<UnprotectedResidualLot[]> {
    const placeholders = TERMINAL_ORDER_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM open_positions
          WHERE arm = ?
            AND residual_unprotected_since IS NOT NULL
            AND order_state NOT IN (${placeholders})
          ORDER BY opened_at`,
      )
      .all(this.arm, ...TERMINAL_ORDER_STATES) as OpenPositionRow[];

    return rows.map((row) => {
      if (row.residual_unprotected_since === null) {
        throw new Error(
          `SqliteExecutionStore.getUnprotectedResidualLots: row '${row.idempotency_key}' ` +
            'matched the marker query but residual_unprotected_since reads NULL',
        );
      }
      return {
        position: fromOpenPositionRow(row),
        unprotected_since: fromStoredTimestamp(row.residual_unprotected_since),
        alerted_at: fromStoredTimestampOrNull(row.residual_rearm_alerted_at),
        rearm_unsupported_alerted_at: fromStoredTimestampOrNull(
          row.residual_rearm_unsupported_alerted_at,
        ),
      };
    });
  }
}

function parseJsonColumn(idempotency_key: string, column: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.${column} for ` +
        `'${idempotency_key}' is not valid JSON`,
      { cause },
    );
  }
}

function parseFlattenLotKeys(idempotency_key: string, raw: string): string[] {
  const keys = parseJsonColumn(idempotency_key, 'lot_idempotency_keys', raw);
  if (!Array.isArray(keys) || !keys.every((entry) => typeof entry === 'string')) {
    throw new Error(
      `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_idempotency_keys for ` +
        `'${idempotency_key}' is not a JSON array of strings`,
    );
  }
  return keys;
}

function parseFlattenHeldQuantities(
  idempotency_key: string,
  keys: readonly string[],
  raw: string | null,
): LotHeldQuantity[] | null {
  if (raw === null) return null;
  const held = parseJsonColumn(idempotency_key, 'lot_held_quantities', raw);
  if (!Array.isArray(held) || held.length !== keys.length) {
    throw new Error(
      `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_held_quantities for ` +
        `'${idempotency_key}' is not a JSON array of one quantity per journalled lot ` +
        `(${keys.length})`,
    );
  }

  const paired: LotHeldQuantity[] = [];
  for (const [index, key] of keys.entries()) {
    const quantity: unknown = held[index];
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
      throw new Error(
        `SqliteExecutionStore.getFlattenAttribution: flatten_submissions.lot_held_quantities ` +
          `for '${idempotency_key}' holds an entry that is not a finite non-negative number`,
      );
    }
    paired.push({ idempotency_key: key, held: quantity });
  }
  return paired;
}
