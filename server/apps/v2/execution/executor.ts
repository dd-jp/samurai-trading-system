import type {
  ExecutionRoute,
  FillSweep,
  OrderExecutor,
  RiskApprovedOrder,
  Submission,
  V2Fill,
  Venue,
} from '../../../../contracts/index.js';
import type { BrokerAck, BrokerAdapter } from '../../../pipeline/execution/index.js';
import { describeThrownSafely } from '../../../shared/index.js';
import { consumeApproval } from '../risk/index.js';
import { DryRunRefusedError } from './dry-run-broker.js';
import { type ChildOrder, childOrders } from './slicing.js';

export interface ExecutorDeps {
  readonly brokers: Partial<Readonly<Record<Venue, BrokerAdapter>>>;
  readonly simulatedBroker: BrokerAdapter;
  readonly dryRun: boolean;
}

export class UnapprovedOrderError extends Error {
  constructor(clientOrderId: string) {
    super(`executor refuses ${clientOrderId}: not approved by the risk module (doc 66 D6)`);
    this.name = 'UnapprovedOrderError';
  }
}

function send(
  broker: BrokerAdapter,
  order: RiskApprovedOrder,
  child: ChildOrder,
): Promise<BrokerAck> {
  if (order.kind === 'flatten') {
    return broker.submitFlatten(order.instrument, order.side, child.size, child.clientOrderId);
  }
  return broker.submitBracket({
    client_order_id: child.clientOrderId,
    instrument: order.instrument,
    asset_class: 'stocks',
    side: order.side,
    size: child.size,
    entry: order.entry,
    stop: order.stop,
    target: order.target,
    time_in_force: 'gtc',
  });
}

function failedSubmission(order: RiskApprovedOrder, error: unknown): Submission {
  const { approvalId } = order;
  if (!(error instanceof DryRunRefusedError)) {
    return { outcome: 'rejected', detail: describeThrownSafely(error), approvalId };
  }
  const outcome = order.bookVariant === 'primary' ? 'refused_dry_run' : 'simulated';
  return { outcome, detail: error.message, approvalId };
}

export class V2OrderExecutor implements OrderExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  simulates(route: ExecutionRoute): boolean {
    return this.deps.dryRun || route.bookVariant !== 'primary';
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
      return failedSubmission(order, error);
    }
  }

  async cancel(route: ExecutionRoute, clientOrderId: string, instrument: string): Promise<void> {
    await this.#brokerFor(route)?.cancel(clientOrderId, instrument);
  }

  async resumeFlatten(
    route: ExecutionRoute,
    clientOrderId: string,
    instrument: string,
  ): Promise<void> {
    if (this.simulates(route)) return;
    await this.#brokerFor(route)?.resumeFlatten(clientOrderId, instrument);
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
          });
        }
      } catch (error) {
        failures.push(describeThrownSafely(error));
      }
    }
    return { fills, failures };
  }

  #brokerFor(route: ExecutionRoute): BrokerAdapter | undefined {
    return this.simulates(route) ? this.deps.simulatedBroker : this.deps.brokers[route.venue];
  }

  #sweptBrokers(): readonly BrokerAdapter[] {
    const all = new Set<BrokerAdapter>([this.deps.simulatedBroker]);
    if (!this.deps.dryRun) {
      for (const broker of Object.values(this.deps.brokers)) {
        if (broker !== undefined) all.add(broker);
      }
    }
    return [...all];
  }
}
