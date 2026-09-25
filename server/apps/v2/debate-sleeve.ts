import { randomUUID } from 'node:crypto';
import type { Direction } from '../../../contracts/index.js';
import type {
  AnalystView,
  DebatePersonas,
  DebateResult,
  MediatorAssessment,
  PersonaResponse,
  RoundContext,
} from '../../pipeline/debate-engine/index.js';
import {
  runBearPersona,
  runBullPersona,
  runDebate,
  runMediatorPersona,
} from '../../pipeline/debate-engine/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { averageTrueRange, trailingReturn } from '../../pipeline/momentum/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { inputsHash } from './journal.js';
import type { LlmPanel } from './llm-panel.js';
import { rotateSeats, seatModels } from './llm-panel.js';
import { SHORTS_ENABLED } from './parameters.js';
import { STOP_ATR_MULTIPLE } from './position-size.js';
import type {
  Sleeve,
  SleeveAction,
  SleeveContext,
  SleeveDecision,
  SleeveOutput,
  Venue,
} from './sleeve.js';
import type { BarsSource, UniverseSelection } from './universe.js';
import { barsBefore, selectUniverse } from './universe.js';

const DEBATE_SLEEVE_ID = 'debate';
const DEBATE_MAX_ROUNDS = 1;
const SMA_LONG_WINDOW = 200;
const TRAILING_SHORT_DAYS = 20;
const TRAILING_LONG_DAYS = 63;
const ATR_WINDOW = 20;
const HASHED_HISTORY_DAYS = SMA_LONG_WINDOW;

export interface DebateSleeveDeps {
  readonly panel: LlmPanel;
  readonly bars: BarsSource;
  readonly constituents: (tradingDate: string) => readonly string[];
  readonly venueFor: (symbol: string) => Venue;
  readonly clock: Clock;
  readonly logger?: Logger | undefined;
}

export interface TechnicalRead {
  readonly price: number;
  readonly atr: number | undefined;
  readonly view: AnalystView;
}

function simpleMovingAverage(bars: readonly DailyBar[], window: number): number | undefined {
  if (bars.length < window) return undefined;
  let total = 0;
  for (const bar of bars.slice(-window)) total += bar.close;
  return total / window;
}

function directionFrom(close: number, sma: number | undefined, r63: number | undefined): Direction {
  if (sma === undefined || r63 === undefined) return 'neutral';
  if (close > sma && r63 > 0) return 'bullish';
  if (close < sma && r63 < 0) return 'bearish';
  return 'neutral';
}

export function technicalRead(
  history: readonly DailyBar[],
  traceId: string,
  now: Date,
): TechnicalRead | undefined {
  const last = history.at(-1);
  if (last === undefined) return undefined;
  const closeAt = (index: number) => history[index]?.close;
  const decisionIndex = history.length - 1;
  const r20 = trailingReturn(closeAt, decisionIndex, {
    lookbackDays: TRAILING_SHORT_DAYS,
    skipDays: 0,
  });
  const r63 = trailingReturn(closeAt, decisionIndex, {
    lookbackDays: TRAILING_LONG_DAYS,
    skipDays: 0,
  });
  const sma = simpleMovingAverage(history, SMA_LONG_WINDOW);
  const atr = averageTrueRange(history, decisionIndex, ATR_WINDOW);
  const direction = directionFrom(last.close, sma, r63);
  const format = (value: number | undefined) =>
    value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}%`;
  return {
    price: last.rawClose,
    atr: atr === undefined ? undefined : (atr * last.rawClose) / last.close,
    view: {
      trace_id: traceId,
      analyst_id: 'technical',
      analyst_type: 'technical',
      direction,
      confidence: direction === 'neutral' ? 0.5 : 0.6,
      key_points: [
        `close ${last.close.toFixed(2)} vs 200-day SMA ${sma === undefined ? 'n/a' : sma.toFixed(2)}`,
        `20-day return ${format(r20)}`,
        `63-day return ${format(r63)}`,
        `20-day ATR ${atr === undefined ? 'n/a' : atr.toFixed(4)}`,
      ],
      timestamp: now,
    },
  };
}

function judgeConfidence(bull: PersonaResponse, bear: PersonaResponse, judge: Direction): number {
  const agreeing = [bull.stance, bear.stance].filter((stance) => stance === judge).length;
  return 0.5 + agreeing * 0.25;
}

function buildPersonas(
  panel: LlmPanel,
  tradingDate: string,
  traceId: string,
  debateId: string,
  clock: Clock,
): DebatePersonas {
  const rotation = rotateSeats(tradingDate);
  const bullClient = panel.debaters[rotation.bull];
  const bearClient = panel.debaters[rotation.bear];
  let lastBull: PersonaResponse | undefined;
  let lastBear: PersonaResponse | undefined;
  const input = (context: RoundContext) => ({
    trace_id: traceId,
    debate_id: debateId,
    analyst_views: context.views,
    signal: context.signal,
  });
  return {
    clock,
    bull: {
      async argue(context) {
        lastBull = await runBullPersona(bullClient, input(context));
        return { persona: 'bull', round: context.round, argument: lastBull.rationale };
      },
    },
    bear: {
      async argue(context) {
        lastBear = await runBearPersona(bearClient, input(context));
        return { persona: 'bear', round: context.round, argument: lastBear.rationale };
      },
    },
    mediator: {
      async assess(context): Promise<MediatorAssessment> {
        if (lastBull === undefined || lastBear === undefined) {
          throw new Error('debate-sleeve: judge asked to assess before both debaters argued');
        }
        const verdict = await runMediatorPersona(panel.judge, {
          ...input(context),
          bullResponse: lastBull,
          bearResponse: lastBear,
        });
        return {
          converged: verdict.converged,
          synthesis: {
            synthesis: verdict.rationale,
            position: `${verdict.stance}: ${verdict.rationale}`,
            confidence: judgeConfidence(lastBull, lastBear, verdict.stance),
            direction: verdict.stance,
            disagreement_summary:
              lastBull.stance === lastBear.stance ? '' : 'bull and bear disagree on direction',
            open_items: [],
          },
          stances: context.views.map((view) => ({
            analyst_id: view.analyst_id,
            stance: view.direction,
          })),
        };
      },
    },
  };
}

function actionFor(direction: Direction): Pick<SleeveDecision, 'action' | 'reason'> {
  switch (direction) {
    case 'bullish':
      return { action: 'enter_long', reason: 'judge bullish' };
    case 'bearish':
      return SHORTS_ENABLED
        ? { action: 'enter_short', reason: 'judge bearish' }
        : { action: 'skip', reason: 'shorts_disabled' };
    default:
      return { action: 'none', reason: 'judge neutral' };
  }
}

function stopFor(action: SleeveAction, read: TechnicalRead): number | undefined {
  if (read.atr === undefined) return undefined;
  if (action === 'enter_long') return read.price - STOP_ATR_MULTIPLE * read.atr;
  if (action === 'enter_short') return read.price + STOP_ATR_MULTIPLE * read.atr;
  return undefined;
}

function decisionFrom(
  symbol: string,
  venue: Venue,
  read: TechnicalRead,
  hash: string,
  result: DebateResult,
): SleeveDecision {
  const { action, reason } = actionFor(result.direction);
  const stop = stopFor(action, read);
  return {
    sleeve_id: DEBATE_SLEEVE_ID,
    instrument: symbol,
    venue,
    direction: result.direction,
    confidence: result.confidence,
    action: read.atr === undefined && action === 'enter_long' ? 'skip' : action,
    reason: read.atr === undefined && action === 'enter_long' ? 'atr_unavailable' : reason,
    price: read.price,
    atr: read.atr,
    stop_price: stop,
    inputs_hash: hash,
    debate_id: result.debate_id,
    payload: {
      synthesis: result.synthesis,
      rounds: result.rounds_completed,
      converged: result.converged,
      technical: read.view.key_points,
    },
  };
}

function skipped(
  symbol: string,
  venue: Venue,
  read: TechnicalRead | undefined,
  hash: string,
  reason: string,
): SleeveDecision {
  return {
    sleeve_id: DEBATE_SLEEVE_ID,
    instrument: symbol,
    venue,
    direction: 'neutral',
    confidence: 0,
    action: 'skip',
    reason,
    price: read?.price ?? 0,
    atr: read?.atr,
    stop_price: undefined,
    inputs_hash: hash,
    debate_id: undefined,
    payload: {},
  };
}

export function createDebateSleeve(deps: DebateSleeveDeps): Sleeve {
  const decideOne = async (symbol: string, context: SleeveContext): Promise<SleeveDecision> => {
    const venue = deps.venueFor(symbol);
    const series = deps.bars.load(symbol);
    const history = series === undefined ? [] : barsBefore(series, context.tradingDate);
    const traceId = `v2-${context.tradingDate}-${symbol}`;
    const read = technicalRead(history, traceId, deps.clock.now());
    if (read === undefined) return skipped(symbol, venue, undefined, '', 'no_bars');
    const hash = inputsHash(
      history.slice(-HASHED_HISTORY_DAYS),
      [read.view],
      seatModels(context.tradingDate),
    );
    const cap = deps.panel.spendCap.check();
    if (!cap.admitted) return skipped(symbol, venue, read, hash, `llm_spend_cap:${cap.kind}`);
    const debateId = randomUUID();
    try {
      const result = await runDebate(
        {
          views: [read.view],
          instrument: symbol,
          bar: new Date(`${context.tradingDate}T00:00:00.000Z`),
        },
        buildPersonas(deps.panel, context.tradingDate, traceId, debateId, deps.clock),
        { maxRounds: DEBATE_MAX_ROUNDS },
      );
      return decisionFrom(symbol, venue, read, hash, result);
    } catch (error) {
      deps.logger?.log({
        trace_id: traceId,
        stage: 'v2',
        level: 'warn',
        event: 'v2_debate_failed',
        message: `debate for ${symbol} failed: ${describeThrownSafely(error)}`,
        payload: { symbol, debate_id: debateId },
      });
      return skipped(symbol, venue, read, hash, `llm_error:${describeThrownSafely(error)}`);
    }
  };

  return {
    id: DEBATE_SLEEVE_ID,
    async decide(context): Promise<SleeveOutput> {
      const selection: UniverseSelection = selectUniverse(
        deps.constituents(context.tradingDate),
        deps.bars,
        context.tradingDate,
      );
      const decisions: SleeveDecision[] = [];
      for (const symbol of [...selection.liquidity, ...selection.movers]) {
        decisions.push(await decideOne(symbol, context));
      }
      return {
        decisions,
        refusals: selection.refusals.map((refusal) => ({
          scope: 'universe',
          parameter: refusal.parameter,
          ticket: refusal.ticket,
          message: refusal.message,
        })),
      };
    },
  };
}
