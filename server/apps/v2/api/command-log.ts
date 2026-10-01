import type { Clock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';

export type CommandOutcome =
  | 'applied'
  | 'noop'
  | 'answered'
  | 'confirmation_requested'
  | 'confirmation_refused'
  | 'refused_unauthorized'
  | 'refused_stale'
  | 'refused_too_soon'
  | 'refused_invalid'
  | 'failed';

export interface CommandRecord {
  readonly updateId: number;
  readonly chatId: string;
  readonly command: string;
  readonly outcome: CommandOutcome;
  readonly detail: string;
  readonly controlId?: number | undefined;
  readonly sentAt: Date;
}

const COMMAND_MAX_CHARS = 32;

export class CommandLog {
  constructor(
    private readonly db: StoreHandle,
    private readonly clock: Clock,
  ) {}

  has(updateId: number): boolean {
    return (
      this.db.prepare('SELECT 1 FROM v2_commands WHERE update_id = ?').get(updateId) !== undefined
    );
  }

  refusedSince(chatId: string, since: Date): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM v2_commands
            WHERE chat_id = ? AND outcome = 'refused_unauthorized' AND handled_at >= ?
            LIMIT 1`,
        )
        .get(chatId, since.toISOString()) !== undefined
    );
  }

  record(entry: CommandRecord): void {
    this.db
      .prepare(
        `INSERT INTO v2_commands
           (update_id, chat_id, command, outcome, detail, control_id, sent_at, handled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.updateId,
        entry.chatId,
        entry.command.slice(0, COMMAND_MAX_CHARS),
        entry.outcome,
        entry.detail,
        entry.controlId ?? null,
        entry.sentAt.toISOString(),
        this.clock.now().toISOString(),
      );
  }
}
