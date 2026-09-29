import type { ControlAction, ManualControl, V2OverviewWire } from '../../../../contracts/index.js';
import { type Clock, describeThrownSafely, sanitizeLogText } from '../../../shared/index.js';
import type { CommandOutcome, CommandRecord } from './command-log.js';
import { type ControlWriteResult, parseControlRequest } from './control-writer.js';
import { formatStatus } from './telegram-status.js';

const CONTROL_SOURCE = 'telegram';
export const STALE_AFTER_MS = 10 * 60_000;
export const CONFIRM_WINDOW_MS = 5 * 60_000;

export interface TelegramMessage {
  readonly date: number;
  readonly text?: string | undefined;
  readonly chat: { readonly id: number; readonly type: string };
  readonly from?: { readonly id: number } | undefined;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage | undefined;
}

export interface CommandDeps {
  readonly ownerChatId: number;
  readonly clock: Clock;
  readonly controls: {
    write(
      request: { action: ControlAction; reason: string; idempotency_key: string },
      source: string,
    ): ControlWriteResult;
  };
  readonly current: () => ManualControl;
  readonly overview: () => Promise<V2OverviewWire>;
  readonly log: {
    has(updateId: number): boolean;
    record(entry: CommandRecord): void;
  };
  readonly newCode: () => string;
}

interface Received {
  readonly updateId: number;
  readonly sentAt: Date;
  readonly args: string;
}

interface Outcome {
  readonly outcome: CommandOutcome;
  readonly reply: string;
  readonly controlId?: number | undefined;
}

type Command = (received: Received) => Outcome | Promise<Outcome>;

interface PendingFlatten {
  readonly code: string;
  readonly requestedAtMs: number;
}

const HELP =
  'Commands: status, halt (block new entries), resume, flatten (close every position, asks for a code).';

function parseCommand(text: string): { name: string; args: string } {
  const [head = '', ...rest] = text.trim().split(/\s+/);
  const name = head.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
  return { name, args: rest.join(' ') };
}

function reasonFor(command: string, args: string): string {
  return args === '' ? `Telegram ${command} command` : args;
}

export class CommandHandler {
  #pending: PendingFlatten | undefined;

  private readonly commands = new Map<string, Command>([
    ['status', () => this.status()],
    ['halt', (received) => this.pause(received)],
    ['resume', (received) => this.resume(received)],
    ['flatten', (received) => this.flatten(received)],
  ]);

  constructor(private readonly deps: CommandDeps) {}

  async handle(update: TelegramUpdate): Promise<string | undefined> {
    const { message } = update;
    if (message?.text === undefined || this.deps.log.has(update.update_id)) return undefined;
    const sentAt = new Date(message.date * 1_000);
    const { name, args } = parseCommand(message.text);
    const base = {
      updateId: update.update_id,
      chatId: String(message.chat.id),
      command: name,
      sentAt,
    };
    if (!this.isOwner(message)) {
      this.deps.log.record({
        ...base,
        outcome: 'refused_unauthorized',
        detail: 'not the owner chat',
      });
      return undefined;
    }
    const result = this.isStale(sentAt)
      ? STALE
      : await this.run(name, { updateId: update.update_id, sentAt, args });
    this.deps.log.record({
      ...base,
      outcome: result.outcome,
      detail: result.reply,
      controlId: result.controlId,
    });
    return result.reply;
  }

  private isOwner(message: TelegramMessage): boolean {
    const owner = this.deps.ownerChatId;
    return (
      message.chat.type === 'private' && message.chat.id === owner && message.from?.id === owner
    );
  }

  private isStale(sentAt: Date): boolean {
    return this.deps.clock.now().getTime() - sentAt.getTime() > STALE_AFTER_MS;
  }

  private async run(name: string, received: Received): Promise<Outcome> {
    if (name !== 'flatten') this.#pending = undefined;
    const command = this.commands.get(name);
    if (command === undefined) {
      return { outcome: 'refused_invalid', reply: `Unknown command. ${HELP}` };
    }
    try {
      return await command(received);
    } catch (error) {
      const cause = sanitizeLogText(describeThrownSafely(error));
      return {
        outcome: 'failed',
        reply: `Command failed: ${cause}. Check status before retrying.`,
      };
    }
  }

  private async status(): Promise<Outcome> {
    return { outcome: 'answered', reply: formatStatus(await this.deps.overview()) };
  }

  private pause(received: Received): Outcome {
    const { state } = this.deps.current();
    if (state === 'paused') return noop('Already paused: new entries are blocked.');
    if (state === 'halted') {
      return noop('Already halted (flatten in force): a pause would weaken it. Send resume first.');
    }
    return this.write(
      'pause',
      reasonFor('halt', received.args),
      received,
      'Paused: no new entries from the next cycle. Open positions keep their resting stops.',
    );
  }

  private async resume(received: Received): Promise<Outcome> {
    if (this.deps.current().state === 'running') return noop('Already running.');
    const written = this.write(
      'resume',
      reasonFor('resume', received.args),
      received,
      'Resumed: entries are allowed again from the next cycle.',
    );
    if (written.outcome !== 'applied') return written;
    return { ...written, reply: `${written.reply}${await this.lossBudgetNote()}` };
  }

  private async lossBudgetNote(): Promise<string> {
    try {
      const { control } = await this.deps.overview();
      if (control.loss_budget_halted_books.length === 0) return '';
      return ` The loss-budget halt is still in force on ${control.loss_budget_halted_books.join(', ')}; resume never lifts it.`;
    } catch {
      return ' Loss-budget state could not be read: send status.';
    }
  }

  private flatten(received: Received): Outcome {
    if (this.deps.current().state === 'halted') {
      return noop('Already halted: every open position closes at the next cycle.');
    }
    return received.args === '' ? this.requestFlatten(received) : this.confirmFlatten(received);
  }

  private requestFlatten(received: Received): Outcome {
    const code = this.deps.newCode();
    this.#pending = { code, requestedAtMs: received.sentAt.getTime() };
    return {
      outcome: 'confirmation_requested',
      reply: `Flatten closes every open position at the next cycle and blocks new entries until resume. Nothing happens yet. To confirm within 5 minutes send: flatten ${code}`,
    };
  }

  private confirmFlatten(received: Received): Outcome {
    const pending = this.#pending;
    const valid =
      pending !== undefined &&
      pending.code === received.args &&
      received.sentAt.getTime() - pending.requestedAtMs <= CONFIRM_WINDOW_MS;
    if (!valid) {
      this.#pending = undefined;
      return {
        outcome: 'confirmation_refused',
        reply:
          'Flatten not confirmed: no matching code, or it expired. Nothing changed. Send flatten to start again.',
      };
    }
    const written = this.write(
      'halt',
      'Telegram flatten confirmed',
      received,
      'Flatten recorded: every open position closes at the next cycle and entries stay blocked until resume.',
    );
    if (written.outcome !== 'refused_too_soon') this.#pending = undefined;
    return written;
  }

  private write(
    action: ControlAction,
    reason: string,
    received: Received,
    applied: string,
  ): Outcome {
    const parsed = parseControlRequest({
      action,
      reason,
      idempotency_key: `telegram-${received.updateId}`,
    });
    if (!parsed.ok) return { outcome: 'refused_invalid', reply: `Refused: ${parsed.reason}.` };
    const result = this.deps.controls.write(parsed.request, CONTROL_SOURCE);
    if (result.kind === 'too-soon') {
      return {
        outcome: 'refused_too_soon',
        reply: `Refused: another control was set less than 10 seconds ago. Resend in ${result.retryAfterSeconds} s.`,
      };
    }
    if (result.kind === 'conflict')
      return { outcome: 'failed', reply: `Refused: ${result.reason}.` };
    return { outcome: 'applied', reply: applied, controlId: result.control.control_id };
  }
}

const STALE: Outcome = {
  outcome: 'refused_stale',
  reply: 'Ignored: this command is more than 10 minutes old. Resend it if you still want it.',
};

function noop(reply: string): Outcome {
  return { outcome: 'noop', reply };
}
