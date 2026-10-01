import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  LIVE_MONEY_GATES,
  LIVE_MONEY_GATES_VERIFIED_ON,
} from '../apps/orchestrator/live-money-gates.js';
import { isMainModule } from './cli-entrypoint.js';

const execFileAsync = promisify(execFile);

export type GateState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

export type IssueStateLookup = (issue: number) => Promise<GateState>;

export interface GateVerdict {
  readonly issue: number;
  readonly gap: string;
  readonly state: GateState;
}

export interface GateReport {
  readonly verifiedOn: string;
  readonly verdicts: readonly GateVerdict[];
  readonly stale: readonly GateVerdict[];
  readonly unknown: readonly GateVerdict[];
}

export async function checkLiveMoneyGates(
  lookup: IssueStateLookup,
  gates: readonly { readonly issue: number; readonly gap: string }[] = LIVE_MONEY_GATES,
  verifiedOn: string = LIVE_MONEY_GATES_VERIFIED_ON,
): Promise<GateReport> {
  const verdicts: GateVerdict[] = [];
  for (const gate of gates) {
    let state: GateState = 'UNKNOWN';
    try {
      state = await lookup(gate.issue);
    } catch {
      state = 'UNKNOWN';
    }
    verdicts.push({ issue: gate.issue, gap: gate.gap, state });
  }

  return {
    verifiedOn,
    verdicts,
    stale: verdicts.filter((v) => v.state === 'CLOSED'),
    unknown: verdicts.filter((v) => v.state === 'UNKNOWN'),
  };
}

export function parseIssueState(stdout: string): GateState {
  const parsed: unknown = JSON.parse(stdout);
  const state =
    typeof parsed === 'object' && parsed !== null && 'state' in parsed
      ? (parsed as { state: unknown }).state
      : undefined;
  return state === 'OPEN' || state === 'CLOSED' ? state : 'UNKNOWN';
}

export const ghIssueState: IssueStateLookup = async (issue) => {
  const { stdout } = await execFileAsync('gh', ['issue', 'view', String(issue), '--json', 'state']);
  return parseIssueState(stdout);
};

export function formatGateReport(report: GateReport): string {
  const lines = [
    'LIVE_MONEY_GATES re-verification',
    `  list last verified on:  ${report.verifiedOn}`,
    `  issues cited:           ${report.verdicts.length}`,
    '',
  ];
  for (const v of report.verdicts) lines.push(`  [${v.state.padEnd(7)}] #${v.issue} — ${v.gap}`);
  lines.push('');

  if (report.stale.length > 0) {
    lines.push(
      `  STALE: ${report.stale.length} cited issue(s) have closed: ${report.stale
        .map((v) => `#${v.issue}`)
        .join(', ')}.`,
      '  Delete each closed entry from LIVE_MONEY_GATES (a closed issue is deleted, not',
      '  struck through), add whatever now gates a live boot, and bump',
      '  LIVE_MONEY_GATES_VERIFIED_ON in the same edit.',
    );
  } else if (report.unknown.length === 0) {
    lines.push('  All cited issues are still OPEN. Bump LIVE_MONEY_GATES_VERIFIED_ON to today.');
  }

  if (report.unknown.length > 0) {
    lines.push(
      `  UNKNOWN: ${report.unknown.length} issue(s) could not be checked: ${report.unknown
        .map((v) => `#${v.issue}`)
        .join(', ')}.`,
      '  This is NOT a clearance — check `gh auth status` and re-run. An unchecked gate',
      '  must be treated as open.',
    );
  }

  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const report = await checkLiveMoneyGates(ghIssueState);
  console.log(formatGateReport(report));
  if (report.stale.length > 0 || report.unknown.length > 0) process.exitCode = 1;
}
