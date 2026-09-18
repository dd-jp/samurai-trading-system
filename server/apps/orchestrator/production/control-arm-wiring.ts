import type {
  BrokerAdapter,
  ExecutionConfig,
  SharedStore as ExecutionSharedStore,
} from '../../../pipeline/execution/index.js';
import {
  FilledZeroSizeThrottle,
  UnrecordedVenuePositionThrottle,
} from '../../../pipeline/execution/index.js';
import type {
  BreakerStatePersistence,
  CircuitBreakers,
  PersistedBreakerState,
} from '../../../pipeline/risk-manager/index.js';
import type { MarketDataService } from '../../../providers/market-data-service/index.js';
import type { Logger } from '../../../shared/index.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import {
  AnalystViewRelay,
  buildControlAnalystsStep,
  buildControlArmStep,
  buildControlDebateStep,
  type ControlArmStep,
  InMemoryCurrentTickStore,
} from '../control-arm.js';
import { SequentialTickRunner } from '../tick-runner.js';
import type { TickSteps } from '../types.js';
import {
  type AccountStateProvider,
  buildExecutionStep,
  buildExecutionSurface,
  buildRiskStep,
  buildTraderSteps,
  buildVerdictStep,
  type ExecutionStepDeps,
  type PortfolioSnapshot,
  type RiskStepDeps,
  type TraderStepDeps,
  type VerdictStepDeps,
} from './direct-bind.js';

export class InMemoryBreakerStatePersistence implements BreakerStatePersistence {
  #states: readonly PersistedBreakerState[] = [];

  load(): readonly PersistedBreakerState[] {
    return this.#states;
  }

  save(states: readonly PersistedBreakerState[]): void {
    this.#states = states;
  }
}

export interface ControlArmWiringDeps {
  trader: TraderStepDeps;
  risk: RiskStepDeps;
  verdict: VerdictStepDeps;
  execution: ExecutionStepDeps;

  store: ExecutionSharedStore;
  broker: BrokerAdapter;
  circuitBreakers: CircuitBreakers;
  breakerState: BreakerStatePersistence;
  accountState: AccountStateProvider;
  costModel: CostModel;
  marketData: MarketDataService;
  executionConfig: ExecutionConfig;
  logger: Logger;
}

export interface ControlArmWiring {
  controlArm: ControlArmStep;
  fillSyncExecution: ReturnType<typeof buildExecutionSurface>;
  reconcileExecution: ReturnType<typeof buildExecutionSurface>;
  store: ExecutionSharedStore;
}

export const CONTROL_FILL_SYNC_TRACE_ID = 'control-arm-fill-sync';
export const CONTROL_RECONCILE_TRACE_ID = 'control-arm-reconcile';

export function buildControlArmWiring(deps: ControlArmWiringDeps): ControlArmWiring {
  const relay = new AnalystViewRelay();

  const executionDeps: ExecutionStepDeps = {
    ...deps.execution,
    broker: deps.broker,
    store: deps.store,
    costModel: deps.costModel,
    marketData: deps.marketData,
    config: deps.executionConfig,
    logger: deps.logger,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
  };

  const breakerOverrides = {
    circuitBreakers: deps.circuitBreakers,
    breakerState: deps.breakerState,
    accountState: deps.accountState,
    portfolioSnapshots: new Map<string, PortfolioSnapshot>(),
    getOpenPositions: () => deps.store.getOpenPositions(),
  };

  const traderSteps = buildTraderSteps({
    ...deps.trader,
    ...breakerOverrides,
    arm: 'control',
    getExitFillSizes: (keys) => deps.store.getExitFillSizes(keys),
    getUnresolvedFlattens: () => deps.store.getUnresolvedFlattens(),
  });

  const controlSteps: TickSteps = {
    exitCheck: traderSteps.exitCheck,
    trader: traderSteps.trader,
    analysts: buildControlAnalystsStep(relay),
    debate: buildControlDebateStep(relay),
    risk: buildRiskStep({
      ...deps.risk,
      ...breakerOverrides,
      critic: undefined,
    }),
    verdict: buildVerdictStep({
      ...deps.verdict,
      ...breakerOverrides,
      positionStore: deps.store,
    }),
    execution: buildExecutionStep(executionDeps),
  };

  return {
    controlArm: buildControlArmStep({
      runner: new SequentialTickRunner(controlSteps),
      relay,
      currentTickStore: new InMemoryCurrentTickStore(),
      logger: deps.logger,
    }),
    fillSyncExecution: buildExecutionSurface(executionDeps, CONTROL_FILL_SYNC_TRACE_ID),
    reconcileExecution: buildExecutionSurface(executionDeps, CONTROL_RECONCILE_TRACE_ID),
    store: deps.store,
  };
}
