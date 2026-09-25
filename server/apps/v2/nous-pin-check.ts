import type { Logger } from '../../shared/index.js';
import type { ModelPin } from './models.js';

const PIN_CHECK_TIMEOUT_MS = 30_000;
const REFUSAL = 'v2 refuses the paper run: Nous GET /models';

export interface NousPinCheckOptions {
  readonly dryRun: boolean;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly pins: readonly ModelPin[];
  readonly logger: Logger;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

type Catalogue = ReadonlyMap<unknown, unknown>;

function redacted(text: string, apiKey: string | undefined): string {
  return apiKey === undefined || apiKey === '' ? text : text.split(apiKey).join('[redacted]');
}

async function requestCatalogue(options: NousPinCheckOptions): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    return await fetchImpl(`${options.baseUrl}/models`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? PIN_CHECK_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${REFUSAL} failed: ${redacted(reason, options.apiKey)}`);
  }
}

async function catalogueRows(response: Response): Promise<unknown[]> {
  if (!response.ok) throw new Error(`${REFUSAL} answered HTTP ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as { data?: unknown } | null;
  const data = body?.data;
  if (!Array.isArray(data)) throw new Error(`${REFUSAL} returned no "data" array`);
  return data;
}

function catalogueOf(rows: readonly unknown[]): Catalogue {
  return new Map(
    rows.map((row) => {
      const entry = row as { id?: unknown; canonical_slug?: unknown } | null;
      return [entry?.id, entry?.canonical_slug] as const;
    }),
  );
}

function pinMismatch(pin: ModelPin, catalogue: Catalogue): string | undefined {
  if (!catalogue.has(pin.wire)) return `${pin.seat} ${pin.wire} is not listed`;
  const slug = catalogue.get(pin.wire);
  return pin.canonicalSlug === undefined || slug === pin.canonicalSlug
    ? undefined
    : `${pin.seat} ${pin.wire} resolves to ${String(slug)}, pinned ${pin.canonicalSlug}`;
}

function verifiedPin(pin: ModelPin, catalogue: Catalogue) {
  return {
    seat: pin.seat,
    wire: pin.wire,
    canonical_slug: catalogue.get(pin.wire),
    slug_verified: pin.canonicalSlug !== undefined,
  };
}

export async function verifyNousPins(options: NousPinCheckOptions): Promise<void> {
  if (options.dryRun) return;
  const catalogue = catalogueOf(await catalogueRows(await requestCatalogue(options)));
  const mismatches = options.pins
    .map((pin) => pinMismatch(pin, catalogue))
    .filter((mismatch) => mismatch !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`${REFUSAL}: ${mismatches.join('; ')} — a changed snapshot is a new trial`);
  }
  const verified = options.pins.map((pin) => verifiedPin(pin, catalogue));
  options.logger.log({
    trace_id: 'v2-root',
    stage: 'v2',
    level: 'info',
    event: 'v2_llm_pins_verified',
    message: verified
      .map(
        (entry) =>
          `${entry.wire} = ${String(entry.canonical_slug)}${entry.slug_verified ? '' : ' (slug unverified)'}`,
      )
      .join(', '),
    payload: verified,
  });
}
