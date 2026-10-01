import type { BookSpec, BookVariant, Sleeve, SleeveDecision } from '../../../contracts/index.js';
import { UNCAPPED_SPEND } from '../../pipeline/debate-engine/index.js';
import type { Logger } from '../../shared/index.js';
import { maskCredentials } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { vetoApplied } from './cycle.js';
import {
  type BarsMarketData,
  type BarsSource,
  type CfdCatalogue,
  journalledUsNewsSource,
  macroGate,
  SqliteNewsLedger,
} from './data/index.js';
import { decisionSleeves, venueRouterFor } from './index.js';
import {
  ARM2_SLEEVE_ID,
  buildLlmPanel,
  cfdEntryRefusal,
  commonPrefixLength,
  DEBATE_SLEEVE_ID,
  type LoggedCall,
  loggedNewsSource,
  MIN_SECRET_LENGTH,
  ReplayLog,
  type ReplayMiss,
  ReplayTransport,
  type SecretSource,
  secretWireForms,
} from './signal/index.js';

const REPLAYED_SLEEVES: readonly string[] = [DEBATE_SLEEVE_ID, ARM2_SLEEVE_ID];
const LSE_REFUSAL_PREFIX = 'LSE leg refused: ';
const EXCERPT_CHARS = 80;

export interface JournalledDecision {
  readonly book_id: string;
  readonly sleeve_id: string;
  readonly variant: string;
  readonly instrument: string;
  readonly venue: string;
  readonly inputs_hash: string;
  readonly direction: string;
  readonly confidence: number;
  readonly action: string;
  readonly reason: string;
  readonly stop_price: number | null;
  readonly payload: string;
}

export type Divergence =
  | { readonly kind: 'nothing_to_replay'; readonly tradingDate: string }
  | {
      readonly kind: 'decision_field';
      readonly bookId: string;
      readonly instrument: string;
      readonly field: string;
      readonly journalled: unknown;
      readonly replayed: unknown;
    }
  | { readonly kind: 'decision_missing'; readonly bookId: string; readonly instrument: string }
  | { readonly kind: 'decision_extra'; readonly bookId: string; readonly instrument: string }
  | { readonly kind: 'llm_request'; readonly miss: ReplayMiss }
  | { readonly kind: 'call_not_replayed'; readonly call: LoggedCall };

export interface ReplayResult {
  readonly tradingDate: string;
  readonly decisions: number;
  readonly calls: number;
  readonly divergences: readonly Divergence[];
}

export interface ReplayInputs {
  readonly db: StoreHandle;
  readonly tradingDate: string;
  readonly bars: BarsSource;
  readonly constituents: (tradingDate: string) => readonly string[];
  readonly market: BarsMarketData;
  readonly catalogue: CfdCatalogue | undefined;
  readonly cfdEntryRefusal?: (() => string | undefined) | undefined;
  readonly logger?: Logger | undefined;
}

const DECISIONS_SQL = `
  SELECT d.book_id, b.sleeve_id, b.variant, d.instrument, d.venue, d.inputs_hash, d.direction,
         d.confidence, d.action, d.reason, d.stop_price, d.payload
    FROM v2_decisions d JOIN v2_books b ON b.book_id = d.book_id
   WHERE d.trading_date = ?
   ORDER BY d.rowid`;

const CALLS_SQL = `
  SELECT id, trace_id AS traceId, model, prompt, response FROM llm_call_log
   WHERE substr(trace_id, 1, length(?)) = ? AND prompt IS NOT NULL
   ORDER BY id`;

const LSE_REFUSAL_SQL = `
  SELECT message FROM v2_refusals
   WHERE trading_date = ? AND scope = 'data' AND parameter = 'SAXO_SESSION'
   ORDER BY refusal_id LIMIT 1`;

function journalledDecisions(db: StoreHandle, tradingDate: string): readonly JournalledDecision[] {
  const rows = db.prepare(DECISIONS_SQL).all(tradingDate) as JournalledDecision[];
  return rows.filter((row) => REPLAYED_SLEEVES.includes(row.sleeve_id));
}

function loggedCalls(db: StoreHandle, tradingDate: string): readonly LoggedCall[] {
  const prefix = `v2-${tradingDate}-`;
  return db.prepare(CALLS_SQL).all(prefix, prefix) as LoggedCall[];
}

export function journalledLseRefusal(db: StoreHandle, tradingDate: string): string | undefined {
  const row = db.prepare(LSE_REFUSAL_SQL).get(tradingDate) as { message: string } | undefined;
  return row?.message.startsWith(LSE_REFUSAL_PREFIX)
    ? row.message.slice(LSE_REFUSAL_PREFIX.length)
    : row?.message;
}

function fieldsOf(decision: SleeveDecision): Record<string, unknown> {
  return {
    venue: decision.venue,
    inputs_hash: decision.inputs_hash,
    direction: decision.direction,
    confidence: decision.confidence,
    action: decision.action,
    reason: decision.reason,
    stop_price: decision.stop_price ?? null,
    payload: JSON.stringify({ ...decision.payload, debate_id: decision.debate_id }),
  };
}

function bookOf(row: JournalledDecision): BookSpec {
  return {
    id: row.book_id,
    sleeve: row.sleeve_id,
    variant: row.variant as BookVariant,
    instantiated: true,
  };
}

export function compareDecision(
  row: JournalledDecision,
  replayed: SleeveDecision | undefined,
): Divergence | undefined {
  if (replayed === undefined) {
    return { kind: 'decision_missing', bookId: row.book_id, instrument: row.instrument };
  }
  const fields = fieldsOf(vetoApplied(bookOf(row), replayed));
  const journalled = row as unknown as Record<string, unknown>;
  const field = Object.keys(fields).find((name) => fields[name] !== journalled[name]);
  if (field === undefined) return undefined;
  return {
    kind: 'decision_field',
    bookId: row.book_id,
    instrument: row.instrument,
    field,
    journalled: journalled[field],
    replayed: fields[field],
  };
}

type ReplayedBySleeve = ReadonlyMap<string, readonly SleeveDecision[]>;

function replayedFor(
  replayed: ReplayedBySleeve,
  row: Pick<JournalledDecision, 'sleeve_id' | 'instrument'>,
): SleeveDecision | undefined {
  return replayed.get(row.sleeve_id)?.find((decision) => decision.instrument === row.instrument);
}

function decisionKey(bookId: string, instrument: string): string {
  return `${bookId}|${instrument}`;
}

function extraDecisions(
  rows: readonly JournalledDecision[],
  replayed: ReplayedBySleeve,
): Divergence[] {
  const journalled = new Set(rows.map((row) => decisionKey(row.book_id, row.instrument)));
  const books = new Map(rows.map((row) => [row.book_id, row.sleeve_id]));
  return [...books].flatMap(([bookId, sleeveId]) =>
    (replayed.get(sleeveId) ?? [])
      .filter((decision) => !journalled.has(decisionKey(bookId, decision.instrument)))
      .map(
        (decision): Divergence => ({
          kind: 'decision_extra',
          bookId,
          instrument: decision.instrument,
        }),
      ),
  );
}

function isInputsDivergence(divergence: Divergence): boolean {
  return divergence.kind === 'decision_field' && divergence.field === 'inputs_hash';
}

export function divergencesOf(
  rows: readonly JournalledDecision[],
  replayed: ReplayedBySleeve,
  log: ReplayLog,
): Divergence[] {
  const decisions = [
    ...rows.map((row) => compareDecision(row, replayedFor(replayed, row))),
    ...extraDecisions(rows, replayed),
  ].filter((divergence): divergence is Divergence => divergence !== undefined);
  return [
    ...decisions.filter(isInputsDivergence),
    ...log.misses.map((miss): Divergence => ({ kind: 'llm_request', miss })),
    ...decisions.filter((divergence) => !isInputsDivergence(divergence)),
    ...log.unserved().map((call): Divergence => ({ kind: 'call_not_replayed', call })),
  ];
}

async function decideAll(
  sleeves: readonly Sleeve[],
  tradingDate: string,
): Promise<Map<string, readonly SleeveDecision[]>> {
  const context = { tradingDate, macroDay: macroGate(tradingDate).macroDay, dryRun: false };
  const replayed = new Map<string, readonly SleeveDecision[]>();
  for (const sleeve of sleeves) {
    const universe = sleeve.universe(context);
    replayed.set(sleeve.id, (await sleeve.decide(context, universe.instruments)).decisions);
  }
  return replayed;
}

const SILENT: Logger = { log: () => {} };

function replaySleeves(
  inputs: ReplayInputs,
  log: ReplayLog,
  calls: readonly LoggedCall[],
): Sleeve[] {
  const logger = inputs.logger ?? SILENT;
  const panel = buildLlmPanel({
    transportFor: (pin) => new ReplayTransport(pin, log),
    spendSink: { record: () => {} },
    spendCap: UNCAPPED_SPEND,
    logger,
  });
  return decisionSleeves({
    panel,
    bars: inputs.bars,
    constituents: inputs.constituents,
    market: inputs.market,
    news: journalledUsNewsSource(new SqliteNewsLedger(inputs.db), loggedNewsSource(calls)),
    clock: { now: () => new Date(`${inputs.tradingDate}T00:00:00.000Z`) },
    logger,
    router: venueRouterFor(inputs.catalogue, inputs.cfdEntryRefusal ?? cfdEntryRefusal),
    lseLegRefusal: journalledLseRefusal(inputs.db, inputs.tradingDate),
  });
}

export async function replayDay(inputs: ReplayInputs): Promise<ReplayResult> {
  const { db, tradingDate } = inputs;
  const rows = journalledDecisions(db, tradingDate);
  const calls = loggedCalls(db, tradingDate);
  if (rows.length === 0) {
    return {
      tradingDate,
      decisions: 0,
      calls: calls.length,
      divergences: [{ kind: 'nothing_to_replay', tradingDate }],
    };
  }
  const log = new ReplayLog(calls);
  const decided = new Set(rows.map((row) => row.sleeve_id));
  const sleeves = replaySleeves(inputs, log, calls).filter((sleeve) => decided.has(sleeve.id));
  const replayed = await decideAll(sleeves, tradingDate);
  return {
    tradingDate,
    decisions: rows.length,
    calls: calls.length,
    divergences: divergencesOf(rows, replayed, log),
  };
}

export type Redact = (text: string) => string;

function maskSecret(text: string, value: string): string {
  return secretWireForms(value).reduce(
    (masked, form) => masked.split(form).join('[REDACTED]'),
    text,
  );
}

export function redactor(secrets: SecretSource): Redact {
  return (text) =>
    secrets()
      .filter((secret) => secret.value.length >= MIN_SECRET_LENGTH)
      .reduce((masked, secret) => maskSecret(masked, secret.value), maskCredentials(text));
}

function excerpt(text: string, offset: number): string {
  return JSON.stringify(text.slice(offset, offset + EXCERPT_CHARS));
}

// Redacted whole before the excerpt is cut, so a secret straddling the window edge is still caught
function describeMiss(miss: ReplayMiss, redact: Redact): string {
  const head = `LLM request ${miss.kind} for ${miss.model}`;
  if (miss.nearest === undefined) return `${head}: no logged call for that model is left`;
  const replayed = redact(miss.prompt);
  const logged = redact(miss.nearest.prompt);
  const offset = commonPrefixLength(replayed, logged);
  return [
    `${head}: nearest logged call ${miss.nearest.id} (${miss.nearest.traceId}) differs at offset ${offset}`,
    `  replayed: ${excerpt(replayed, offset)}`,
    `  logged:   ${excerpt(logged, offset)}`,
  ].join('\n');
}

type DescriberOf = {
  readonly [K in Divergence['kind']]: (
    divergence: Extract<Divergence, { kind: K }>,
    redact: Redact,
  ) => string;
};

const DESCRIBERS: DescriberOf = {
  nothing_to_replay: (divergence) =>
    `no debate or arm 2 decision is journalled for ${divergence.tradingDate}`,
  decision_field: (divergence) =>
    [
      `${divergence.bookId} ${divergence.instrument}: ${divergence.field} differs`,
      `  journalled: ${JSON.stringify(divergence.journalled)}`,
      `  replayed:   ${JSON.stringify(divergence.replayed)}`,
    ].join('\n'),
  decision_missing: (divergence) =>
    `${divergence.bookId} ${divergence.instrument}: journalled, not replayed`,
  decision_extra: (divergence) =>
    `${divergence.bookId} ${divergence.instrument}: replayed, not journalled`,
  llm_request: (divergence, redact) => describeMiss(divergence.miss, redact),
  call_not_replayed: ({ call }) =>
    `logged call ${call.id} (${call.traceId}, ${call.model}) was never requested`,
};

function describeDivergence(divergence: Divergence, redact: Redact): string {
  const describe = DESCRIBERS[divergence.kind] as (entry: Divergence, redact: Redact) => string;
  return describe(divergence, redact);
}

export function formatReplay(result: ReplayResult, redact: Redact): string {
  const head = `replay ${result.tradingDate}: ${result.decisions} journalled decisions, ${result.calls} logged calls`;
  const [first] = result.divergences;
  if (first === undefined) return `${head}\nidentical`;
  return redact(
    [
      head,
      `DIVERGED (${result.divergences.length} divergences); first:`,
      describeDivergence(first, redact),
    ].join('\n'),
  );
}
