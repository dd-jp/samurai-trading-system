import type { DrillAssetType, OpenOrder } from './sim-cfd-drill-reads.js';

export interface DrillStep {
  readonly at: string;
  readonly code: string;
  readonly detail?: unknown;
}

export interface AmendAttempt {
  readonly price: number;
  readonly status: number;
  readonly body: unknown;
}

export interface InstrumentEvidence {
  readonly symbol: string;
  readonly assetType: DrillAssetType;
  outcome: 'passed' | 'failed' | 'skipped' | 'running';
  reason?: string;
  uic?: number;
  amount?: number;
  quote?: unknown;
  supportedOrderTypes?: readonly string[];
  orderDistances?: unknown;
  entry?: {
    readonly orderId: string;
    readonly externalReference: string;
    readonly placedAt: string;
    readonly relatedOrderIds: readonly string[];
    fillPrice?: number | undefined;
    filledAt?: string;
  };
  stop?: {
    readonly placedPrice: number;
    orderId?: string;
    rest?: OpenOrder & { readonly observedAt: string };
    amendAttempts?: AmendAttempt[];
    triggeredAt?: string;
    triggerStatus?: string;
    triggerFillPrice?: number | undefined;
  };
  targetPrice?: number;
  positionClosedAfterTrigger?: boolean;
}

export interface AccountFlatness {
  readonly at: string;
  readonly netPositions: number;
  readonly openOrders: number;
}

export interface DrillEvidence {
  readonly drill: 'sim-cfd-stop-drill';
  readonly refs: readonly string[];
  readonly gateway: string;
  readonly startedAt: string;
  finishedAt?: string;
  account?: { readonly isTrialAccount: true; readonly currency: string };
  flatBefore?: AccountFlatness;
  flatAfter?: AccountFlatness;
  readonly instruments: InstrumentEvidence[];
  readonly cleanup: { cancelled: string[]; flattened: string[]; errors: string[] };
  readonly steps: DrillStep[];
  failure?: string;
  passed: boolean;
}

const REDACTED = '[redacted]';
const IDENTITY_KEYS = new Set([
  'AccountKey',
  'ClientKey',
  'AccountId',
  'ClientId',
  'AccountGroupKey',
]);

function redactString(value: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join(REDACTED), value);
}

export function redact(value: unknown, secrets: readonly string[]): unknown {
  const live = secrets.filter((secret) => secret.length > 0);
  if (typeof value === 'string') return redactString(value, live);
  if (Array.isArray(value)) return value.map((item) => redact(item, live));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      IDENTITY_KEYS.has(key) ? REDACTED : redact(item, live),
    ]),
  );
}

export function isFlat(flatness: AccountFlatness | undefined): boolean {
  return flatness !== undefined && flatness.netPositions === 0 && flatness.openOrders === 0;
}

export function drillPassed(evidence: DrillEvidence): boolean {
  const ran = evidence.instruments.filter((record) => record.outcome !== 'skipped');
  return (
    evidence.failure === undefined &&
    evidence.cleanup.errors.length === 0 &&
    isFlat(evidence.flatAfter) &&
    ran.length > 0 &&
    ran.every((record) => record.outcome === 'passed')
  );
}

function cell(value: unknown): string {
  return value === undefined ? '-' : String(value);
}

function instrumentRow(record: InstrumentEvidence): string {
  const stop = record.stop;
  const amended = stop?.amendAttempts?.find((attempt) => attempt.status === 200)?.price;
  return `| ${[
    record.symbol,
    record.assetType,
    record.outcome,
    record.reason,
    record.entry?.fillPrice,
    stop?.placedPrice,
    stop?.rest?.status,
    amended,
    stop?.triggerStatus,
    stop?.triggerFillPrice,
  ]
    .map(cell)
    .join(' | ')} |`;
}

function flatLine(label: string, flatness: AccountFlatness | undefined): string {
  if (flatness === undefined) return `- ${label}: not read`;
  return `- ${label} (${flatness.at}): ${flatness.netPositions} net positions, ${flatness.openOrders} open orders`;
}

export function renderSummary(evidence: DrillEvidence, jsonName: string): string {
  return [
    `# Saxo SIM CFD resting-stop drill, ${evidence.startedAt.slice(0, 10)}`,
    '',
    `Refs ${evidence.refs.join(' ')}. Verdict: **${evidence.passed ? 'PASSED' : 'FAILED'}**.`,
    '',
    `Gateway ${evidence.gateway}, Saxo trial account (${cell(evidence.account?.currency)}). ` +
      `Run ${evidence.startedAt} to ${cell(evidence.finishedAt)}. Full record: ${jsonName}.`,
    '',
    'A passing record is the evidence doc 66 ruling (c) asks for before `CFD_RESTING_STOP_VERIFIED` is set for paper. SIM is a trial account: order handling carries to live, tariffs and entitlements do not.',
    '',
    '| Symbol | Asset type | Outcome | Reason | Entry fill | Stop placed | Stop at rest | Stop amended to | Stop trigger | Stop fill |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...evidence.instruments.map(instrumentRow),
    '',
    flatLine('Flat before', evidence.flatBefore),
    flatLine('Flat after', evidence.flatAfter),
    `- Cleanup: ${evidence.cleanup.cancelled.length} orders cancelled, ${evidence.cleanup.flattened.length} positions flattened, ${evidence.cleanup.errors.length} errors`,
    ...(evidence.failure === undefined ? [] : [`- Failure: ${evidence.failure}`]),
    '',
  ].join('\n');
}
