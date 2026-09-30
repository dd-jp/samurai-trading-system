import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readTokenFile,
  resolveSaxoOAuthConfig,
  SaxoTokenRefresher,
  type SaxoTokenSource,
  StaticSaxoTokenSource,
  tokenFilePath,
} from '../../../pipeline/execution/index.js';
import type { Logger } from '../../../shared/index.js';
import { isMainModule } from '../../../tools/cli-entrypoint.js';
import {
  assertSimGateway,
  type FetchLike,
  SAXO_SIM_GATEWAY,
  SaxoSimGateway,
  SimOnlyRefusal,
} from './saxo-sim-gateway.js';
import { type DrillEvidence, redact, renderSummary } from './sim-cfd-drill-evidence.js';
import {
  DEFAULT_DRILL_OPTIONS,
  DEFAULT_DRILL_TARGETS,
  type DrillClock,
  type DrillTarget,
  runSimCfdStopDrill,
} from './sim-cfd-stop-drill.js';

export const DRILL_USAGE =
  'usage: v2:sim-cfd-stop-drill [--stock SYMBOL|none] [--etf SYMBOL|none] [--out-dir DIR]';

const DEFAULT_OUT_DIR = fileURLToPath(new URL('../../../../docs/reviews/', import.meta.url));

export interface DrillArgs {
  readonly targets: readonly DrillTarget[];
  readonly outDir: string;
}

function flagValues(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? '';
    const value = argv[index + 1];
    if (!['--stock', '--etf', '--out-dir'].includes(name) || value === undefined) {
      throw new Error(DRILL_USAGE);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

export function parseDrillArgs(argv: readonly string[]): DrillArgs {
  const values = flagValues(argv);
  const [stock, etf] = DEFAULT_DRILL_TARGETS;
  const chosen = [
    { symbol: values.get('stock') ?? stock?.symbol, assetType: 'CfdOnStock' as const },
    { symbol: values.get('etf') ?? etf?.symbol, assetType: 'CfdOnEtf' as const },
  ].filter(
    (target): target is DrillTarget => target.symbol !== undefined && target.symbol !== 'none',
  );
  if (chosen.length === 0) throw new Error(`nothing to drill\n${DRILL_USAGE}`);
  return { targets: chosen, outDir: resolve(values.get('out-dir') ?? DEFAULT_OUT_DIR) };
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
  const base = `sim-cfd-stop-drill-${evidence.startedAt.slice(0, 10)}`;
  const json = join(outDir, `${base}.json`);
  const markdown = join(outDir, `${base}.md`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(json, `${JSON.stringify(redact(evidence, secrets), null, 2)}\n`);
  writeFileSync(markdown, String(redact(renderSummary(evidence, `${base}.json`), secrets)));
  return { json, markdown };
}

export interface DrillDeps {
  readonly fetch: FetchLike;
  readonly clock: DrillClock;
  readonly logger: Logger;
  readonly tokens: (env: NodeJS.ProcessEnv, logger: Logger) => SimTokenChoice;
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
  const { evidence, account } = await runSimCfdStopDrill(
    gateway,
    { ...DEFAULT_DRILL_OPTIONS, targets: args.targets, runId: String(deps.clock.now().getTime()) },
    deps.clock,
  );
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
  process.exitCode = await main(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}
