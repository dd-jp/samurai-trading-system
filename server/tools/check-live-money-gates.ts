/**
 * Re-verifies every issue cited in `LIVE_MONEY_GATES` against GitHub (#868).
 *
 * ## What this is for
 *
 * `LIVE_MONEY_GATES` (`server/apps/orchestrator/live-money-gates.ts`) is the list
 * of open blockers an operator is shown at the moment they boot a live-money run.
 * On 2026-08-18 all seven of its entries were closed and had been for days: the
 * module relied on a hand-maintained convention ("verify state before citing"),
 * and the convention failed silently on the one artifact read before real money
 * moves.
 *
 * ## Why this is a command and not a test
 *
 * "Is issue N still open" is not a property of this tree — it changes with no
 * file changing — so no checkout-deterministic check can hold it:
 *
 *  - the test suite makes no real network calls, and a check whose answer depends
 *    on ambient state that varies by machine (here: `gh` auth, network, rate
 *    limits) is a check people learn to disable, which is #866's finding about
 *    `check-path-citations` with authentication in place of a `data/` directory;
 *  - a scheduled GitHub Action would never run — Actions is billing-blocked on
 *    this repo and every job fails in ~3s with 0 steps.
 *
 * So this file is deliberately NOT wired into `lint`, `typecheck`, `test` or
 * `smoke`. It is invoked by a human — `yarn check:live-gates` — and the operator
 * is told to invoke it by the live-boot warning itself, which names the command.
 * That keeps the suite deterministic while making the staleness cheap to settle
 * instead of invisible.
 *
 * ## Testability
 *
 * `checkLiveMoneyGates` takes the state lookup as an argument. The default
 * lookup shells out to `gh`; the tests inject a stub, so nothing under
 * `yarn test` touches the network. The `gh` call happens only under `isMain`.
 */

import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

// Imported from the module rather than the orchestrator barrel: this is a CLI, and
// pulling `apps/orchestrator/index.js` would drag the whole runtime in to read two
// constants.
import {
  LIVE_MONEY_GATES,
  LIVE_MONEY_GATES_VERIFIED_ON,
} from '../apps/orchestrator/live-money-gates.js';

const execFileAsync = promisify(execFile);

/** The states GitHub reports, plus the case where the lookup itself failed. */
export type GateState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

/** Looks up one issue's state. Injected so tests never reach the network. */
export type IssueStateLookup = (issue: number) => Promise<GateState>;

export interface GateVerdict {
  readonly issue: number;
  readonly gap: string;
  readonly state: GateState;
}

export interface GateReport {
  readonly verifiedOn: string;
  readonly verdicts: readonly GateVerdict[];
  /** Cited issues that have closed — the list is stale by exactly these. */
  readonly stale: readonly GateVerdict[];
  /** Cited issues whose state could not be determined; not a staleness claim. */
  readonly unknown: readonly GateVerdict[];
}

/**
 * Asks the lookup for each cited issue's state and partitions the answers.
 *
 * A failed lookup is `UNKNOWN`, never `CLOSED`: reporting "this gate has closed"
 * because `gh` was not authenticated would be exactly the false clearance this
 * whole module exists to prevent.
 */
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

/** The default lookup: `gh issue view <N> --json state`. Never called by tests. */
export const ghIssueState: IssueStateLookup = async (issue) => {
  const { stdout } = await execFileAsync('gh', ['issue', 'view', String(issue), '--json', 'state']);
  const parsed: unknown = JSON.parse(stdout);
  const state =
    typeof parsed === 'object' && parsed !== null && 'state' in parsed
      ? (parsed as { state: unknown }).state
      : undefined;
  return state === 'OPEN' || state === 'CLOSED' ? state : 'UNKNOWN';
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

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  const report = await checkLiveMoneyGates(ghIssueState);
  console.log(formatGateReport(report));
  if (report.stale.length > 0 || report.unknown.length > 0) process.exitCode = 1;
}
