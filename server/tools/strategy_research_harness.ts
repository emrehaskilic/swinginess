/**
 * Strategy Research Test Harness
 * 
 * Comprehensive replay-based testing framework for trading strategy research.
 * Supports tick-by-tick replay, signal recording, and performance analysis.
 * 
 * Features:
 * - Historical market data replay
 * - Decision recording and playback
 * - Performance metrics calculation
 * - Scenario-based testing
 * - Risk engine integration
 */

import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { DirectionalFlowWeights } from '../strategy/DirectionalFlowScore';
import { deriveBias15m, deriveVeto1h } from '../strategy/HtfBias';
import { InstitutionalRiskEngine } from '../risk/InstitutionalRiskEngine';
import { SessionProfileTracker } from '../metrics/SessionProfileTracker';
import type { AdvancedMicrostructureBundle } from '../metrics/AdvancedMicrostructureMetrics';
import { assembleDecisionContext } from '../runtime/DecisionContextAssembler';
import { deriveDryRunRuntimeContext } from '../runtime/DryRunRuntimeContext';
import {
  StrategyConfig as RuntimeStrategyConfig,
  StrategyDecision,
  StrategyInput,
  defaultStrategyConfig as runtimeDefaultStrategyConfig,
} from '../types/strategy';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Historical market data tick
 */
export interface MarketTick {
  timestampMs: number;
  symbol: string;
  price: number;
  vwap: number;
  deltaZ: number;
  cvdSlope: number;
  obiDeep: number;
  obiWeighted: number;
  obiDivergence: number;
  delta1s: number;
  delta5s: number;
  spreadPct: number;
  volatility: number;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  printsPerSecond: number;
  tradeCount: number;
  consecutiveBurst: {
    count: number;
    side: 'buy' | 'sell' | null;
  };
  absorption?: {
    value: number;
    side: 'buy' | 'sell';
  } | null;
  openInterest?: {
    oiChangePct: number;
    source: string;
  } | null;
}

/**
 * Order book snapshot at a point in time
 */
export interface OrderBookSnapshot {
  timestampMs: number;
  symbol: string;
  bid: number;
  ask: number;
  spreadPct: number;
  bidDepth: number;
  askDepth: number;
  lastUpdatedMs: number;
}

/**
 * Trade execution record
 */
export interface TradeExecution {
  timestampMs: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  action: 'ENTRY' | 'EXIT' | 'ADD' | 'REDUCE';
  price: number;
  size: number;
  pnl?: number;
  pnlPct?: number;
  fees: number;
  slippage: number;
  latencyMs: number;
  reason: string;
}

/**
 * Simulated position state
 */
export interface SimulatedPosition {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTimestamp: number;
  size: number;
  addsUsed: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  peakPnlPct: number;
  totalFees: number;
}

/**
 * Signal event for recording
 */
export interface SignalEvent {
  timestampMs: number;
  type: 'ENTRY' | 'EXIT' | 'ADD' | 'REDUCE' | 'NOOP' | 'RISK_VETO';
  side?: 'LONG' | 'SHORT';
  price: number;
  context: {
    dfs: number;
    dfsPercentile: number;
    regime: string;
    volLevel: number;
    deltaZ: number;
    cvdSlope: number;
    obiDeep: number;
    [key: string]: unknown;
  };
  reason: string;
  executed: boolean;
  vetoReason?: string;
}

/**
 * Missed opportunity record
 */
export interface MissedOpportunity {
  timestampMs: number;
  type: 'ENTRY' | 'EXIT';
  side: 'LONG' | 'SHORT';
  price: number;
  missedPnl: number;
  reason: string;
  context: Record<string, unknown>;
}

/**
 * Complete backtest result
 */
export interface BacktestResult {
  // Configuration
  config: StrategyConfig;
  symbol: string;
  startTime: number;
  endTime: number;
  tickCount: number;

  // Performance metrics
  metrics: PerformanceMetrics;

  // Trade history
  trades: TradeExecution[];

  // Signal history
  signals: SignalEvent[];

  // Missed opportunities
  missedOpportunities: MissedOpportunity[];

  // Equity curve
  equityCurve: { timestampMs: number; equity: number; drawdown: number }[];

  // Decision logs
  decisionLogs: StrategyDecisionLog[];
}

/**
 * Strategy decision log entry
 */
export interface StrategyDecisionLog {
  timestampMs: number;
  symbol: string;
  regime: string;
  gatePassed: boolean;
  gateReason?: string;
  dfs: number;
  dfsPercentile: number;
  volLevel: number;
  actions: string[];
  reasons: string[];
  position?: SimulatedPosition;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  // Profit metrics
  totalReturn: number;
  totalReturnPct: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;

  // Trade statistics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgTrade: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;

  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;

  // Time metrics
  avgTradeDurationMs: number;
  avgWinDurationMs: number;
  avgLossDurationMs: number;

  // Latency metrics
  avgEntryLatencyMs: number;
  avgExitLatencyMs: number;
  maxEntryLatencyMs: number;
  maxExitLatencyMs: number;

  // Consecutive metrics
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;

  // Risk-adjusted returns
  returnPerDrawdown: number;
  returnPerTrade: number;
}

/**
 * Strategy configuration for testing
 */
export type StrategyConfig = Partial<RuntimeStrategyConfig> & {
  dfsWeights?: Partial<DirectionalFlowWeights>;
};

/**
 * Default strategy configuration
 */
export const defaultStrategyConfig: StrategyConfig = {
  ...runtimeDefaultStrategyConfig,
};

/**
 * Backtest configuration
 */
export interface BacktestConfig {
  // Data parameters
  symbol: string;
  startTime?: number;
  endTime?: number;

  // Simulation parameters
  initialEquity: number;
  positionSize: number;
  leverage: number;
  makerFee: number;
  takerFee: number;
  slippageModel: 'fixed' | 'volatility' | 'none';
  slippageBps: number;

  // Latency simulation
  entryLatencyMs: number;
  exitLatencyMs: number;
  latencyVarianceMs: number;

  // Risk parameters
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;

  // Recording options
  recordSignals: boolean;
  recordMissedOpportunities: boolean;
  recordDecisionLogs: boolean;
}

/**
 * Default backtest configuration
 */
export const defaultBacktestConfig: BacktestConfig = {
  symbol: 'BTC-USD',
  initialEquity: 100000,
  positionSize: 0.1,
  leverage: 1,
  makerFee: 0.0002,
  takerFee: 0.0005,
  slippageModel: 'fixed',
  slippageBps: 5,
  entryLatencyMs: 50,
  exitLatencyMs: 50,
  latencyVarianceMs: 20,
  maxPositionPct: 0.5,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  recordSignals: true,
  recordMissedOpportunities: true,
  recordDecisionLogs: true,
};

// ============================================================================
// TEST HARNESS CLASS
// ============================================================================

/**
 * Strategy Research Test Harness
 * 
 * Main class for running backtests and replay-based testing.
 */
export class StrategyResearchHarness {
  private strategy: NewStrategyV11 | null = null;
  private riskEngine: InstitutionalRiskEngine;
  private config: BacktestConfig;
  private strategyConfig: StrategyConfig;
  private sessionProfile = new SessionProfileTracker();
  private tickHistory: MarketTick[] = [];

  // State tracking
  private equity: number = 0;
  private position: SimulatedPosition | null = null;
  private trades: TradeExecution[] = [];
  private signals: SignalEvent[] = [];
  private missedOpportunities: MissedOpportunity[] = [];
  private equityCurve: { timestampMs: number; equity: number; drawdown: number }[] = [];
  private decisionLogs: StrategyDecisionLog[] = [];

  // Metrics tracking
  private peakEquity: number = 0;
  private currentDrawdown: number = 0;
  private maxDrawdown: number = 0;
  private consecutiveWins: number = 0;
  private consecutiveLosses: number = 0;
  private maxConsecutiveWins: number = 0;
  private maxConsecutiveLosses: number = 0;

  // Latency tracking
  private entryLatencies: number[] = [];
  private exitLatencies: number[] = [];

  constructor(
    config: Partial<BacktestConfig> = {},
    strategyConfig: Partial<StrategyConfig> = {}
  ) {
    this.config = { ...defaultBacktestConfig, ...config };
    this.strategyConfig = { ...defaultStrategyConfig, ...strategyConfig };
    this.riskEngine = new InstitutionalRiskEngine();
    this.equity = this.config.initialEquity;
    this.peakEquity = this.config.initialEquity;
  }

  /**
   * Initialize the harness with a new strategy instance
   */
  initialize(): void {
    this.strategy = new NewStrategyV11(this.strategyConfig);
    this.riskEngine.initialize(this.config.initialEquity);
    this.resetState();
  }

  /**
   * Reset all state tracking
   */
  private resetState(): void {
    this.equity = this.config.initialEquity;
    this.peakEquity = this.config.initialEquity;
    this.currentDrawdown = 0;
    this.maxDrawdown = 0;
    this.position = null;
    this.trades = [];
    this.signals = [];
    this.missedOpportunities = [];
    this.equityCurve = [];
    this.decisionLogs = [];
    this.consecutiveWins = 0;
    this.consecutiveLosses = 0;
    this.maxConsecutiveWins = 0;
    this.maxConsecutiveLosses = 0;
    this.entryLatencies = [];
    this.exitLatencies = [];
    this.sessionProfile = new SessionProfileTracker();
    this.tickHistory = [];
  }

  /**
   * Run a complete backtest on historical data
   */
  async runBacktest(ticks: MarketTick[]): Promise<BacktestResult> {
    if (!this.strategy) {
      this.initialize();
    }

    const startTime = Date.now();
    console.log(`[Harness] Starting backtest with ${ticks.length} ticks`);

    // Sort ticks by timestamp
    const sortedTicks = [...ticks].sort((a, b) => a.timestampMs - b.timestampMs);

    // Process each tick
    for (let i = 0; i < sortedTicks.length; i++) {
      const tick = sortedTicks[i];
      await this.processTick(tick);

      // Progress logging
      if (i % 10000 === 0 && i > 0) {
        const progress = ((i / sortedTicks.length) * 100).toFixed(1);
        console.log(`[Harness] Progress: ${progress}% (${i}/${sortedTicks.length})`);
      }
    }

    // Close any open position at the end
    if (this.position) {
      const lastTick = sortedTicks[sortedTicks.length - 1];
      this.closePosition(lastTick, 'BACKTEST_END');
    }

    const duration = Date.now() - startTime;
    console.log(`[Harness] Backtest completed in ${duration}ms`);

    return this.buildResult(sortedTicks);
  }

  /**
   * Process a single market tick
   */
  private async processTick(tick: MarketTick): Promise<void> {
    if (!this.strategy) return;
    this.tickHistory.push(tick);
    const syntheticTradeQty = Math.max(
      0.001,
      Number((tick.aggressiveBuyVolume + tick.aggressiveSellVolume) / Math.max(tick.price, 1)),
    );
    this.sessionProfile.update(tick.timestampMs, tick.price, syntheticTradeQty);

    // Build strategy input
    const input = this.buildStrategyInput(tick);

    // Evaluate strategy
    const decision = this.strategy.evaluate(input as any);

    // Record decision log
    if (this.config.recordDecisionLogs) {
      this.recordDecisionLog(tick, decision as any, this.position);
    }

    // Process actions
    for (const action of (decision as any).actions || []) {
      await this.processAction(action, tick, decision as any);
    }

    // Update position PnL
    if (this.position) {
      this.updatePositionPnl(tick);
    }

    // Update equity curve
    this.updateEquityCurve(tick.timestampMs);

    // Update risk engine
    this.riskEngine.updateEquity(this.equity, tick.timestampMs);
  }

  /**
   * Build strategy input from market tick
   */
  private buildStrategyInput(tick: MarketTick): StrategyInput {
    const spreadRatio = Math.max(0, Number(tick.spreadPct || 0)) / 100;
    const halfSpreadRatio = spreadRatio / 2;
    const bestBid = tick.price * (1 - halfSpreadRatio);
    const bestAsk = tick.price * (1 + halfSpreadRatio);
    const htf15m = this.buildSyntheticHtfFrame(tick.timestampMs, 15 * 60_000);
    const htf1h = this.buildSyntheticHtfFrame(tick.timestampMs, 60 * 60_000);
    const bias15m = deriveBias15m(htf15m, tick.price);
    const veto1h = deriveVeto1h(htf1h, tick.price);
    const volatilityAbs = this.deriveAtrLikeVolatility(tick);
    const runtimeContext = deriveDryRunRuntimeContext({
      bias15m,
      trendinessScore: this.deriveTrendinessScore(tick),
      deltaZ: tick.deltaZ,
      cvdSlope: tick.cvdSlope,
      obiWeighted: tick.obiWeighted,
      trendPrice: tick.price,
      sessionVwap: tick.vwap,
      bookMidPrice: (bestBid + bestAsk) / 2,
      referenceTradePrice: tick.price,
    });
    const profile = this.sessionProfile.snapshot(tick.timestampMs, tick.price);
    const decisionContext = assembleDecisionContext({
      nowMs: tick.timestampMs,
      price: tick.price,
      vwap: tick.vwap,
      spreadPct: tick.spreadPct,
      orderbookTrusted: true,
      integrityLevel: 'OK',
      bias15m,
      trendState: runtimeContext.trendState,
      trendConfidence: runtimeContext.trendConfidence,
      profile,
      advancedBundle: this.buildSyntheticAdvancedBundle(tick, volatilityAbs),
      structure: null,
    });

    return {
      nowMs: tick.timestampMs,
      symbol: tick.symbol,
      source: 'real',
      market: {
        price: tick.price,
        vwap: tick.vwap,
        deltaZ: tick.deltaZ,
        cvdSlope: tick.cvdSlope,
        obiDeep: tick.obiDeep,
        obiWeighted: tick.obiWeighted,
        obiDivergence: tick.obiDivergence,
        delta1s: tick.delta1s,
        delta5s: tick.delta5s,
      },
      orderbook: {
        spreadPct: tick.spreadPct,
        lastUpdatedMs: tick.timestampMs,
        bestBid,
        bestAsk,
      },
      trades: {
        aggressiveBuyVolume: tick.aggressiveBuyVolume,
        aggressiveSellVolume: tick.aggressiveSellVolume,
        printsPerSecond: Math.max(tick.printsPerSecond, 1),
        tradeCount: Math.max(tick.tradeCount, 5),
        consecutiveBurst: tick.consecutiveBurst,
        lastUpdatedMs: tick.timestampMs,
      },
      volatility: volatilityAbs,
      absorption: tick.absorption || null,
      openInterest: tick.openInterest ? {
        oiChangePct: tick.openInterest.oiChangePct,
        lastUpdatedMs: tick.timestampMs,
        source: 'real',
      } : null,
      bootstrap: {
        backfillDone: true,
        barsLoaded1m: Math.max(1, this.tickHistory.length),
      },
      htf: {
        m15: htf15m,
        h1: htf1h,
      },
      structure: null,
      decisionContext,
      execution: {
        startupMode: 'WAIT_MICRO_WARMUP',
        seedReady: true,
        tradeReady: true,
        addonReady: true,
        vetoReason: null,
        orderbookTrusted: true,
        integrityLevel: 'OK',
        trendState: runtimeContext.trendState,
        trendConfidence: runtimeContext.trendConfidence,
        bias15m,
        veto1h,
      },
      position: this.position ? {
        side: this.position.side,
        qty: this.position.size,
        entryPrice: this.position.entryPrice,
        unrealizedPnlPct: this.position.unrealizedPnlPct,
        addsUsed: this.position.addsUsed,
        sizePct: Math.min(1, this.position.entryPrice * this.position.size / Math.max(this.equity, 1)),
        timeInPositionMs: Math.max(0, tick.timestampMs - this.position.entryTimestamp),
        peakPnlPct: this.position.peakPnlPct,
      } : null,
    };
  }

  private buildSyntheticHtfFrame(
    nowMs: number,
    windowMs: number
  ): {
    close: number | null;
    atr: number | null;
    lastSwingHigh: number | null;
    lastSwingLow: number | null;
    structureBreakUp: boolean;
    structureBreakDn: boolean;
  } {
    const samples = this.tickHistory.filter((sample) => (nowMs - sample.timestampMs) <= windowMs);
    if (samples.length === 0) {
      return {
        close: null,
        atr: null,
        lastSwingHigh: null,
        lastSwingLow: null,
        structureBreakUp: false,
        structureBreakDn: false,
      };
    }
    const closes = samples.map((sample) => sample.price);
    const close = closes[closes.length - 1] ?? null;
    const lastSwingHigh = closes.length > 0 ? Math.max(...closes) : null;
    const lastSwingLow = closes.length > 0 ? Math.min(...closes) : null;
    let atr = 0;
    for (let index = 1; index < closes.length; index += 1) {
      atr += Math.abs(closes[index] - closes[index - 1]);
    }
    atr = closes.length > 1 ? atr / (closes.length - 1) : 0;
    const previousWindow = this.tickHistory.filter((sample) => {
      const age = nowMs - sample.timestampMs;
      return age > windowMs && age <= (windowMs * 2);
    });
    const prevHigh = previousWindow.length > 0 ? Math.max(...previousWindow.map((sample) => sample.price)) : null;
    const prevLow = previousWindow.length > 0 ? Math.min(...previousWindow.map((sample) => sample.price)) : null;

    return {
      close,
      atr,
      lastSwingHigh,
      lastSwingLow,
      structureBreakUp: close != null && prevHigh != null ? close > prevHigh : false,
      structureBreakDn: close != null && prevLow != null ? close < prevLow : false,
    };
  }

  private deriveAtrLikeVolatility(tick: MarketTick): number {
    const recent = this.tickHistory.slice(-30);
    if (recent.length < 2) {
      return Math.max(tick.price * 0.0015, tick.price * Math.max(0.001, tick.volatility * 0.002));
    }
    let sum = 0;
    for (let index = 1; index < recent.length; index += 1) {
      sum += Math.abs(recent[index].price - recent[index - 1].price);
    }
    const averageMove = sum / Math.max(1, recent.length - 1);
    return Math.max(averageMove, tick.price * 0.001);
  }

  private deriveTrendinessScore(tick: MarketTick): number {
    const priceVsVwap = tick.vwap > 0 ? Math.abs(tick.price - tick.vwap) / tick.vwap : 0;
    return Math.max(0, Math.min(1, (Math.abs(tick.cvdSlope) * 0.35) + (Math.abs(tick.deltaZ) * 0.15) + (priceVsVwap * 25)));
  }

  private buildSyntheticAdvancedBundle(tick: MarketTick, volatilityAbs: number): AdvancedMicrostructureBundle {
    const price = Math.max(tick.price, 1);
    const spreadAbs = price * (Math.max(0, tick.spreadPct) / 100);
    const signedVolume = tick.aggressiveBuyVolume - tick.aggressiveSellVolume;
    const totalVolume = Math.max(1, tick.aggressiveBuyVolume + tick.aggressiveSellVolume);
    const spoofScore = Math.max(0, Math.abs(tick.obiWeighted - tick.obiDeep) * 1.6 + Math.max(0, tick.consecutiveBurst.count - 2) * 0.08);
    const vpinApprox = Math.max(0, Math.min(1, Math.abs(signedVolume) / totalVolume));
    const burstPersistenceScore = Math.max(0, Math.min(1, tick.consecutiveBurst.count / 8));
    const imbalanceBase = Math.max(0, Math.min(1, (tick.obiDeep + 1) / 2));
    const trendinessScore = this.deriveTrendinessScore(tick);

    return {
      liquidityMetrics: {
        microPrice: tick.price,
        imbalanceCurve: {
          level1: imbalanceBase,
          level5: imbalanceBase,
          level10: imbalanceBase,
          level20: imbalanceBase,
          level50: imbalanceBase,
        },
        bookSlopeBid: tick.obiWeighted,
        bookSlopeAsk: -tick.obiWeighted,
        bookConvexity: Math.abs(tick.obiDivergence) * 0.01,
        liquidityWallScore: Math.max(0, Math.min(1, Math.abs(tick.obiWeighted))),
        voidGapScore: Math.max(0, Math.min(1, Number(tick.spreadPct || 0) / 0.2)),
        expectedSlippageBuy: spreadAbs * 0.6,
        expectedSlippageSell: spreadAbs * 0.6,
        resiliencyMs: Math.max(50, 500 - (tick.printsPerSecond * 20)),
        effectiveSpread: spreadAbs,
        realizedSpreadShortWindow: spreadAbs * 0.5,
      },
      passiveFlowMetrics: {
        bidAddRate: Math.max(0, tick.aggressiveBuyVolume * 0.1),
        askAddRate: Math.max(0, tick.aggressiveSellVolume * 0.1),
        bidCancelRate: Math.max(0, tick.aggressiveSellVolume * 0.05),
        askCancelRate: Math.max(0, tick.aggressiveBuyVolume * 0.05),
        depthDeltaDecomposition: {
          addVolume: totalVolume * 0.2,
          cancelVolume: totalVolume * 0.1,
          tradeRelatedVolume: totalVolume * 0.7,
          netDepthDelta: signedVolume * 0.1,
        },
        queueDeltaBestBid: tick.obiWeighted,
        queueDeltaBestAsk: -tick.obiWeighted,
        spoofScore,
        refreshRate: Math.max(0, Math.min(1, tick.printsPerSecond / 10)),
      },
      derivativesMetrics: {
        markLastDeviationPct: 0,
        indexLastDeviationPct: 0,
        perpBasis: null,
        perpBasisZScore: 0,
        liquidationProxyScore: Math.max(0, Math.min(1, Math.abs(tick.deltaZ) / 4)),
      },
      toxicityMetrics: {
        vpinApprox,
        signedVolumeRatio: signedVolume / totalVolume,
        priceImpactPerSignedNotional: signedVolume !== 0 ? Math.abs(tick.price - tick.vwap) / Math.abs(signedVolume) : 0,
        tradeToBookRatio: Math.max(0, Math.min(2, totalVolume / Math.max(price * 0.01, 1))),
        burstPersistenceScore,
      },
      regimeMetrics: {
        realizedVol1m: volatilityAbs,
        realizedVol5m: volatilityAbs * 1.1,
        realizedVol15m: volatilityAbs * 1.2,
        volOfVol: volatilityAbs * 0.2,
        microATR: volatilityAbs,
        chopScore: Math.max(0, Math.min(1, 1 - trendinessScore)),
        trendinessScore,
      },
      crossMarketMetrics: null,
      enableCrossMarketConfirmation: false,
    };
  }

  /**
   * Process a strategy action
   */
  private async processAction(
    action: any,
    tick: MarketTick,
    decision: StrategyDecision
  ): Promise<void> {
    const actionType = action.type;

    switch (actionType) {
      case 'ENTRY':
        await this.processEntry(action, tick, decision);
        break;
      case 'EXIT':
        await this.processExit(action, tick, decision);
        break;
      case 'ADD':
        await this.processAdd(action, tick, decision);
        break;
      case 'REDUCE':
        await this.processReduce(action, tick, decision);
        break;
      case 'NOOP':
        this.recordSignal(tick, 'NOOP', undefined, tick.price, decision as any, true);
        break;
    }
  }

  /**
   * Process entry action
   */
  private async processEntry(
    action: any,
    tick: MarketTick,
    decision: StrategyDecision
  ): Promise<void> {
    // Check if already in position
    if (this.position) {
      this.recordMissedOpportunity(tick, 'ENTRY', action.side, 'ALREADY_IN_POSITION');
      return;
    }

    // Simulate latency
    const latency = this.simulateLatency('entry');
    this.entryLatencies.push(latency);

    // Apply slippage
    const slippage = this.calculateSlippage(tick, 'ENTRY', action.side);
    const entryPrice = action.side === 'LONG' 
      ? tick.price * (1 + slippage) 
      : tick.price * (1 - slippage);

    // Calculate fees
    const sizeMultiplier = Number(action.sizeMultiplier || 1);
    const notional = this.config.initialEquity * this.config.positionSize * sizeMultiplier * this.config.leverage;
    const fees = notional * this.config.takerFee;

    // Create position
    const size = notional / entryPrice;
    this.position = {
      side: action.side,
      entryPrice,
      entryTimestamp: tick.timestampMs + latency,
      size,
      addsUsed: 0,
      unrealizedPnl: -fees,
      unrealizedPnlPct: -(fees / this.config.initialEquity),
      peakPnlPct: 0,
      totalFees: fees,
    };

    // Record trade
    this.trades.push({
      timestampMs: tick.timestampMs + latency,
      symbol: tick.symbol,
      side: action.side,
      action: 'ENTRY',
      price: entryPrice,
      size,
      fees,
      slippage: slippage * entryPrice,
      latencyMs: latency,
      reason: action.reason || 'ENTRY',
    });

    // Record signal
    this.recordSignal(tick, 'ENTRY', action.side, entryPrice, decision as any, true);

    // Update risk engine
    this.riskEngine.updatePosition(tick.symbol, size, notional, this.config.leverage);
  }

  /**
   * Process exit action
   */
  private async processExit(
    action: any,
    tick: MarketTick,
    decision: StrategyDecision
  ): Promise<void> {
    if (!this.position) {
      this.recordMissedOpportunity(tick, 'EXIT', action.side, 'NO_POSITION');
      return;
    }

    this.closePosition(tick, action.reason || 'EXIT');
  }

  /**
   * Process add action
   */
  private async processAdd(
    action: any,
    tick: MarketTick,
    decision: StrategyDecision
  ): Promise<void> {
    if (!this.position) return;

    const latency = this.simulateLatency('entry');
    this.entryLatencies.push(latency);
    const slippage = this.calculateSlippage(tick, 'ENTRY', action.side);
    const addPrice = action.side === 'LONG'
      ? tick.price * (1 + slippage)
      : tick.price * (1 - slippage);

    const sizeMultiplier = action.sizeMultiplier || 0.4;
    const addNotional = this.config.initialEquity * this.config.positionSize * sizeMultiplier * this.config.leverage;
    const addSize = addNotional / addPrice;
    const fees = addNotional * this.config.takerFee;

    // Update position
    const totalSize = this.position.size + addSize;
    const totalCost = (this.position.size * this.position.entryPrice) + (addSize * addPrice);
    this.position.entryPrice = totalCost / totalSize;
    this.position.size = totalSize;
    this.position.addsUsed++;
    this.position.totalFees += fees;

    // Record trade
    this.trades.push({
      timestampMs: tick.timestampMs + latency,
      symbol: tick.symbol,
      side: action.side,
      action: 'ADD',
      price: addPrice,
      size: addSize,
      fees,
      slippage: slippage * addPrice,
      latencyMs: latency,
      reason: action.reason || 'ADD',
    });

    // Record signal
    this.recordSignal(tick, 'ADD', action.side, addPrice, decision as any, true);
  }

  /**
   * Process reduce action
   */
  private async processReduce(
    action: any,
    tick: MarketTick,
    decision: StrategyDecision
  ): Promise<void> {
    if (!this.position) return;

    const reducePct = action.reducePct || 0.5;
    const reduceSize = this.position.size * reducePct;
    
    const latency = this.simulateLatency('exit');
    this.exitLatencies.push(latency);
    const slippage = this.calculateSlippage(tick, 'EXIT', this.position.side);
    const reducePrice = this.position.side === 'LONG'
      ? tick.price * (1 - slippage)
      : tick.price * (1 + slippage);

    const notional = reduceSize * reducePrice;
    const fees = notional * this.config.takerFee;

    // Calculate PnL
    const entryValue = reduceSize * this.position.entryPrice;
    const exitValue = reduceSize * reducePrice;
    const pnl = this.position.side === 'LONG'
      ? exitValue - entryValue - fees
      : entryValue - exitValue - fees;

    // Update position
    this.position.size -= reduceSize;
    this.position.totalFees += fees;

    // Record trade
    this.trades.push({
      timestampMs: tick.timestampMs + latency,
      symbol: tick.symbol,
      side: this.position.side,
      action: 'REDUCE',
      price: reducePrice,
      size: reduceSize,
      pnl,
      pnlPct: pnl / this.config.initialEquity,
      fees,
      slippage: slippage * reducePrice,
      latencyMs: latency,
      reason: action.reason || 'REDUCE',
    });

    // Record signal
    this.recordSignal(tick, 'REDUCE', this.position.side, reducePrice, decision as any, true);

    // Update equity
    this.equity += pnl;

    // Close position if fully reduced
    if (this.position.size <= 0.0001) {
      this.position = null;
    } else {
      this.updatePositionPnl(tick);
    }
  }

  /**
   * Close position
   */
  private closePosition(tick: MarketTick, reason: string): void {
    if (!this.position) return;

    const latency = this.simulateLatency('exit');
    this.exitLatencies.push(latency);
    const slippage = this.calculateSlippage(tick, 'EXIT', this.position.side);
    const exitPrice = this.position.side === 'LONG'
      ? tick.price * (1 - slippage)
      : tick.price * (1 + slippage);

    const notional = this.position.size * exitPrice;
    const fees = notional * this.config.takerFee;

    // Calculate PnL
    const entryValue = this.position.size * this.position.entryPrice;
    const exitValue = this.position.size * exitPrice;
    const pnl = this.position.side === 'LONG'
      ? exitValue - entryValue - fees - this.position.totalFees
      : entryValue - exitValue - fees - this.position.totalFees;

    // Record trade
    this.trades.push({
      timestampMs: tick.timestampMs + latency,
      symbol: tick.symbol,
      side: this.position.side,
      action: 'EXIT',
      price: exitPrice,
      size: this.position.size,
      pnl,
      pnlPct: pnl / this.config.initialEquity,
      fees: fees + this.position.totalFees,
      slippage: slippage * exitPrice,
      latencyMs: latency,
      reason,
    });

    // Update consecutive metrics
    if (pnl > 0) {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
      this.maxConsecutiveWins = Math.max(this.maxConsecutiveWins, this.consecutiveWins);
    } else {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
      this.maxConsecutiveLosses = Math.max(this.maxConsecutiveLosses, this.consecutiveLosses);
    }

    // Update equity
    this.equity += pnl;

    // Record trade result in risk engine
    this.riskEngine.recordTradeResult(tick.symbol, pnl, this.position.size, tick.timestampMs);

    // Clear position
    this.position = null;
  }

  /**
   * Update position unrealized PnL
   */
  private updatePositionPnl(tick: MarketTick): void {
    if (!this.position) return;

    const currentPrice = tick.price;
    const entryValue = this.position.size * this.position.entryPrice;
    const currentValue = this.position.size * currentPrice;

    const unrealizedPnl = this.position.side === 'LONG'
      ? currentValue - entryValue - this.position.totalFees
      : entryValue - currentValue - this.position.totalFees;

    this.position.unrealizedPnl = unrealizedPnl;
    this.position.unrealizedPnlPct = unrealizedPnl / this.config.initialEquity;
    this.position.peakPnlPct = Math.max(this.position.peakPnlPct, this.position.unrealizedPnlPct);
  }

  /**
   * Update equity curve
   */
  private updateEquityCurve(timestampMs: number): void {
    const unrealizedPnl = this.position?.unrealizedPnl || 0;
    const totalEquity = this.equity + unrealizedPnl;

    // Update peak and drawdown
    if (totalEquity > this.peakEquity) {
      this.peakEquity = totalEquity;
    }
    this.currentDrawdown = this.peakEquity - totalEquity;
    this.maxDrawdown = Math.max(this.maxDrawdown, this.currentDrawdown);

    this.equityCurve.push({
      timestampMs,
      equity: totalEquity,
      drawdown: this.currentDrawdown,
    });
  }

  /**
   * Simulate execution latency
   */
  private simulateLatency(type: 'entry' | 'exit'): number {
    const baseLatency = type === 'entry' ? this.config.entryLatencyMs : this.config.exitLatencyMs;
    const variance = (Math.random() - 0.5) * 2 * this.config.latencyVarianceMs;
    return Math.max(0, baseLatency + variance);
  }

  /**
   * Calculate slippage
   */
  private calculateSlippage(tick: MarketTick, action: 'ENTRY' | 'EXIT', side?: string): number {
    if (this.config.slippageModel === 'none') return 0;

    const baseSlippage = this.config.slippageBps / 10000;

    if (this.config.slippageModel === 'volatility') {
      const volAdjustment = tick.volatility * 0.1;
      return baseSlippage * (1 + volAdjustment);
    }

    return baseSlippage;
  }

  /**
   * Record signal event
   */
  private recordSignal(
    tick: MarketTick,
    type: SignalEvent['type'],
    side: 'LONG' | 'SHORT' | undefined,
    price: number,
    decision: any,
    executed: boolean,
    vetoReason?: string
  ): void {
    if (!this.config.recordSignals) return;

    this.signals.push({
      timestampMs: tick.timestampMs,
      type,
      side,
      price,
      context: {
        dfs: decision.dfs || 0,
        dfsPercentile: decision.dfsPercentile || 0,
        regime: decision.regime || 'UNKNOWN',
        volLevel: decision.volLevel || 0,
        deltaZ: tick.deltaZ,
        cvdSlope: tick.cvdSlope,
        obiDeep: tick.obiDeep,
      },
      reason: decision.reasons?.join(',') || '',
      executed,
      vetoReason,
    });
  }

  /**
   * Record missed opportunity
   */
  private recordMissedOpportunity(
    tick: MarketTick,
    type: 'ENTRY' | 'EXIT',
    side: string,
    reason: string
  ): void {
    if (!this.config.recordMissedOpportunities) return;

    this.missedOpportunities.push({
      timestampMs: tick.timestampMs,
      type,
      side: side as 'LONG' | 'SHORT',
      price: tick.price,
      missedPnl: 0, // Would need future price data to calculate
      reason,
      context: {
        deltaZ: tick.deltaZ,
        cvdSlope: tick.cvdSlope,
        volatility: tick.volatility,
      },
    });
  }

  /**
   * Record decision log
   */
  private recordDecisionLog(
    tick: MarketTick,
    decision: any,
    position: SimulatedPosition | null
  ): void {
    this.decisionLogs.push({
      timestampMs: tick.timestampMs,
      symbol: tick.symbol,
      regime: decision.regime || 'UNKNOWN',
      gatePassed: decision.gatePassed || false,
      gateReason: decision.gate?.reason,
      dfs: decision.dfs || 0,
      dfsPercentile: decision.dfsPercentile || 0,
      volLevel: decision.volLevel || 0,
      actions: (decision.actions || []).map((a: any) => a.type),
      reasons: decision.reasons || [],
      position: position ? { ...position } : undefined,
    });
  }

  /**
   * Build backtest result
   */
  private buildResult(ticks: MarketTick[]): BacktestResult {
    const completedTrades = this.trades.filter(t => t.action === 'EXIT');
    const winningTrades = completedTrades.filter(t => (t.pnl || 0) > 0);
    const losingTrades = completedTrades.filter(t => (t.pnl || 0) <= 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0));
    const totalFees = this.trades.reduce((sum, t) => sum + t.fees, 0);

    const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;

    // Calculate durations
    const tradeDurations: number[] = [];
    let entryTime: number | null = null;
    for (const trade of this.trades) {
      if (trade.action === 'ENTRY') {
        entryTime = trade.timestampMs;
      } else if (trade.action === 'EXIT' && entryTime) {
        tradeDurations.push(trade.timestampMs - entryTime);
        entryTime = null;
      }
    }

    const avgTradeDuration = tradeDurations.length > 0
      ? tradeDurations.reduce((a, b) => a + b, 0) / tradeDurations.length
      : 0;

    // Calculate Sharpe ratio (simplified)
    const returns = this.equityCurve.map((e, i) => {
      if (i === 0) return 0;
      return (e.equity - this.equityCurve[i - 1].equity) / this.equityCurve[i - 1].equity;
    }).slice(1);

    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const returnStd = returns.length > 0
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 0;

    const sharpeRatio = returnStd > 0 ? (avgReturn / returnStd) * Math.sqrt(365 * 24 * 12) : 0;

    // Sortino ratio (downside deviation only)
    const downsideReturns = returns.filter(r => r < 0);
    const downsideStd = downsideReturns.length > 0
      ? Math.sqrt(downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length)
      : 0;
    const sortinoRatio = downsideStd > 0 ? (avgReturn / downsideStd) * Math.sqrt(365 * 24 * 12) : 0;

    // Calmar ratio
    const totalReturn = (this.equity - this.config.initialEquity) / this.config.initialEquity;
    const maxDrawdownPct = this.maxDrawdown / this.peakEquity;
    const calmarRatio = maxDrawdownPct > 0 ? totalReturn / maxDrawdownPct : 0;

    const metrics: PerformanceMetrics = {
      totalReturn: this.equity - this.config.initialEquity,
      totalReturnPct: totalReturn * 100,
      grossProfit,
      grossLoss,
      netProfit: grossProfit - grossLoss - totalFees,
      totalTrades: completedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0,
      avgTrade: completedTrades.length > 0
        ? completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / completedTrades.length
        : 0,
      avgWin,
      avgLoss: -avgLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancy: completedTrades.length > 0
        ? (winningTrades.length / completedTrades.length) * avgWin - (losingTrades.length / completedTrades.length) * avgLoss
        : 0,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct: maxDrawdownPct * 100,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      avgTradeDurationMs: avgTradeDuration,
      avgWinDurationMs: 0, // Would need detailed tracking
      avgLossDurationMs: 0,
      avgEntryLatencyMs: this.entryLatencies.length > 0
        ? this.entryLatencies.reduce((a, b) => a + b, 0) / this.entryLatencies.length
        : 0,
      avgExitLatencyMs: this.exitLatencies.length > 0
        ? this.exitLatencies.reduce((a, b) => a + b, 0) / this.exitLatencies.length
        : 0,
      maxEntryLatencyMs: this.entryLatencies.length > 0 ? Math.max(...this.entryLatencies) : 0,
      maxExitLatencyMs: this.exitLatencies.length > 0 ? Math.max(...this.exitLatencies) : 0,
      maxConsecutiveWins: this.maxConsecutiveWins,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      returnPerDrawdown: maxDrawdownPct > 0 ? totalReturn / maxDrawdownPct : 0,
      returnPerTrade: completedTrades.length > 0 ? totalReturn / completedTrades.length : 0,
    };

    return {
      config: this.strategyConfig,
      symbol: this.config.symbol,
      startTime: ticks[0]?.timestampMs || 0,
      endTime: ticks[ticks.length - 1]?.timestampMs || 0,
      tickCount: ticks.length,
      metrics,
      trades: this.trades,
      signals: this.signals,
      missedOpportunities: this.missedOpportunities,
      equityCurve: this.equityCurve,
      decisionLogs: this.decisionLogs,
    };
  }

  /**
   * Get current equity
   */
  getEquity(): number {
    return this.equity;
  }

  /**
   * Get current position
   */
  getPosition(): SimulatedPosition | null {
    return this.position;
  }

  /**
   * Get trade history
   */
  getTrades(): TradeExecution[] {
    return this.trades;
  }

  /**
   * Get signal history
   */
  getSignals(): SignalEvent[] {
    return this.signals;
  }

  /**
   * Reset the harness for a new backtest
   */
  reset(): void {
    this.resetState();
    this.riskEngine.reset();
    this.initialize();
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Load market data from JSON file
 */
export function loadMarketData(filePath: string): MarketTick[] {
  const fs = require('fs');
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Save backtest result to JSON file
 */
export function saveBacktestResult(result: BacktestResult, filePath: string): void {
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
}

/**
 * Format metrics for display
 */
export function formatMetrics(metrics: PerformanceMetrics): string {
  return `
=== Performance Metrics ===
Total Return:        $${metrics.totalReturn.toFixed(2)} (${metrics.totalReturnPct.toFixed(2)}%)
Net Profit:          $${metrics.netProfit.toFixed(2)}
Gross Profit:        $${metrics.grossProfit.toFixed(2)}
Gross Loss:          $${metrics.grossLoss.toFixed(2)}

Trade Statistics:
Total Trades:        ${metrics.totalTrades}
Win Rate:            ${metrics.winRate.toFixed(2)}%
Win/Loss:            ${metrics.winningTrades}/${metrics.losingTrades}
Avg Trade:           $${metrics.avgTrade.toFixed(2)}
Avg Win:             $${metrics.avgWin.toFixed(2)}
Avg Loss:            $${metrics.avgLoss.toFixed(2)}
Profit Factor:       ${metrics.profitFactor.toFixed(2)}
Expectancy:          $${metrics.expectancy.toFixed(2)}

Risk Metrics:
Max Drawdown:        $${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPct.toFixed(2)}%)
Sharpe Ratio:        ${metrics.sharpeRatio.toFixed(2)}
Sortino Ratio:       ${metrics.sortinoRatio.toFixed(2)}
Calmar Ratio:        ${metrics.calmarRatio.toFixed(2)}

Latency Metrics:
Avg Entry Latency:   ${metrics.avgEntryLatencyMs.toFixed(1)}ms
Avg Exit Latency:    ${metrics.avgExitLatencyMs.toFixed(1)}ms
Max Entry Latency:   ${metrics.maxEntryLatencyMs.toFixed(1)}ms
Max Exit Latency:    ${metrics.maxExitLatencyMs.toFixed(1)}ms

Consecutive Metrics:
Max Consecutive Wins:   ${metrics.maxConsecutiveWins}
Max Consecutive Losses: ${metrics.maxConsecutiveLosses}
`;
}

// Export all types
export * from './ParameterSweeper';
export * from './MetricsCalculator';
export * from './ScenarioLoader';

function buildSyntheticScenario(
  name: string,
  sideBias: 'LONG' | 'SHORT' | 'HOLD',
  tickCount: number = 240
): MarketTick[] {
  const ticks: MarketTick[] = [];
  const baseTs = Date.now() - tickCount * 1000;
  let price = 50000;

  for (let i = 0; i < tickCount; i++) {
    const direction = sideBias === 'LONG' ? 1 : sideBias === 'SHORT' ? -1 : 0;
    const lowPrints = sideBias === 'HOLD';
    const warmupTicks = Math.floor(tickCount * 0.7);
    const inImpulse = !lowPrints && i >= warmupTicks;
    const drift = direction * 2.2;
    const noise = Math.sin(i / 8) * 0.3;
    price += drift + noise;
    const vwap = price - direction * (inImpulse ? 22 : 4);
    const directionalBurst = inImpulse ? 1 : 0.1;
    const buyVolume = lowPrints ? 30 : direction >= 0 ? (inImpulse ? 340 : 120) : 40;
    const sellVolume = lowPrints ? 30 : direction <= 0 ? (inImpulse ? 340 : 120) : 40;

    ticks.push({
      timestampMs: baseTs + i * 1000,
      symbol: 'BTCUSDT',
      price,
      vwap,
      deltaZ: lowPrints ? 0.1 : direction * 8.5 * directionalBurst,
      cvdSlope: lowPrints ? 0.02 : direction * 2.4 * directionalBurst,
      obiDeep: lowPrints ? 0.01 : direction * 1.4 * directionalBurst,
      obiWeighted: lowPrints ? 0.01 : direction * 1.1 * directionalBurst,
      obiDivergence: lowPrints ? 0.0 : direction * 0.9 * directionalBurst,
      delta1s: lowPrints ? 0.05 : direction * 3.1 * directionalBurst,
      delta5s: lowPrints ? 0.08 : direction * 5.2 * directionalBurst,
      spreadPct: 0.02,
      volatility: lowPrints ? 0.05 : inImpulse ? 0.9 : 0.2,
      aggressiveBuyVolume: buyVolume,
      aggressiveSellVolume: sellVolume,
      printsPerSecond: lowPrints ? 0.05 : inImpulse ? 20 : 2.5,
      tradeCount: lowPrints ? 2 : inImpulse ? 120 : 15,
      consecutiveBurst: {
        count: lowPrints ? 0 : inImpulse ? 14 : 2,
        side: lowPrints ? null : inImpulse ? (direction >= 0 ? 'buy' : 'sell') : null,
      },
      absorption: lowPrints ? null : { value: 1, side: direction >= 0 ? 'buy' : 'sell' },
      openInterest: { oiChangePct: 0.2, source: 'real' },
    });
  }

  if (name.length === 0) {
    throw new Error('scenario_name_required');
  }

  return ticks;
}

async function runCliHarness(): Promise<void> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  };

  const scenarios = [
    { name: 'scenario_entry_long', bias: 'LONG' as const },
    { name: 'scenario_hold_low_prints', bias: 'HOLD' as const },
  ];

  const outputs: Array<{
    scenario: string;
    bias: 'LONG' | 'SHORT' | 'HOLD';
    tickCount: number;
    signalCounts: Record<string, number>;
    tradeActions: Record<string, number>;
    hasEntry: boolean;
    hasRiskVeto: boolean;
    totalTrades: number;
    netProfit: number;
    maxDrawdownPct: number;
  }> = [];

  for (const scenario of scenarios) {
    const harness = new StrategyResearchHarness(
      {
        symbol: 'BTCUSDT',
        initialEquity: 100000,
        positionSize: 0.1,
        leverage: 1,
        recordSignals: true,
        recordDecisionLogs: true,
      },
      {
        mrRequireAbsorption: false,
        softReduceRequireProfit: true,
        hardRevSizeMultiplier: 0.75,
        maxLossPct: -0.02,
      }
    );

    const ticks = buildSyntheticScenario(scenario.name, scenario.bias);
    const result = await harness.runBacktest(ticks);

    const signalCounts: Record<string, number> = {};
    for (const signal of result.signals) {
      signalCounts[signal.type] = (signalCounts[signal.type] || 0) + 1;
    }

    const tradeActions: Record<string, number> = {};
    for (const trade of result.trades) {
      tradeActions[trade.action] = (tradeActions[trade.action] || 0) + 1;
    }

    outputs.push({
      scenario: scenario.name,
      bias: scenario.bias,
      tickCount: ticks.length,
      signalCounts,
      tradeActions,
      hasEntry: (signalCounts.ENTRY || 0) > 0,
      hasRiskVeto: (signalCounts.RISK_VETO || 0) > 0,
      totalTrades: result.metrics.totalTrades,
      netProfit: result.metrics.netProfit,
      maxDrawdownPct: result.metrics.maxDrawdownPct,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    scenarioCount: outputs.length,
    entryScenarios: outputs.filter((s) => s.hasEntry).length,
    holdScenarios: outputs.filter((s) => !s.hasEntry).length,
    riskVetoScenarios: outputs.filter((s) => s.hasRiskVeto).length,
    outputs,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  console.log = originalLog;
}

if (require.main === module) {
  runCliHarness()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      const details = {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      process.stderr.write(`${JSON.stringify(details, null, 2)}\n`);
      process.exit(1);
    });
}
