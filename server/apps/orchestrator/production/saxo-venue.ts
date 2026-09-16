/**
 * The Saxo venue seam of the composition root (#1400).
 *
 * `SaxoBrokerAdapter` has been built, tested and unreachable since #1032:
 * nothing outside its own tests ever constructed it, so the LSE ETP book
 * ADR-0015/ADR-0016 describe had no venue and #1149's soak move had nowhere
 * to go. This module is the caller — the "No-Caller Defect" this repo keeps
 * refiling as its dominant class, closed for this adapter.
 *
 * ## Why it lives beside the composition root rather than inside it
 *
 * `saxoInstrumentResolverFromVenue` reads `/ref/v1/instruments/details` once
 * per line, because the venue is the only source for the quote unit a price
 * is denominated in (#1302). That makes construction ASYNC, and
 * `buildProductionComponents`/`buildProductionOrchestrator` are synchronous by
 * design. So the adapter is built one level up, in `startFromEnvironment`
 * (index.ts), which is already async, and handed in through
 * `ProductionConfig.broker` — the seam whose own doc comment says it is
 * "where `SimulatedBrokerAdapter` ... or a future ccxt/IBKR adapter binds
 * without the composition root growing a broker-selection branch".
 *
 * ## What this refuses, and why each refusal is not "missing wiring"
 *
 * - **`live`.** `LIVE_MONEY_GATES` (live-money-gates.ts) still names two open
 *   gates, and #949's currency-mismatch refusal is a standing structural one
 *   that a GBP-native adapter does not by itself lift. Refusing here also
 *   means no live Saxo token is ever read: `SaxoHttpBrokerClient` is built
 *   against the `sim` gateway unconditionally.
 * - **No funding read at all.** Sizing a GBP book off Alpaca's USD
 *   `GET /v2/account` is the #949 mismatch, so the venue refuses to boot
 *   rather than size off the wrong currency. Since #1509 the read exists —
 *   `SaxoHttpBrokerClient.getBalances()` over `GET /port/v1/balances/me` —
 *   so this refusal is satisfied by EITHER an injected `accountState` or an
 *   `accountFunding` source, and the entrypoint supplies the latter. It is
 *   still a refusal and not a formality: the read reports the account's own
 *   `Currency`, `assertSameCurrencyFunding` refuses the boot outright when it
 *   is not the book's, and on the SIM trial account it is `EUR` (doc 44
 *   §6.3). What clears #949 is that comparison — never the fact that the
 *   venue is Saxo UK.
 * - **A universe this venue does not trade.** The adapter routes by
 *   `lse_ticker`; anything else has no Uic, and an instrument that silently
 *   drops out of the resolver reads as a pool gap rather than a wiring one.
 *
 * ## Wired from `main()` since #1509 — as far as the funding read
 *
 * The entrypoint now builds one `SaxoHttpBrokerClient` and hands it to both
 * this venue and `saxoFunding`, so `SAMURAI_BROKER=saxo` no longer needs a
 * programmatic `accountState` to get past composition. It still does not
 * reach a tick: the read then answers the SIM trial account's `EUR` and
 * `assertSameCurrencyFunding` refuses the boot. That refusal is the point —
 * the alternative is a GBP-declared book sized off a EUR balance. The `live`
 * refusal above is untouched, so nothing here has been measured against the
 * UK GIA.
 *
 * ## What a real SIM boot measured (#1400 AC3, 2026-09-11)
 *
 * Everything below this module's two refusals works against the live SIM
 * gateway: the resolver reads `/ref/v1/instruments/details` for all five
 * tradeable lines, the adapter constructs, and the orchestrator reaches its
 * startup reconcile. The two seams an operator still has to supply by hand
 * were `accountState` (now supplied from `GET /port/v1/balances/me`, #1509)
 * and `lseMarkClient` (#895, still an open owner decision, still not wiring).
 * Doc 44 §6 carries the run.
 */
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

/** Which venue the run's `BrokerAdapter` is built against */
export const BROKER_VENUE_ENV_VAR = 'SAMURAI_BROKER';

const BROKER_VENUES = ['alpaca', 'saxo'] as const;

export type BrokerVenue = (typeof BROKER_VENUES)[number];

/**
 * The venue the operator asked for, `alpaca` when they asked for nothing.
 *
 * Deliberately shaped like `parseMode` (index.ts) rather than like a lookup
 * with a fallback: an absent variable resolves to the venue that has been
 * running since #273, an unrecognised one throws, and the value is NOT
 * trimmed — so `'saxo '` out of a shell heredoc is refused instead of
 * quietly selecting a venue whose adapter has never placed a real order. The
 * asymmetry is the point: `saxo` is reachable only by an operator typing it
 * exactly, and by nothing else.
 */
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

/**
 * The universe a Saxo run ticks AND the list its gates are keyed to — one
 * list, for `buildStartingProfileConfigs`'s reason (#739): a D5 envelope
 * armed off one universe while another is traded is a tick-time refusal
 * invisible at boot.
 *
 * The tradeable set is `tradeableUniverse()`'s (#1220), never a local
 * predicate over `LSE_ETP_POOL`: that function is the pool's own account of
 * which rows a live consumer may trade, and a second copy of the rule here
 * would diverge from it the first time the ruling moves. This branch shipped
 * such a copy before #1220 merged; it is now the call its own docblock
 * promised.
 *
 * `subclass` comes from `liveSizingSubclassFor`, so a row whose envelope has
 * not been MEASURED carries none. That is NOT a generic-ATR fallback:
 * `resolveSubclassBracket` only falls back when `subclass_of` is empty, and
 * throws for a missing name once any row carries one (3KOR/3KWE today).
 *
 * WIDTH IS NOT THIS TICKET'S. #1310 ruled the live ramp widens to the 94
 * sterling Etn/Etc lines gated on burst-sampled p25 spread and ranked on
 * RelativeVolume; that widening is not built, and the venue trades the
 * checked-in pool's tradeable set until it is.
 */
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
  /** The configured universe, checked against what this venue can actually route */
  universe: readonly UniverseInstrument[];
  /** `ProductionConfig.accountState` — one of this and `accountFunding` is REQUIRED; see the module doc */
  accountState: ProductionConfig['accountState'];
  /** `ProductionConfig.accountFunding` — the GBP-native read (#1509) */
  accountFunding?: ProductionConfig['accountFunding'];
  db: StoreHandle;
  logger: Logger;
  legResizeAlerts: LegResizeUnverifiedAlertChannel;
  dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  clock?: Clock;
  /** `ProductionConfig.saxoBrokerClient` — the wire client, defaulted to the SIM gateway */
  client?: SaxoOpenApiClient;
  /** The bearer the default client reads per request (#1523); ignored when `client` is injected */
  tokenSource?: SaxoTokenSource;
  /** The account's shared outbound bucket, matching what `production.ts` does for Alpaca */
  rateLimiter?: TokenBucket;
}

/**
 * Builds the Saxo `BrokerAdapter` for `deps.universe`, or throws naming what
 * the operator has to fix. Every throw here happens BEFORE any order path
 * exists, which is the point: the alternative is a run that boots and
 * discovers on its first entry that it cannot price, size or route.
 */
export async function buildSaxoBroker(deps: SaxoVenueDeps): Promise<BrokerAdapter> {
  assertSaxoVenueBootable(deps);

  const tradeable = new Map(tradeableUniverse().map((row) => [row.lse_ticker, row]));
  assertUniverseIsRoutable(deps.universe, tradeable);

  const client =
    deps.client ??
    new SaxoHttpBrokerClient({
      // `sim` unconditionally: `assertSaxoVenueBootable` has already refused
      // `live`, so no live bearer token is reachable from this module at all
      environment: 'sim',
      logger: deps.logger,
      tokenSource: deps.tokenSource ?? buildSaxoTokenSource('sim', deps.logger),
      rateLimiter: deps.rateLimiter ?? buildSaxoRateLimiter(deps.logger),
    });

  // Every asset is in `tradeable` — `assertUniverseIsRoutable` above refused
  // otherwise — so the empty branch is unreachable, not a silent drop
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

/**
 * The quote unit each line resolved to, recorded at boot.
 *
 * `PriceToContractFactor` is read once per line from the venue and then used
 * to turn every price this adapter sends or receives into cash
 * (saxo-price-unit.ts). A wrong factor is a 100x order (#1302), and until
 * this line existed the resolved value was held only in memory and appeared
 * in no log, no audit row and no alert — so a run could not be checked after
 * the fact against the units it actually traded on. The token and the
 * gateway URL are deliberately absent: `environment` names which gateway
 * without quoting a credential.
 */
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
      // 'sim' is asserted, not observed: buildSaxoBroker refuses live, and an
      // injected client is not inspected for its gateway
      environment: 'sim',
      // Every asset resolves — the caller threw otherwise — so the empty
      // branch drops nothing
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

/**
 * The account's shared Saxo bucket, built here rather than left to
 * `SaxoHttpBrokerClient`'s own default for `production.ts`'s Alpaca reason:
 * the pacing budget belongs to the ACCOUNT, so the composition root owns the
 * one instance and gives it the telemetry that makes a wait on it observable
 * (#1083). `saxo-http-client.ts`'s own doc names this function as the bucket
 * its `telemetry` option never reaches.
 */
function buildSaxoRateLimiter(logger: Logger): TokenBucket {
  return new TokenBucket(resolveVenuePacing().saxo, undefined, { logger, name: 'saxo' });
}

/**
 * The ONE Saxo client a run may hold (#1509), for a caller that needs both the
 * broker and the funding read. Two clients would be two token budgets against
 * the account's one rate limit — the same invariant `buildSaxoRateLimiter`
 * exists for, which is why the bucket is built here and not inside the client.
 *
 * `sim` unconditionally, matching `buildSaxoBroker`: no live token is read on
 * any path this venue reaches.
 */
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

/**
 * Where the run's Saxo bearer comes from (#1523), in strict precedence:
 *
 * 1. **A saved `npm run saxo:login` session** (`data/saxo-tokens/<env>.json`) —
 *    the refresher, which rotates the refresh token before its window closes
 *    and reports the session lost when it cannot. A file that is present but
 *    expired or unreadable still takes this branch and still reports lost: a
 *    fall-through to the pasted token below would put the run back on a
 *    bearer nothing can renew, which is the 401 this ticket exists to remove,
 *    now invisible.
 * 2. **A pasted `SAXO_{SIM,LIVE}_ACCESS_TOKEN`** — the pre-#1523 developer
 *    portal token. Kept because it is what every SIM run used until now, and
 *    logged as unrefreshable so a soak that dies at the 24-hour mark is
 *    diagnosable from its own startup line.
 * 3. Neither: refuse, naming the login command.
 *
 * Parameterised by environment and not hardcoded to `sim` even though the
 * venue only ever passes `sim` (it refuses `SAMURAI_MODE=live` outright): the
 * live path differs only in which file and which app credentials it reads, so
 * the branch that would have to be written later is the one already tested.
 */
export function buildSaxoTokenSource(
  environment: SaxoTradingEnvironment,
  logger: Logger,
  /**
   * `tokenPath` overrides `tokenFilePath(environment)`, for `RunLoginDeps`'
   * reason (saxo-login.ts): a test must be able to exercise the precedence
   * above against a sandboxed file, and never against the operator's real
   * saved session. `sessionLostAlerts` (#1524) is forwarded to the refresher
   * unchanged — absent under `SAMURAI_ALERTS=log-only`, since
   * `saxoSessionLostAlerts` has no log-only form (the refresher's own
   * `saxo_session_lost` line already covers that mode).
   */
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
    // Primed HERE rather than on the first order: an expired or unreadable
    // saved session is an operator problem (`npm run saxo:login` again), and a
    // boot that stays silent about it defers the news to the first trade of
    // the session. Not a throw — the precedence above deliberately keeps a
    // lost refresher instead of falling back to an unrenewable bearer, and
    // alerting on the state is #1524
    const state = refresher.start();
    // A lost session already logged `saxo_session_lost` from inside `start()`;
    // restating it here would double every boot failure
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
