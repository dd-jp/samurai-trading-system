import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsEquityRegularHoursCalendar } from '../../../providers/calendar/index.js';
import type { Logger } from '../../../shared/index.js';
import { exitCodeOrOne, flagPairs, setExitCodeWhenInvoked } from '../../../tools/cli-entrypoint.js';
import { AlpacaHttpBrokerClient } from './alpaca/alpaca-http-client.js';
import {
  assertAlpacaPaper,
  DEFAULT_PROBE_OPTIONS,
  type ProbeClient,
  type ProbeDeps,
  type ProbeEvidence,
  redact,
  runAlpacaOcoProbe,
} from './alpaca-oco-probe.js';

export const PROBE_USAGE = 'usage: v2:alpaca-oco-probe [--symbol SYMBOL] [--out-dir DIR]';

const DEFAULT_OUT_DIR = fileURLToPath(
  new URL('../../../../data/alpaca-oco-probe/', import.meta.url),
);

export interface ProbeArgs {
  readonly symbol: string;
  readonly outDir: string;
}

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const values = flagPairs(argv, ['--symbol', '--out-dir'], PROBE_USAGE);
  return {
    symbol: (values.get('symbol') ?? DEFAULT_PROBE_OPTIONS.symbol).toUpperCase(),
    outDir: resolve(values.get('out-dir') ?? DEFAULT_OUT_DIR),
  };
}

export function writeProbeEvidence(evidence: ProbeEvidence, outDir: string): string {
  const path = join(
    outDir,
    `alpaca-oco-probe-${evidence.startedAt.slice(0, 19).replaceAll(':', '')}Z.json`,
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
}

export interface ProbeCliDeps extends Omit<ProbeDeps, 'client'> {
  readonly client: () => ProbeClient;
  readonly stdout: (line: string) => void;
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

const DEFAULT_DEPS: ProbeCliDeps = {
  client: () => new AlpacaHttpBrokerClient({ environment: 'paper' }),
  clock: {
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  },
  calendar: new UsEquityRegularHoursCalendar(),
  logger: STDERR_LOGGER,
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

function credentialValues(env: NodeJS.ProcessEnv): string[] {
  return [env.ALPACA_API_KEY, env.ALPACA_API_SECRET].filter(
    (value): value is string => value !== undefined,
  );
}

export function summaryLines(evidence: ProbeEvidence, path: string): string[] {
  return [
    `${evidence.passed ? 'probe_passed' : 'probe_failed'}: evidence at ${path}`,
    `oco stop leg status: ${evidence.ocoStopLegStatus ?? 'not seen'}`,
    ...(evidence.failure === undefined ? [] : [`failure: ${evidence.failure}`]),
    ...evidence.cleanup.errors.map((error) => `cleanup error: ${error}`),
    `residual: ${JSON.stringify(evidence.residual ?? 'unread')}`,
  ];
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: ProbeCliDeps = DEFAULT_DEPS,
): Promise<number> {
  const args = parseProbeArgs(argv);
  const client = deps.client();
  assertAlpacaPaper(client.baseUrl);
  const evidence = await runAlpacaOcoProbe(
    { ...deps, client },
    {
      ...DEFAULT_PROBE_OPTIONS,
      symbol: args.symbol,
      runId: String(deps.clock.now().getTime()),
    },
  );
  const redacted = redact(evidence, credentialValues(env)) as ProbeEvidence;
  const path = writeProbeEvidence(redacted, args.outDir);
  for (const line of summaryLines(redacted, path)) deps.stdout(line);
  return redacted.passed ? 0 : 1;
}

await setExitCodeWhenInvoked(import.meta.url, () =>
  exitCodeOrOne(main(process.argv.slice(2), process.env)),
);
