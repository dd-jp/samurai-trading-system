import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../../shared/index.js';
import { exitCodeOrOne, flagPairs, isMainModule } from '../../../tools/cli-entrypoint.js';
import { type FetchLike, resolveSaxoOAuthConfig } from './saxo/saxo-oauth.js';
import { readTokenFile, tokenFilePath } from './saxo/saxo-token-file.js';
import {
  SaxoTokenRefresher,
  type SaxoTokenSource,
  StaticSaxoTokenSource,
} from './saxo/saxo-token-source.js';
import {
  assertSimGateway,
  SAXO_SIM_GATEWAY,
  SaxoSimGateway,
  SimOnlyRefusal,
} from './saxo-sim-gateway.js';
import {
  type DrillEvidence,
  type DrillExit,
  redact,
  renderSummary,
} from './sim-cfd-drill-evidence.js';
import {
  DEFAULT_DRILL_OPTIONS,
  DEFAULT_ETF_SHORT,
  DEFAULT_STOCK_SHORT,
  DEFAULT_UK_LONG,
  type DrillClock,
  type DrillOptions,
  type DrillPhase,
  type DrillTarget,
  resumeSimCfdDrill,
  runSimCfdStopDrill,
} from './sim-cfd-stop-drill.js';

export const DRILL_USAGE =
  'usage: v2:sim-cfd-stop-drill [--stock SYMBOL|none] [--etf SYMBOL|none] [--uk-long SYMBOL|none] [--exit stop|target] [--phase full|place] [--resume PLACE_RECORD.json] [--out-dir DIR]';

const DEFAULT_OUT_DIR = fileURLToPath(new URL('../../../../docs/reviews/', import.meta.url));

export interface DrillArgs {
  readonly targets: readonly DrillTarget[];
  readonly outDir: string;
  readonly exit: DrillExit;
  readonly phase: DrillPhase;
  readonly resume?: string | undefined;
}

function oneOf<T extends string>(
  values: ReadonlyMap<string, string>,
  flag: string,
  allowed: readonly T[],
): T {
  const value = values.get(flag) ?? allowed[0];
  if (!allowed.includes(value as T)) throw new Error(`unknown --${flag} ${value}\n${DRILL_USAGE}`);
  return value as T;
}

function resumeOf(values: ReadonlyMap<string, string>): string | undefined {
  const resume = values.get('resume');
  if (resume !== undefined && (values.has('exit') || values.has('phase'))) {
    throw new Error(`--resume takes no --exit or --phase\n${DRILL_USAGE}`);
  }
  return resume === undefined ? undefined : resolve(resume);
}

export function parseDrillArgs(argv: readonly string[]): DrillArgs {
  const values = flagPairs(
    argv,
    ['--stock', '--etf', '--uk-long', '--exit', '--phase', '--resume', '--out-dir'],
    DRILL_USAGE,
  );
  const chosen = (
    [
      ['stock', DEFAULT_STOCK_SHORT],
      ['etf', DEFAULT_ETF_SHORT],
      ['uk-long', DEFAULT_UK_LONG],
    ] as const
  ).flatMap(([flag, target]): DrillTarget[] => {
    const symbol = values.get(flag) ?? target.symbol;
    return symbol === 'none' ? [] : [{ ...target, symbol }];
  });
  if (chosen.length === 0) throw new Error(`nothing to drill\n${DRILL_USAGE}`);
  return {
    targets: chosen,
    outDir: resolve(values.get('out-dir') ?? DEFAULT_OUT_DIR),
    exit: oneOf(values, 'exit', ['stop', 'target'] as const),
    phase: oneOf(values, 'phase', ['full', 'place'] as const),
    resume: resumeOf(values),
  };
}

export interface SimTokenChoice {
  readonly source: SaxoTokenSource;
  readonly origin: 'token_file' | 'env_token';
  readonly secrets: () => Promise<readonly string[]>;
}

function refresherFor(
  env: NodeJS.ProcessEnv,
  tokenPath: string,
  logger: Logger,
): SaxoTokenSource | undefined {
  const record = readTokenFile(tokenPath);
  if (record === undefined) return undefined;
  if (record.environment !== 'sim') {
    throw new SimOnlyRefusal(
      `sim_only_refusal: ${tokenPath} holds a ${record.environment} session`,
    );
  }
  const refresher = new SaxoTokenRefresher({
    environment: 'sim',
    config: resolveSaxoOAuthConfig('sim', env),
    tokenPath,
    logger,
  });
  return refresher.start().status === 'active' ? refresher : undefined;
}

export function simTokenSource(
  env: NodeJS.ProcessEnv,
  logger: Logger,
  tokenPath: string = tokenFilePath('sim'),
): SimTokenChoice {
  const fromFile = refresherFor(env, tokenPath, logger);
  const pasted = env.SAXO_SIM_ACCESS_TOKEN?.trim() ?? '';
  const source = fromFile ?? (pasted === '' ? undefined : new StaticSaxoTokenSource(pasted));
  if (source === undefined) {
    throw new Error(
      `saxo_sim_token_missing: no usable SIM session at ${tokenPath} and SAXO_SIM_ACCESS_TOKEN is empty`,
    );
  }
  return {
    source,
    origin: fromFile === undefined ? 'env_token' : 'token_file',
    secrets: async () => [pasted, await source.getAccessToken()],
  };
}

export function writeEvidence(
  evidence: DrillEvidence,
  outDir: string,
  secrets: readonly string[],
): { json: string; markdown: string } {
  const suffix = evidence.mode === 'stop' ? '' : `-${evidence.mode}`;
  const base = `sim-cfd-stop-drill-${evidence.startedAt.slice(0, 19).replaceAll(':', '')}Z${suffix}`;
  const json = join(outDir, `${base}.json`);
  const markdown = join(outDir, `${base}.md`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(json, `${JSON.stringify(redact(evidence, secrets), null, 2)}\n`);
  writeFileSync(markdown, String(redact(renderSummary(evidence, `${base}.json`), secrets)));
  return { json, markdown };
}

function placedRecord(path: string): { record: unknown; source: string } {
  return { record: JSON.parse(readFileSync(path, 'utf8')) as unknown, source: basename(path) };
}

export interface DrillDeps {
  readonly fetch: FetchLike;
  readonly clock: DrillClock;
  readonly logger: Logger;
  readonly tokens: (env: NodeJS.ProcessEnv, logger: Logger) => SimTokenChoice;
  readonly onInterrupt: (handler: () => void) => () => void;
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

const DEFAULT_DEPS: DrillDeps = {
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
  clock: {
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  },
  logger: STDERR_LOGGER,
  tokens: simTokenSource,
  onInterrupt: (handler) => {
    process.once('SIGINT', handler);
    return () => process.off('SIGINT', handler);
  },
};

function log(logger: Logger, event: string, message: string, payload?: unknown): void {
  logger.log({
    level: 'info',
    event,
    trace_id: 'sim-cfd-stop-drill',
    stage: 'drill',
    message,
    payload,
  });
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: DrillDeps = DEFAULT_DEPS,
): Promise<number> {
  const args = parseDrillArgs(argv);
  const baseUrl = env.SAXO_SIM_GATEWAY?.trim() || SAXO_SIM_GATEWAY;
  assertSimGateway(baseUrl);
  const tokens = deps.tokens(env, deps.logger);
  log(deps.logger, 'sim_cfd_drill_token', `SIM token from ${tokens.origin}`);
  const gateway = new SaxoSimGateway({
    baseUrl,
    accessToken: () => tokens.source.getAccessToken(),
    fetch: deps.fetch,
    sleep: deps.clock.sleep,
    now: () => deps.clock.now().getTime(),
  });
  const interrupt = new AbortController();
  const release = deps.onInterrupt(() => {
    log(
      deps.logger,
      'sim_cfd_drill_interrupted',
      'interrupted: cleaning up SIM orders and positions; a second Ctrl-C abandons the clean-up',
    );
    interrupt.abort();
  });
  const options: DrillOptions = {
    ...DEFAULT_DRILL_OPTIONS,
    targets: args.targets,
    exit: args.exit,
    phase: args.phase,
    runId: String(deps.clock.now().getTime()),
  };
  const run =
    args.resume === undefined
      ? runSimCfdStopDrill(gateway, options, deps.clock, interrupt.signal)
      : resumeSimCfdDrill(
          gateway,
          placedRecord(args.resume),
          options,
          deps.clock,
          interrupt.signal,
        );
  const { evidence, account } = await run.finally(release);
  const secrets = await tokens.secrets().catch(() => []);
  await tokens.source.stop();
  const written = writeEvidence(evidence, args.outDir, [
    ...secrets,
    account?.accountKey ?? '',
    account?.clientKey ?? '',
  ]);
  log(
    deps.logger,
    evidence.passed ? 'sim_cfd_drill_passed' : 'sim_cfd_drill_failed',
    `evidence at ${written.json}`,
    { failure: evidence.failure },
  );
  return evidence.passed ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await exitCodeOrOne(main(process.argv.slice(2), process.env));
}
