import type {
  ExecutionRoute,
  FillSweep,
  OrderExecutor,
  ResumedExit,
  RiskApprovedOrder,
  SimulatedFillQuote,
  SimulatedFillRequest,
  Submission,
  V2Fill,
  Venue,
} from '../../../../contracts/index.js';
import { type BrokerAck, type BrokerAdapter, describeThrownSafely } from '../../../shared/index.js';
import { consumeApproval } from '../risk/index.js';
import { DryRunRefusedError } from './dry-run-broker.js';
import { type FillPricing, quoteSimulatedFill } from './simulated-costs.js';
import { type ChildOrder, childOrders } from './slicing.js';

export interface ExecutorDeps {
  readonly brokers: Partial<Readonly<Record<Venue, BrokerAdapter>>>;
  readonly simulatedBrokers: Readonly<Record<Venue, BrokerAdapter>>;
  readonly pricing: FillPricing;
  readonly dryRun: boolean;
}

export class UnapprovedOrderError extends Error {
  constructor(clientOrderId: string) {
    super(`executor refuses ${clientOrderId}: not approved by the risk module (doc 66 D6)`);
    this.name = 'UnapprovedOrderError';
  }
}

async function sendRearm(
  broker: BrokerAdapter,
  entryClientOrderId: string,
  instrument: string,
  closingSide: 'buy' | 'sell',
  child: ChildOrder,
  stop: number,
  target: number,
): Promise<BrokerAck> {
  const entrySide = closingSide === 'buy' ? 'sell' : 'buy';
  await broker.rearmProtectiveLegs(
    entryClientOrderId,
    instrument,
    entrySide,
    child.size,
    stop,
    target,
  );
  return { client_order_id: child.clientOrderId, broker_order_ids: [], order_state: 'submitted' };
}

function sendFlatten(
  broker: BrokerAdapter,
  order: Extract<RiskApprovedOrder, { kind: 'flatten' }>,
  child: ChildOrder,
): Promise<BrokerAck> {
  if (broker.submitProtectedExit === undefined) {
    return broker.submitFlatten(order.instrument, order.side, child.size, child.clientOrderId);
  }
  return broker.submitProtectedExit({
    entryClientOrderId: order.entryClientOrderId,
    clientOrderId: child.clientOrderId,
    instrument: order.instrument,
    side: order.side,
    size: child.size,
    rearm:
      order.rearmStop === undefined || order.rearmTarget === undefined
        ? undefined
        : { stop: order.rearmStop, target: order.rearmTarget },
  });
}

function send(
  broker: BrokerAdapter,
  order: RiskApprovedOrder,
  child: ChildOrder,
): Promise<BrokerAck> {
  if (order.kind === 'flatten') return sendFlatten(broker, order, child);
  if (order.kind === 'rearm') {
    return sendRearm(
      broker,
      order.entryClientOrderId,
      order.instrument,
      order.side,
      child,
      order.stop,
      order.target,
    );
  }
  return broker.submitBracket({
    client_order_id: child.clientOrderId,
    instrument: order.instrument,
    asset_class: 'stocks',
    side: order.side,
    size: child.size,
    entry: order.entry,
    entry_trigger: order.entryTrigger,
    stop: order.stop,
    target: order.target,
    time_in_force: 'gtc',
  });
}

function failedSubmission(order: RiskApprovedOrder, error: unknown, dryRun: boolean): Submission {
  const { approvalId } = order;
  if (!(error instanceof DryRunRefusedError)) {
    return { outcome: 'rejected', detail: describeThrownSafely(error), approvalId };
  }
  // A primary order is 'refused_dry_run' only when dryRun made it hit the stub broker;
  // #1400: a non-Alpaca primary hits it regardless (no live adapter), so outside a real dry
  // run that is 'simulated', not a refusal
  const outcome =
    order.bookVariant === 'primary' && (dryRun || order.venue === 'alpaca')
      ? 'refused_dry_run'
      : 'simulated';
  return { outcome, detail: error.message, approvalId };
}

export class V2OrderExecutor implements OrderExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  simulates(route: ExecutionRoute): boolean {
    // #1400: v2 has no live Saxo adapter, so every non-Alpaca route is simulated
    // regardless of dry run or book variant; a venue added later fails closed to simulated
    return this.deps.dryRun || route.bookVariant !== 'primary' || route.venue !== 'alpaca';
  }

  quoteSimulatedFill(venue: Venue, request: SimulatedFillRequest): SimulatedFillQuote {
    return quoteSimulatedFill(venue, request, this.deps.pricing);
  }

  canRoute(route: ExecutionRoute): boolean {
    return this.#brokerFor(route) !== undefined;
  }

  async submit(order: RiskApprovedOrder): Promise<Submission> {
    if (!consumeApproval(order)) throw new UnapprovedOrderError(order.clientOrderId);
    const { approvalId } = order;
    const broker = this.#brokerFor(order);
    if (broker === undefined) {
      return { outcome: 'rejected', detail: `no_broker_for_venue:${order.venue}`, approvalId };
    }
    try {
      const states: string[] = [];
      for (const child of childOrders(order)) {
        states.push((await send(broker, order, child)).order_state);
      }
      return { outcome: 'submitted', detail: states.join(','), approvalId };
    } catch (error) {
      return failedSubmission(order, error, this.deps.dryRun);
    }
  }

  async cancel(route: ExecutionRoute, clientOrderId: string, instrument: string): Promise<void> {
    await this.#brokerFor(route)?.cancel(clientOrderId, instrument);
  }

  async resumeFlatten(
    route: ExecutionRoute,
    clientOrderId: string,
    instrument: string,
  ): Promise<ResumedExit | undefined> {
    if (this.simulates(route)) return undefined;
    const order = await this.#brokerFor(route)?.resumeFlatten(clientOrderId, instrument);
    if (order === undefined || order === null) return undefined;
    return { orderState: order.order_state, filledQty: order.filled_qty };
  }

  async fetchNewFills(sinceIso: string): Promise<FillSweep> {
    const fills: V2Fill[] = [];
    const failures: string[] = [];
    for (const broker of this.#sweptBrokers()) {
      try {
        for (const fill of await broker.fetchNewFills(new Date(sinceIso))) {
          fills.push({
            client_order_id: fill.client_order_id,
            broker_fill_id: fill.broker_fill_id,
            leg: fill.leg,
            price: fill.price,
            qty: fill.qty,
            fee: fill.fee,
            qty_is_cumulative: fill.qty_is_cumulative,
            filled_at: fill.timestamp.toISOString(),
          });
        }
      } catch (error) {
        failures.push(describeThrownSafely(error));
      }
    }
    return { fills, failures };
  }

  #brokerFor(route: ExecutionRoute): BrokerAdapter | undefined {
    return this.simulates(route)
      ? this.deps.simulatedBrokers[route.venue]
      : this.deps.brokers[route.venue];
  }

  #sweptBrokers(): readonly BrokerAdapter[] {
    const all = new Set<BrokerAdapter>(Object.values(this.deps.simulatedBrokers));
    if (!this.deps.dryRun) {
      for (const broker of Object.values(this.deps.brokers)) {
        if (broker !== undefined) all.add(broker);
      }
    }
    return [...all];
  }
}
