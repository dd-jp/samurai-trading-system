import { redactEvidence } from './evidence-redaction.js';
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

export type DrillSide = 'short' | 'long';

export type DrillExit = 'stop' | 'target';

export type DrillMode = DrillExit | 'kill-place' | 'kill-resume';

export interface DrivenLeg {
  orderId?: string;
  rest?: OpenOrder & { readonly observedAt: string };
  amendAttempts?: AmendAttempt[];
}

export interface SiblingCancel {
  readonly orderId: string;
  readonly goneBeforeCleanup: boolean;
  readonly statuses: readonly string[];
}

export interface InstrumentEvidence {
  readonly symbol: string;
  readonly assetType: DrillAssetType;
  readonly side?: DrillSide;
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
  stop?: DrivenLeg & {
    readonly placedPrice: number;
    triggeredAt?: string;
    triggerStatus?: string;
    triggerFillPrice?: number | undefined;
  };
  targetPrice?: number;
  target?: DrivenLeg & {
    filledAt?: string;
    fillStatus?: string;
    fillPrice?: number | undefined;
  };
  sibling?: SiblingCancel;
  stopWorkingAfterExit?: boolean;
  positionClosedAfterTrigger?: boolean;
}

export interface AccountFlatness {
  readonly at: string;
  readonly netPositions: number;
  readonly openOrders: number;
}

export interface DrillEvidence {
  readonly drill: 'sim-cfd-stop-drill';
  readonly mode: DrillMode;
  resumedFrom?: string;
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

const IDENTITY_KEYS = new Set([
  'AccountKey',
  'ClientKey',
  'AccountId',
  'ClientId',
  'AccountGroupKey',
]);

export function redact(value: unknown, secrets: readonly string[]): unknown {
  return redactEvidence(value, secrets, IDENTITY_KEYS);
}

export function isFlat(flatness: AccountFlatness | undefined): boolean {
  return flatness !== undefined && flatness.netPositions === 0 && flatness.openOrders === 0;
}

export function drillPassed(evidence: DrillEvidence): boolean {
  const ran = evidence.instruments.filter((record) => record.outcome !== 'skipped');
  return (
    evidence.failure === undefined &&
    evidence.cleanup.errors.length === 0 &&
    (evidence.mode === 'kill-place' || isFlat(evidence.flatAfter)) &&
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
    record.side === 'long' ? `${record.symbol} long` : record.symbol,
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

function yesNo(value: boolean | undefined): string {
  return value === undefined ? 'not read' : value ? 'yes' : 'no';
}

function exitLines(record: InstrumentEvidence): string[] {
  const lines: string[] = [];
  if (record.target?.fillStatus !== undefined) {
    lines.push(
      `- ${record.symbol}: target ${cell(record.target.orderId)} ${record.target.fillStatus} at ${cell(record.target.fillPrice)}`,
    );
  }
  if (record.sibling !== undefined) {
    lines.push(
      `- ${record.symbol}: sibling ${record.sibling.orderId} gone before the drill cancelled anything: ${yesNo(record.sibling.goneBeforeCleanup)} (activity: ${record.sibling.statuses.join(', ') || 'none'})`,
    );
  }
  if (record.stopWorkingAfterExit !== undefined) {
    lines.push(
      `- ${record.symbol}: stop ${cell(record.stop?.orderId)} still Working in a fresh process after the placing process exited: ${yesNo(record.stopWorkingAfterExit)}`,
    );
  }
  return lines;
}

function flatLine(label: string, flatness: AccountFlatness | undefined): string {
  if (flatness === undefined) return `- ${label}: not read`;
  return `- ${label} (${flatness.at}): ${flatness.netPositions} net positions, ${flatness.openOrders} open orders`;
}

export function renderSummary(evidence: DrillEvidence, jsonName: string): string {
  return [
    `# Saxo SIM CFD resting-stop drill, ${evidence.startedAt.slice(0, 10)}`,
    '',
    `Refs ${evidence.refs.join(' ')}. Mode: ${evidence.mode}. Verdict: **${evidence.passed ? 'PASSED' : 'FAILED'}**.`,
    ...(evidence.resumedFrom === undefined ? [] : ['', `Resumes ${evidence.resumedFrom}.`]),
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
    ...evidence.instruments.flatMap(exitLines),
    flatLine('Flat before', evidence.flatBefore),
    flatLine('Flat after', evidence.flatAfter),
    `- Cleanup: ${evidence.cleanup.cancelled.length} orders cancelled, ${evidence.cleanup.flattened.length} positions flattened, ${evidence.cleanup.errors.length} errors`,
    ...(evidence.failure === undefined ? [] : [`- Failure: ${evidence.failure}`]),
    '',
  ].join('\n');
}
