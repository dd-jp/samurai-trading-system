export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export async function requireJsonObjectBody(
  response: Response,
  errorPrefix: string,
  symbol: string,
): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `${errorPrefix} for ${symbol}: expected an object, got ${truncateForError(JSON.stringify(parsed))}`,
    );
  }
  return parsed as Record<string, unknown>;
}

export const MAX_ERROR_BODY_CHARS = 500;

export function truncateForError(text: string): string {
  if (text.length <= MAX_ERROR_BODY_CHARS) return text;
  let cut = MAX_ERROR_BODY_CHARS;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}… (truncated, ${text.length} chars total)`;
}

export async function readErrorBody(
  response: Response,
): Promise<{ detail: string; code: string | undefined; message: string | undefined }> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }
  const detail = bodyText.length > 0 ? truncateForError(bodyText) : response.statusText;
  return { detail, ...parseErrorFields(bodyText) };
}

function extractCode(record: Record<string, unknown>): string | undefined {
  return 'code' in record && typeof record.code === 'number' && Number.isFinite(record.code)
    ? String(record.code)
    : undefined;
}

function extractMessage(record: Record<string, unknown>): string | undefined {
  return 'message' in record && typeof record.message === 'string' && record.message.length > 0
    ? truncateForError(record.message)
    : undefined;
}

function parseErrorFields(bodyText: string): {
  code: string | undefined;
  message: string | undefined;
} {
  if (bodyText.length === 0) return { code: undefined, message: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { code: undefined, message: undefined };
  }
  if (typeof parsed !== 'object' || parsed === null) return { code: undefined, message: undefined };
  const record = parsed as Record<string, unknown>;

  return { code: extractCode(record), message: extractMessage(record) };
}

export async function readErrorDetail(response: Response): Promise<string> {
  return (await readErrorBody(response)).detail;
}

export type HttpErrorKind = 'rate-limit' | 'timeout' | 'provider';

export function classifyStatus(status: number): HttpErrorKind {
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  return 'provider';
}

export function isServerErrorStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status <= 599;
}

export function isTimeoutAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
