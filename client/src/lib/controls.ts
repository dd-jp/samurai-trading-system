import {
  CONTROL_REASON_MAX_CHARS,
  type ControlAction,
  type ControlRequestWire,
  type ControlResponseWire,
  type ControlRowWire,
  V2_CONTRACT_VERSION,
} from '@contracts';
import { authHeaders } from './api.ts';

const CONTROLS_URL = '/api/v2/controls';

export type ControlOutcome =
  | { readonly kind: 'recorded'; readonly control: ControlRowWire; readonly replayed: boolean }
  | { readonly kind: 'too-soon'; readonly retryAfterSeconds: number }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failed'; readonly error: string };

export interface PendingControl {
  readonly action: ControlAction;
  readonly reason: string;
  readonly idempotency_key: string;
}

export function controlRequest(
  action: ControlAction,
  rawReason: string,
  previous: PendingControl | null,
  newKey: () => string,
): ControlRequestWire | { readonly error: string } {
  const reason = rawReason.trim();
  if (reason === '') return { error: 'A reason is required.' };
  if (reason.length > CONTROL_REASON_MAX_CHARS) {
    return { error: `The reason is longer than ${CONTROL_REASON_MAX_CHARS} characters.` };
  }
  const retry = previous !== null && previous.action === action && previous.reason === reason;
  return { action, reason, idempotency_key: retry ? previous.idempotency_key : newKey() };
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function outcomeOf(response: Response): Promise<ControlOutcome> {
  if (response.status === 401) return { kind: 'unauthorized' };
  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? 10);
    return { kind: 'too-soon', retryAfterSeconds };
  }
  if (!response.ok) return { kind: 'refused', error: await errorOf(response) };
  const body = (await response.json()) as ControlResponseWire;
  if (body.contract_version !== V2_CONTRACT_VERSION) {
    return { kind: 'failed', error: 'the server runs a different contract version' };
  }
  return { kind: 'recorded', control: body.control, replayed: body.replayed };
}

export async function sendControl(
  request: ControlRequestWire,
  token: string | null,
  fetchImpl: typeof fetch,
): Promise<ControlOutcome> {
  try {
    const response = await fetchImpl(CONTROLS_URL, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return await outcomeOf(response);
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
