import type { RiskDecision } from '../../risk-manager/index.js';
import type { VerdictDecision } from '../types.js';

export interface TradeChannelNotifier {
  notify(decision: VerdictDecision, riskDecision: RiskDecision, traceId: string): Promise<void>;
}

export interface TelegramClient {
  sendMessage(chatId: string, text: string): Promise<void>;
}
