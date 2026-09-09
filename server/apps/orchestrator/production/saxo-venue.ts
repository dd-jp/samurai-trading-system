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
 * - **No injected `accountState`.** `SaxoOpenApiClient` exposes no balances
 *   endpoint at all (saxo-client.ts), so the only funding read this repo has
 *   is `AlpacaAccountStateProvider`'s USD `GET /v2/account`. Sizing a GBP book
 *   off a USD account is the #949 mismatch, so the venue refuses to boot
 *   rather than sizing off the wrong currency. #946 carries the GBP-native
 *   account read.
 * - **A universe this venue does not trade.** The adapter routes by
 *   `lse_ticker`; anything else has no Uic, and an instrument that silently
 *   drops out of the resolver reads as a pool gap rather than a wiring one.
 *
 * ## NOT REACHABLE FROM `main()` TODAY, and that is deliberate
 *
 * The entrypoint supplies no `accountState` — no GBP-native account read
 * exists in this repo (#946 owns it) — so an operator setting
 * `SAMURAI_BROKER=saxo` gets the `accountState` refusal above, by design and
 * not by omission. Everything below is reachable from a PROGRAMMATIC config
 * that injects one, which is what this branch's tests drive. Do not read the
 * venue's tests as evidence of an operator boot.
 */
import type {
  BrokerAdapter,
  DormantLegsUnresolvedAlertChannel,
  LegResizeUnverifiedAlertChannel,
  SaxoOpenApiClient,
  UnresolvedPriceUnitAlertChannel,
} from '../../../pipeline/execution/index.js';
import {
  SaxoBrokerAdapter,
  SaxoHttpBrokerClient,
  SqliteBrokerStateStore,
  saxoInstrumentResolverFromVenue,
} from '../../../pipeline/execution/index.js';
import { isBookCurrency } from '../../../providers/market-data-service/index.js';
import type { LseEtpPoolRow } from '../../../providers/universe-pool/index.js';
import {
  gateAdmits,
  LSE_ETP_POOL,
  liveSizingSubclassFor,
} from '../../../providers/universe-pool/index.js';
import type { Clock } from '../../../shared/index.js';
import { resolveVenuePacing, TokenBucket } from '../../../shared/index.js';
import { guardedStore, type SharedStore as SqliteHandle } from '../../../shared/store/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import type { ProductionConfig } from './config.js';

/** Which venue the run's `BrokerAdapter` is built against. */
export const BROKER_VENUE_ENV_VAR = 'SAMURAI_BROKER';

export const BROKER_VENUES = ['alpaca', 'saxo'] as const;

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
 * True for a pool row the Saxo venue may trade today: admitted by the
 * liquidity gate AND quoted in a currency the GBP book can carry without an
 * FX rate.
 *
 * The sterling half is `isBookCurrency`'s — the same predicate
 * `LseMarkDataSource` refuses a universe on, so the mark path and the order
 * path cannot disagree about which lines are tradeable. #1220 lands
 * `tradeableUniverse()` over the pool with exactly this shape; when it
 * merges, this becomes a call to it.
 *
 * WIDTH IS NOT THIS TICKET'S. #1310 ruled the live ramp widens to the 94
 * sterling Etn/Etc lines gated on burst-sampled p25 spread and ranked on
 * RelativeVolume; that widening is not built, and the venue trades the
 * checked-in pool's tradeable set until it is.
 */
function isSaxoTradeable(row: LseEtpPoolRow): boolean {
  return gateAdmits(row) && isBookCurrency(row.currency);
}

/**
 * The universe a Saxo run ticks AND the list its gates are keyed to — one
 * list, for `buildStartingProfileConfigs`'s reason (#739): a D5 envelope
 * armed off one universe while another is traded is a tick-time refusal
 * invisible at boot.
 *
 * `subclass` comes from `liveSizingSubclassFor`, so a row whose envelope has
 * not been MEASURED carries none and sizes on the generic ATR path rather
 * than on a D5 bracket nobody has calibrated for it.
 */
export function saxoTradeableUniverse(
  pool: readonly LseEtpPoolRow[] = LSE_ETP_POOL,
): UniverseInstrument[] {
  return pool.filter(isSaxoTradeable).map((row) => {
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
  /** The configured universe, checked against what this venue can actually route. */
  universe: readonly UniverseInstrument[];
  /** `ProductionConfig.accountState` — REQUIRED here; see the module doc. */
  accountState: ProductionConfig['accountState'];
  db: SqliteHandle;
  logger: Logger;
  legResizeAlerts: LegResizeUnverifiedAlertChannel;
  dormantLegsAlerts: DormantLegsUnresolvedAlertChannel;
  priceUnitAlerts: UnresolvedPriceUnitAlertChannel;
  clock?: Clock;
  /** `ProductionConfig.saxoBrokerClient` — the wire client, defaulted to the SIM gateway. */
  client?: SaxoOpenApiClient;
  /** The account's shared outbound bucket, matching what `production.ts` does for Alpaca. */
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

  const tradeable = new Map(
    LSE_ETP_POOL.filter(isSaxoTradeable).map((row) => [row.lse_ticker, row]),
  );
  assertUniverseIsRoutable(deps.universe, tradeable);

  const client =
    deps.client ??
    new SaxoHttpBrokerClient({
      // `sim` unconditionally: `assertSaxoVenueBootable` has already refused
      // `live`, so no live bearer token is reachable from this module at all.
      environment: 'sim',
      logger: deps.logger,
      rateLimiter: deps.rateLimiter ?? buildSaxoRateLimiter(deps.logger),
    });

  // Every asset is in `tradeable` — `assertUniverseIsRoutable` above refused
  // otherwise — so the empty branch is unreachable, not a silent drop.
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

function assertSaxoVenueBootable(deps: SaxoVenueDeps): void {
  if (deps.mode === 'live') {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR}=saxo was selected with ` +
        'SAMURAI_MODE=live. The Saxo venue is wired against the SIM gateway only: the ' +
        "live-money gates (yarn check:live-gates) are open, and #949's currency-mismatch " +
        'refusal stands until a same-currency GBP-native account read exists (#946). Run it ' +
        'with SAMURAI_MODE=paper, or leave the venue unset to run the Alpaca path.',
    );
  }

  if (deps.accountState === undefined) {
    throw new Error(
      `Orchestrator cannot start: ${BROKER_VENUE_ENV_VAR}=saxo requires ` +
        "ProductionConfig.accountState to be supplied. Saxo's OpenAPI surface in this repo " +
        '(saxo-client.ts) has no balances endpoint, so the only funding read available is ' +
        "AlpacaAccountStateProvider's USD GET /v2/account — and sizing a GBP LSE book off a " +
        'USD account balance is exactly the currency mismatch #949 refuses every live entry ' +
        'on. #946 carries the GBP-native account read; until it lands the equity this venue ' +
        'sizes against has to be supplied deliberately, not inherited from another venue.',
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
