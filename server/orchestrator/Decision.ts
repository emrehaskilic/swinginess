import { DecisionAction, GateResult, OrchestratorMetricsInput, SymbolState } from './types';
import { OrderType } from '../connectors/executionTypes';
import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { ExecutionRiskModelV11 } from '../risk/ExecutionRiskModelV11';
import { StrategyInput, StrategySide } from '../types/strategy';

export interface DecisionDependencies {
  expectedPrice: (symbol: string, side: 'BUY' | 'SELL', type: OrderType, limitPrice?: number) => number | null;
  getCurrentMarginBudgetUsdt: (symbol: string) => number;
  getMaxLeverage: () => number;
  hardStopLossPct: number;
  liquidationEmergencyMarginRatio: number;
  allowedSides?: 'BOTH' | 'LONG' | 'SHORT';
  liquidationRiskConfig?: {
    yellowThreshold?: number;
    orangeThreshold?: number;
    redThreshold?: number;
    criticalThreshold?: number;
    timeToLiquidationWarningMs?: number;
    fundingRateImpactFactor?: number;
    volatilityImpactFactor?: number;
  };
  onLiquidationAlert?: (message: string) => void;
  takerFeeBps: number;
  profitLockBufferBps: number;
}

export class DecisionEngine {
  private readonly strategy = new NewStrategyV11();
  private readonly risk = new ExecutionRiskModelV11();

  constructor(private readonly deps: DecisionDependencies) {}

  evaluate(input: {
    symbol: string;
    event_time_ms: number;
    gate: GateResult;
    metrics: OrchestratorMetricsInput;
    state: SymbolState;
  }): DecisionAction[] {
    const { gate, metrics, state, symbol, event_time_ms } = input;
    if (!gate.passed) {
      return [{ type: 'NOOP', symbol, event_time_ms, reason: `gate_fail:${gate.reason || 'unknown'}` }];
    }

    const resolvedPrice = this.resolveMarketPrice(metrics, state.position?.side || null);
    const fallbackSide = state.position?.side === 'SHORT' ? 'BUY' : 'SELL';
    const fallbackExpectedPrice = this.deps.expectedPrice(symbol, fallbackSide, 'MARKET');
    const price = resolvedPrice ?? fallbackExpectedPrice ?? 0;
    const legacyDeltaZ = Number(metrics.legacyMetrics?.deltaZ ?? 0);
    const legacyCvdSlope = Number(metrics.legacyMetrics?.cvdSlope ?? 0);
    const legacyObiDeep = Number(metrics.legacyMetrics?.obiDeep ?? 0);
    // OFI: normalize to [-1,1]; falls back to OBI when not available
    const legacyOfi = metrics.legacyMetrics?.ofiNormalized != null
      ? Number(metrics.legacyMetrics.ofiNormalized)
      : legacyObiDeep;
    const printsPerSecond = Math.max(0, Number(metrics.prints_per_second ?? 0));
    const tradeCount = Math.max(5, Math.round(printsPerSecond * 60));
    const syntheticBurstSide = legacyDeltaZ > 0 ? 'buy' : legacyDeltaZ < 0 ? 'sell' : null;
    const syntheticBurstCount = Math.max(0, Math.round(Math.abs(legacyDeltaZ) * 3));
    const position = this.toStrategyPosition(state.position, price);
    const dfsInput: StrategyInput = {
      symbol,
      nowMs: event_time_ms,
      source: 'real',
      orderbook: {
        lastUpdatedMs: metrics.exchange_event_time_ms ?? event_time_ms,
        spreadPct: metrics.spread_pct ?? null,
        bestBid: metrics.best_bid ?? null,
        bestAsk: metrics.best_ask ?? null,
      },
      trades: {
        lastUpdatedMs: metrics.exchange_event_time_ms ?? event_time_ms,
        printsPerSecond,
        tradeCount,
        aggressiveBuyVolume: legacyDeltaZ > 0 ? Math.abs(legacyDeltaZ) * Math.max(1, printsPerSecond) : 0,
        aggressiveSellVolume: legacyDeltaZ < 0 ? Math.abs(legacyDeltaZ) * Math.max(1, printsPerSecond) : 0,
        consecutiveBurst: { side: syntheticBurstSide, count: syntheticBurstCount },
      },
      market: {
        price,
        vwap: price,
        delta1s: legacyDeltaZ,
        delta5s: legacyDeltaZ,
        deltaZ: legacyDeltaZ,
        cvdSlope: legacyCvdSlope,
        obiWeighted: legacyOfi,      // OFI replaces static OBI for weighted (w4)
        obiDeep: legacyObiDeep,      // deep book OBI preserved for w5
        obiDivergence: legacyOfi - legacyObiDeep,
      },
      funding: metrics.funding
        ? { rate: metrics.funding.rate ?? null, timeToFundingMs: metrics.funding.timeToFundingMs ?? null }
        : null,
      openInterest: null,
      absorption: null,
      bootstrap: {
        backfillDone: true,
        barsLoaded1m: 1440,
      },
      execution: {
        tradeReady: true,
        addonReady: true,
        vetoReason: null,
        orderbookTrusted: true,
        integrityLevel: 'OK',
      },
      volatility: metrics.advancedMetrics?.volatilityIndex ?? 0,
      position,
    };

    const decision = this.strategy.evaluate(dfsInput);
    const actions: DecisionAction[] = [];

    for (const act of decision.actions) {
      if (act.type === 'NOOP') continue;
      const side = act.side ? this.toOrderSide(act.side) : null;
      if (!side) continue;

      if (act.type === 'ENTRY' || act.type === 'ADD') {
        if (!this.isSideAllowed(side)) {
          actions.push({ type: 'NOOP', symbol, event_time_ms, reason: 'side_not_allowed' });
          continue;
        }
        const expectedPrice = this.deps.expectedPrice(symbol, side, 'MARKET');
        const priceRef = expectedPrice ?? price;
        const riskSizing = this.risk.compute({
          equity: this.deps.getCurrentMarginBudgetUsdt(symbol),
          price: priceRef,
          vwap: priceRef,
          volatility: metrics.advancedMetrics?.volatilityIndex ?? 0,
          regime: decision.regime,
          liquidationDistance: null,
        });
        const qty = riskSizing.qty * (act.sizeMultiplier ?? 1);
        actions.push({
          type: act.type === 'ENTRY' ? 'ENTRY_PROBE' : 'ADD_POSITION',
          symbol,
          event_time_ms,
          side,
          quantity: qty,
          reduceOnly: false,
          expectedPrice: priceRef,
          reason: act.reason,
          entryDfsP: act.type === 'ENTRY' ? decision.dfsPercentile : null,
        });
        continue;
      }

      if (act.type === 'REDUCE' || act.type === 'EXIT') {
        const positionQty = state.position?.qty ?? 0;
        const reducePct = act.reducePct ?? 1;
        const qty = act.type === 'REDUCE' ? positionQty * reducePct : positionQty;
        actions.push({
          type: 'EXIT_MARKET',
          symbol,
          event_time_ms,
          side,
          quantity: qty,
          reduceOnly: true,
          expectedPrice: price,
          reason: act.reason,
        });
      }
    }

    if (actions.length === 0) {
      const fallbackAction = this.maybeEmitSoftReduceFallback(symbol, event_time_ms, metrics, state, price);
      if (fallbackAction) {
        return [fallbackAction];
      }
    }

    return actions.length > 0 ? actions : [{ type: 'NOOP', symbol, event_time_ms, reason: 'no_action' }];
  }

  private resolveMarketPrice(metrics: OrchestratorMetricsInput, positionSide: 'LONG' | 'SHORT' | null): number | null {
    if (positionSide === 'LONG') {
      const px = metrics.best_bid ?? metrics.best_ask ?? null;
      return typeof px === 'number' && Number.isFinite(px) ? px : null;
    }
    if (positionSide === 'SHORT') {
      const px = metrics.best_ask ?? metrics.best_bid ?? null;
      return typeof px === 'number' && Number.isFinite(px) ? px : null;
    }
    const bid = metrics.best_bid;
    const ask = metrics.best_ask;
    if (typeof bid === 'number' && Number.isFinite(bid) && typeof ask === 'number' && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
    return null;
  }

  private toStrategyPosition(
    position: SymbolState['position'],
    price: number,
  ): StrategyInput['position'] {
    if (!position) return null;
    const livePnlPct = this.estimateLivePnlPct(position.side, position.entryPrice, price);
    const unrealizedPnlPct = livePnlPct ?? this.normalizeOrchestratorPnl(position.unrealizedPnlPct);
    const peakPnlPct = Math.max(
      unrealizedPnlPct,
      this.normalizeOrchestratorPnl(position.peakPnlPct),
    );
    return {
      side: position.side === 'LONG' ? 'LONG' : 'SHORT',
      qty: position.qty,
      entryPrice: position.entryPrice,
      unrealizedPnlPct,
      addsUsed: position.addsUsed,
      peakPnlPct,
      entryDfsP: position.entryDfsP ?? null,
    };
  }

  private estimateLivePnlPct(side: 'LONG' | 'SHORT', entryPrice: number, price: number): number | null {
    if (!(entryPrice > 0) || !(price > 0)) return null;
    if (side === 'LONG') {
      return (price - entryPrice) / entryPrice;
    }
    return (entryPrice - price) / entryPrice;
  }

  private normalizeOrchestratorPnl(value: number | null | undefined): number {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) return 0;
    return numeric / 100;
  }

  private maybeEmitSoftReduceFallback(
    symbol: string,
    event_time_ms: number,
    metrics: OrchestratorMetricsInput,
    state: SymbolState,
    price: number,
  ): DecisionAction | null {
    if (!state.position || !(state.position.qty > 0)) return null;
    const rawUpnl = Number(state.position.unrealizedPnlPct ?? 0);
    const rawPeakUpnl = Number(state.position.peakPnlPct ?? 0);
    const deltaZ = Number(metrics.legacyMetrics?.deltaZ ?? 0);
    const lossPressureReduce = state.execQuality.freezeActive
      && state.execQuality.quality === 'UNKNOWN'
      && (state.marginRatio ?? 1) >= this.deps.liquidationEmergencyMarginRatio
      && rawUpnl < 0
      && Math.abs(deltaZ) >= 0.8;
    const severeDrawdownReduce = rawUpnl <= -1;
    const bufferPct = Math.max(0, Number(this.deps.profitLockBufferBps || 0)) / 10_000;
    const profitLockReduce = rawPeakUpnl > 0 && this.isNearEntryStop(state.position.side, state.position.entryPrice, price, bufferPct);

    if (!lossPressureReduce && !severeDrawdownReduce && !profitLockReduce) {
      return null;
    }

    return {
      type: 'EXIT_MARKET',
      symbol,
      event_time_ms,
      side: this.toOrderSide(state.position.side === 'LONG' ? 'LONG' : 'SHORT'),
      quantity: state.position.qty * 0.5,
      reduceOnly: true,
      expectedPrice: price,
      reason: 'REDUCE_SOFT',
    };
  }

  private isNearEntryStop(side: 'LONG' | 'SHORT', entryPrice: number, price: number, bufferPct: number): boolean {
    if (!(entryPrice > 0) || !(price > 0)) return false;
    if (side === 'LONG') {
      return price <= entryPrice * (1 + bufferPct);
    }
    return price >= entryPrice * (1 - bufferPct);
  }

  private toOrderSide(side: StrategySide): 'BUY' | 'SELL' {
    return side === 'LONG' ? 'BUY' : 'SELL';
  }

  private isSideAllowed(side: 'BUY' | 'SELL'): boolean {
    const allowed = (this.deps.allowedSides || 'BOTH').toUpperCase();
    if (allowed === 'BOTH') return true;
    if (allowed === 'LONG') return side === 'BUY';
    if (allowed === 'SHORT') return side === 'SELL';
    return true;
  }

  /** Delegate post-trade feedback to adaptive DFS weight updater */
  updateDfsWeightsFromTrade(side: 'LONG' | 'SHORT', pnlFraction: number): void {
    this.strategy.updateDfsWeightsFromTrade(side, pnlFraction);
  }

  computeCooldownMs(deltaZ: number, printsPerSecond: number, minMs: number, maxMs: number): number {
    const lo = Math.max(0, Math.min(minMs, maxMs));
    const hi = Math.max(0, Math.max(minMs, maxMs));
    if (hi <= lo) return lo;

    const absDelta = Math.max(0, Math.abs(Number(deltaZ) || 0));
    const activity = Math.max(0, Math.min(1, (Number(printsPerSecond) || 0) / 10));
    const volatilityFactor = Math.min(1, absDelta / 5);
    const baseCooldown = hi - ((hi - lo) * (1 - volatilityFactor));
    const activityFactor = activity * 0.3;
    const finalCooldown = baseCooldown * (1 - activityFactor);
    return Math.max(lo, Math.min(hi, Math.round(finalCooldown)));
  }
}
