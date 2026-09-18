import type {
  BrokerAdapter,
  DormantLegsUnresolvedAlertChannel,
  LegResizeUnverifiedAlertChannel,
  SaxoInstrumentResolver,
  SaxoOpenApiClient,
  SaxoSessionLostAlertChannel,
  SaxoTokenSource,
  SaxoTradingEnvironment,
  UnresolvedPriceUnitAlertChannel,
} from '../../../pipeline/execution/index.js';
import {
  resolveSaxoOAuthConfig,
  SAXO_CREDENTIAL_ENV_VARS,
  SaxoBrokerAdapter,
  SaxoHttpBrokerClient,
  SaxoTokenRefresher,
  SqliteBrokerStateStore,
  StaticSaxoTokenSource,
  savedSessionExists,
  saxoInstrumentResolverFromVenue,
  tokenFilePath,
} from '../../../pipeline/execution/index.js';
import type { LseEtpPoolRow } from '../../../providers/universe-pool/index.js';
import {
  LSE_ETP_POOL,
  liveSizingSubclassFor,
  tradeableUniverse,
} from '../../../providers/universe-pool/index.js';
import type { Clock } from '../../../shared/index.js';
import { resolveVenuePacing, TokenBucket } from '../../../shared/index.js';
import { guardedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import type { ProductionConfig } from './config.js';

export const BROKER_VENUE_ENV_VAR = 'SAMURAI_BROKER';

const BROKER_VENUES = ['alpaca', 'saxo'] as const;

export type BrokerVenue = (typeof BROKER_VENUES)[number];

export function resolveBrokerVenue(env: NodeJS.ProcessEnv = process.env): BrokerVenue {
  const raw = env[BROKER_VENUE_ENV_VAR];
  if (raw === undefined) return 'alpaca';
  const venue = BROKER_VENUES.find((candidate) => candidate === raw);
  if (venue === undefined) {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR} must be one of ` +
        `${BROKER_VENUES.join('|')} (got '${raw}'; the value is matched exactly and is not ` +
        'trimmed). Leave it unset for the Alpaca venue every shipped profile runs on.',
    );
  }
  return venue;
}

export function saxoTradeableUniverse(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): UniverseInstrument[] {
  return tradeableUniverse(pool).map((row) => {
    const subclass = liveSizingSubclassFor(row);
    return {
      asset: row.lse_ticker,
      asset_class: 'stocks' as const,
      ...(subclass === undefined ? {} : { subclass }),
    };
  });
}

export interface SaxoVenueDeps {
  mode: ProductionConfig['mode'];
  universe: readonly UniverseInstrument[];
  accountState: ProductionConfig['accountState'];
  accountFunding?: ProductionConfig['accountFunding'];
  db: StoreHandle;
  logger: Logger;
  legResizeAlerts: LegResizeUnverifiedAlertChannel;
  dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  clock?: Clock;
  client?: SaxoOpenApiClient;
  tokenSource?: SaxoTokenSource;
  rateLimiter?: TokenBucket;
}

export async function buildSaxoBroker(deps: SaxoVenueDeps): Promise<BrokerAdapter> {
  assertSaxoVenueBootable(deps);

  const tradeable = new Map(tradeableUniverse().map((row) => [row.lse_ticker, row]));
  assertUniverseIsRoutable(deps.universe, tradeable);

  const client =
    deps.client ??
    new SaxoHttpBrokerClient({
      environment: 'sim',
      logger: deps.logger,
      tokenSource: deps.tokenSource ?? buildSaxoTokenSource('sim', deps.logger),
      rateLimiter: deps.rateLimiter ?? buildSaxoRateLimiter(deps.logger),
    });

  const rows = deps.universe.flatMap((instrument) => {
    const row = tradeable.get(instrument.asset);
    return row === undefined ? [] : [row];
  });
  const instruments = await saxoInstrumentResolverFromVenue(rows, client);
  const unresolved = deps.universe.filter(
    (instrument) => instruments.resolve(instrument.asset) === undefined,
  );
  if (unresolved.length > 0) {
    throw new Error(
      'Orchestrator cannot start: the Saxo venue resolved no instrument for ' +
        `${unresolved.map((instrument) => instrument.asset).join(', ')}, so an order for ` +
        'those names could not be routed. The pool records a Saxo line for every tradeable ' +
        'row, so this is a venue disagreement rather than a pool gap — re-verify the lines ' +
        'against the gateway before trading them.',
    );
  }

  logResolvedUnits(deps, instruments);

  return new SaxoBrokerAdapter({
    client,
    instruments,
    state: new SqliteBrokerStateStore(guardedStore(deps.db, 'execution')),
    legResizeAlerts: deps.legResizeAlerts,
    dormantLegsAlerts: deps.dormantLegsAlerts,
    priceUnitAlerts: deps.priceUnitAlerts,
    logger: deps.logger,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}

function logResolvedUnits(deps: SaxoVenueDeps, instruments: SaxoInstrumentResolver): void {
  deps.logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'saxo_venue_built',
    level: 'info',
    message: `Saxo broker adapter built for ${deps.universe.length} LSE ETP lines`,
    payload: {
      venue: 'saxo',
      mode: deps.mode,
      environment: 'sim',
      lines: deps.universe.flatMap((instrument) => {
        const ref = instruments.resolve(instrument.asset);
        return ref === undefined
          ? []
          : [
              {
                asset: instrument.asset,
                uic: ref.uic,
                asset_type: ref.asset_type,
                currency: ref.currency,
                price_currency: ref.price_currency,
                price_to_contract_factor: ref.price_to_contract_factor,
              },
            ];
      }),
    },
  });
}

function buildSaxoRateLimiter(logger: Logger): TokenBucket {
  return new TokenBucket(resolveVenuePacing().saxo, undefined, { logger, name: 'saxo' });
}

export function buildSaxoVenueClient(
  logger: Logger,
  tokenSource: SaxoTokenSource = buildSaxoTokenSource('sim', logger),
): SaxoHttpBrokerClient {
  return new SaxoHttpBrokerClient({
    environment: 'sim',
    logger,
    tokenSource,
    rateLimiter: buildSaxoRateLimiter(logger),
  });
}

export function buildSaxoTokenSource(
  environment: SaxoTradingEnvironment,
  logger: Logger,
  deps: {
    env?: NodeJS.ProcessEnv;
    tokenPath?: string;
    sessionLostAlerts?: SaxoSessionLostAlertChannel;
  } = {},
): SaxoTokenSource {
  const env = deps.env ?? process.env;
  const path = deps.tokenPath ?? tokenFilePath(environment);
  if (savedSessionExists(path)) {
    const refresher = new SaxoTokenRefresher({
      environment,
      config: resolveSaxoOAuthConfig(environment, env),
      tokenPath: path,
      logger,
      ...(deps.sessionLostAlerts === undefined
        ? {}
        : { sessionLostAlerts: deps.sessionLostAlerts }),
    });
    const state = refresher.start();
    if (state.status !== 'lost') {
      logger.log({
        trace_id: 'startup',
        stage: 'orchestrator',
        event: 'saxo_session_resumed',
        level: 'info',
        message: `Saxo ${environment} session resumed from the saved login`,
        payload: { venue: 'saxo', environment, ...state },
      });
    }
    return refresher;
  }
  const names = SAXO_CREDENTIAL_ENV_VARS[environment];
  const pasted = env[names.token]?.trim();
  if (pasted !== undefined && pasted.length > 0) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'saxo_session_unrefreshable',
      level: 'warn',
      message: `Saxo ${environment} run is using the pasted ${names.token}; it cannot be renewed and expires on the gateway's own schedule`,
      payload: { environment, token_file: path, source: 'env' },
    });
    return new StaticSaxoTokenSource(pasted);
  }
  throw new Error(
    `Orchestrator cannot start: the Saxo ${environment} venue has no bearer. Run ` +
      `\`npm run saxo:login -- --env ${environment}\` once to save a refreshable session at ${path}, ` +
      `or set ${names.token} to a portal token for a single short run.`,
  );
}

function assertSaxoVenueBootable(deps: SaxoVenueDeps): void {
  if (deps.mode === 'live') {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR}=saxo was selected with ` +
        'SAMURAI_MODE=live. The Saxo venue is wired against the SIM gateway only: the ' +
        "live-money gates (npm run check:live-gates) are open, and #949's currency-mismatch " +
        'refusal is lifted only by a same-currency account read (#1509 wires ' +
        'GET /port/v1/balances/me for that) whose currency has never been observed on the live ' +
        'UK GIA. Run it with SAMURAI_MODE=paper, or leave the venue unset to run ' +
        'the Alpaca path.',
    );
  }

  if (deps.accountState === undefined && deps.accountFunding === undefined) {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR}=saxo requires ` +
        'ProductionConfig.accountFunding (or a whole accountState) to be supplied. The ' +
        "default funding read is Alpaca's USD GET /v2/account, and sizing a GBP LSE book off " +
        'a USD account balance is exactly the currency mismatch #949 refuses every live entry ' +
        "on — so this venue will not inherit another venue's ledger. Since #1509 the read it " +
        'wants exists: saxoFunding(client) over GET /port/v1/balances/me, which the entrypoint ' +
        'supplies. A programmatic config has to pass one of the two deliberately — and an ' +
        'accountFunding passed to startFromEnvironment is currency-verified there ' +
        '(assertSameCurrencyFunding), the same as the one it builds itself.',
    );
  }
}

function assertUniverseIsRoutable(
  universe: readonly UniverseInstrument[],
  tradeable: ReadonlyMap<string, LseEtpPoolRow>,
): void {
  if (universe.length === 0) {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR}=saxo was selected with an empty ` +
        'universe, so the adapter would be constructed to trade nothing. Pass ' +
        "saxoTradeableUniverse() (production/saxo-venue.ts), which is the LSE ETP pool's own " +
        'tradeable set.',
    );
  }

  const unroutable = universe.filter((instrument) => !tradeable.has(instrument.asset));
  if (unroutable.length > 0) {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR}=saxo was selected for a universe ` +
        `holding ${unroutable.map((instrument) => instrument.asset).join(', ')}, which the ` +
        'LSE ETP pool does not declare tradeable on this venue (ADR-0016, and see ' +
        'saxoTradeableUniverse). The Saxo adapter routes by lse_ticker, so those names have ' +
        'no Uic and every order for them would be refused mid-tick. Configure the universe ' +
        'as saxoTradeableUniverse() rather than narrowing it by hand.',
    );
  }
}
