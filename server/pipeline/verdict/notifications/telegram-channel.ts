import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';
import { formatDecisionMessage } from './format.js';
import type { TelegramClient, TradeChannelNotifier } from './types.js';

export class TelegramChannel implements TradeChannelNotifier {
  readonly #client: TelegramClient;
  readonly #chatId: string;

  constructor(client: TelegramClient, chatId: string) {
    this.#client = client;
    this.#chatId = chatId;
  }

  async notify(decision: VerdictDecision, riskDecision: RiskDecision): Promise<void> {
    await this.#client.sendMessage(this.#chatId, formatDecisionMessage(decision, riskDecision));
  }
}
