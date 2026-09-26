import {
  CONTROL_REASON_MAX_CHARS,
  type ControlAction,
  type ControlRequestWire,
  type ControlRowWire,
} from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

export const CONTROL_MIN_INTERVAL_MS = 10_000;
const CONTROL_ACTIONS: readonly unknown[] = ['pause', 'halt', 'resume'] satisfies ControlAction[];
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const REQUEST_FIELDS = new Set(['action', 'reason', 'idempotency_key']);

export type ParsedControlRequest =
  | { readonly ok: true; readonly request: ControlRequestWire }
  | { readonly ok: false; readonly reason: string };

export type ControlWriteResult =
  | { readonly kind: 'created' | 'replayed'; readonly control: ControlRowWire }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number };

type Fields = Readonly<Record<string, unknown>>;

const FIELD_CHECKS: readonly (readonly [(fields: Fields) => boolean, string])[] = [
  [(fields) => CONTROL_ACTIONS.includes(fields.action), 'action must be pause, halt or resume'],
  [
    (fields) => typeof fields.reason === 'string' && fields.reason.trim() !== '',
    'reason is required',
  ],
  [
    (fields) => String(fields.reason).trim().length <= CONTROL_REASON_MAX_CHARS,
    `reason is longer than ${CONTROL_REASON_MAX_CHARS} characters`,
  ],
  [
    (fields) =>
      typeof fields.idempotency_key === 'string' && IDEMPOTENCY_KEY.test(fields.idempotency_key),
    'idempotency_key must be 8-128 letters, digits, - or _',
  ],
];

function isFields(body: unknown): body is Fields {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

export function parseControlRequest(body: unknown): ParsedControlRequest {
  if (!isFields(body)) return { ok: false, reason: 'body must be a JSON object' };
  const unexpected = Object.keys(body).filter((key) => !REQUEST_FIELDS.has(key));
  if (unexpected.length > 0) {
    return { ok: false, reason: `unexpected field(s): ${unexpected.join(', ')}` };
  }
  const failed = FIELD_CHECKS.find(([passes]) => !passes(body));
  if (failed !== undefined) return { ok: false, reason: failed[1] };
  return {
    ok: true,
    request: {
      action: body.action as ControlAction,
      reason: String(body.reason).trim(),
      idempotency_key: String(body.idempotency_key),
    },
  };
}

const ROW_COLUMNS = 'control_id, action, reason, source, set_at';

function sameRequest(row: ControlRowWire, request: ControlRequestWire): boolean {
  return row.action === request.action && row.reason === request.reason;
}

export class ControlWriter {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  write(request: ControlRequestWire, source: string): ControlWriteResult {
    return this.db.transaction(() => this.writeInTransaction(request, source)).immediate();
  }

  private writeInTransaction(request: ControlRequestWire, source: string): ControlWriteResult {
    const existing = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM v2_controls WHERE idempotency_key = ?`)
      .get(request.idempotency_key) as ControlRowWire | undefined;
    if (existing !== undefined) {
      return sameRequest(existing, request)
        ? { kind: 'replayed', control: existing }
        : { kind: 'conflict', reason: 'idempotency_key was already used for a different control' };
    }
    const now = this.clock.now();
    const waitMs = this.waitBeforeNextMs(now);
    if (waitMs > 0) return { kind: 'too-soon', retryAfterSeconds: Math.ceil(waitMs / 1_000) };
    const setAt = now.toISOString();
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(request.action, request.reason, source, request.idempotency_key, setAt);
    return {
      kind: 'created',
      control: {
        control_id: Number(lastInsertRowid),
        action: request.action,
        reason: request.reason,
        source,
        set_at: setAt,
      },
    };
  }

  private waitBeforeNextMs(now: Date): number {
    const latest = this.db
      .prepare('SELECT set_at FROM v2_controls ORDER BY control_id DESC LIMIT 1')
      .get() as { set_at: string } | undefined;
    if (latest === undefined) return 0;
    const elapsedMs = now.getTime() - Date.parse(latest.set_at);
    // A clock stepped backwards would otherwise block every control, a halt included, until
    // the wall clock caught up with the last set_at
    if (elapsedMs < 0) return 0;
    return CONTROL_MIN_INTERVAL_MS - elapsedMs;
  }
}
