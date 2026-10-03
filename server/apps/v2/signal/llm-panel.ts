import type {
  AnthropicMessagesClient,
  LlmClient,
  LlmSpendSink,
  SpendCap,
} from '../../../shared/debate/index.js';
import { AnthropicLlmClient } from '../../../shared/debate/index.js';
import type { Logger } from '../../../shared/index.js';
import {
  ALL_PINS,
  DEBATER_MAX_TOKENS,
  DEBATER_PINS,
  type DebaterSeat,
  JUDGE_MAX_TOKENS,
  JUDGE_PIN,
  type ModelPin,
} from './models.js';

const LLM_CALL_TIMEOUT_MS = 60_000;
const LLM_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 } as const;

export interface SeatRotation {
  readonly bull: DebaterSeat;
  readonly bear: DebaterSeat;
  readonly idle: DebaterSeat;
}

const SEATS: readonly DebaterSeat[] = DEBATER_PINS.map((pin) => pin.seat as DebaterSeat);
const MS_PER_DAY = 86_400_000;

export function rotateSeats(tradingDate: string): SeatRotation {
  const dayIndex = Math.floor(Date.parse(`${tradingDate}T00:00:00.000Z`) / MS_PER_DAY);
  if (!Number.isFinite(dayIndex)) throw new Error(`rotateSeats: bad trading date ${tradingDate}`);
  const idle = SEATS[dayIndex % SEATS.length] as DebaterSeat;
  const active = SEATS.filter((seat) => seat !== idle);
  const swap = Math.floor(dayIndex / SEATS.length) % 2 === 1;
  const [first, second] = swap ? [active[1], active[0]] : [active[0], active[1]];
  return { bull: first as DebaterSeat, bear: second as DebaterSeat, idle };
}

export interface LlmPanel {
  readonly debaters: Readonly<Record<DebaterSeat, LlmClient>>;
  readonly judge: LlmClient;
  readonly spendCap: SpendCap;
  readonly pins: readonly ModelPin[];
}

export interface LlmPanelDeps {
  readonly transportFor: (pin: ModelPin) => AnthropicMessagesClient;
  readonly spendSink: LlmSpendSink;
  readonly spendCap: SpendCap;
  readonly logger?: Logger | undefined;
}

function clientFor(deps: LlmPanelDeps, pin: ModelPin, maxTokens: number): LlmClient {
  return new AnthropicLlmClient(
    deps.transportFor(pin),
    {
      model: pin.wire,
      pricedModel: pin.priced,
      max_tokens: maxTokens,
      timeoutMs: LLM_CALL_TIMEOUT_MS,
      retry: LLM_RETRY,
      onCallFailed: (report) =>
        deps.logger?.log({
          trace_id: report.trace_id ?? 'v2-llm',
          stage: report.stage ?? 'v2',
          level: 'warn',
          event: 'v2_llm_call_failed',
          message: `${pin.wire} call failed: ${report.failure_cause}`,
          payload: { model: pin.wire, failure_cause: report.failure_cause },
        }),
    },
    deps.spendSink,
  );
}

export function buildLlmPanel(deps: LlmPanelDeps): LlmPanel {
  const debaters = {} as Record<DebaterSeat, LlmClient>;
  for (const pin of DEBATER_PINS) {
    debaters[pin.seat as DebaterSeat] = clientFor(deps, pin, DEBATER_MAX_TOKENS);
  }
  return {
    debaters,
    judge: clientFor(deps, JUDGE_PIN, JUDGE_MAX_TOKENS),
    spendCap: deps.spendCap,
    pins: ALL_PINS,
  };
}

function debaterWire(seat: DebaterSeat): string {
  const pin = DEBATER_PINS.find((candidate) => candidate.seat === seat);
  if (pin === undefined) throw new Error(`llm panel: no pin for debater seat ${seat}`);
  return pin.wire;
}

export function seatModels(tradingDate: string): readonly string[] {
  const rotation = rotateSeats(tradingDate);
  return [debaterWire(rotation.bull), debaterWire(rotation.bear), JUDGE_PIN.wire];
}
