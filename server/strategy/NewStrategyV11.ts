import { DecisionLog } from '../telemetry/DecisionLog';
import {
  DecisionReason,
  StrategyAction,
  StrategyActionType,
  StrategyConfig,
  StrategyDecision,
  StrategyInput,
  StrategyRegime,
  StrategySide,
  StrategyTrendState,
  defaultStrategyConfig,
} from '../types/strategy';
import type { StructureSnapshot } from '../structure/types';
import { NormalizationStore } from './Normalization';
import { DirectionalFlowScore } from './DirectionalFlowScore';
import { RegimeSelector } from './RegimeSelector';
import { deriveBias15m, deriveVeto1h } from './HtfBias';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const WINNER_ADD_MIN_UPNL_PCT = 0.0025;
const WINNER_ADD_MIN_HOLD_MS = 30_000;
const DEFAULT_FRESH_EXIT_PROTECT_MS = 90_000;
const DEFAULT_FRESH_REVERSAL_PROTECT_MS = 180_000;
const DEFAULT_FRESH_SOFT_REDUCE_PROTECT_MS = 180_000;
const DEFAULT_SOFT_REDUCE_COOLDOWN_MS = 180_000;
const DEFAULT_FRESH_EXIT_OVERRIDE_LOSS_PCT = -0.004;
const DEFAULT_TREND_CARRY_PROTECT_MS = 12 * 60_000;
const DEFAULT_ORDERBOOK_STALE_SOFT_MS = 8_000;
const DEFAULT_ORDERBOOK_STALE_HARD_MS = 15_000;
const DEFAULT_ORDERBOOK_STALE_MIN_PRINTS = 1;
const DEFAULT_HARD_EXIT_DEBOUNCE_MS = 15_000;
const DEFAULT_HARD_REVERSAL_DEBOUNCE_MS = 20_000;
const DEFAULT_TREND_DECISION_BAR_MS = 3 * 60_000;
const DEFAULT_STRUCTURE_ENTRY_BLOCK_REASON: DecisionReason = 'ENTRY_BLOCKED_STRUCTURE';
const INCLUDE_REPLAY_INPUT = String(process.env.DECISION_LOG_INCLUDE_REPLAY_INPUT ?? 'true').toLowerCase() !== 'false';

export class NewStrategyV11 {
  private readonly config: StrategyConfig;
  private readonly norm: NormalizationStore;
  private readonly dfs: DirectionalFlowScore;
  private readonly regimeSelector: RegimeSelector;
  private readonly decisionLog?: DecisionLog;

  private lastDecisionTs = 0;
  private lastEntryTs = 0;
  private lastEntrySide: StrategySide | null = null;
  private lastEntryRegime: StrategyRegime = 'MR';
  private lastExitTs = 0;
  private lastExitSide: StrategySide | null = null;
  private lastAddTs = 0;
  private lastSoftReduceTs = 0;
  private lastSoftReduceSide: StrategySide | null = null;
  private lastHardExitTs = 0;
  private lastHardExitSide: StrategySide | null = null;
  private lastHardReversalTs = 0;
  private lastHardReversalSide: StrategySide | null = null;
  private lastDfsPercentile = 0.5;
  private lastDeltaZ = 0;
  private prevPrice: number | null = null;
  private prevCvdSlope: number | null = null;
  private vwapBelowTicks = 0;
  private vwapAboveTicks = 0;
  private trackedTrendPositionSide: StrategySide | null = null;
  private trackedTrendLastBucket = -1;
  private trackedTrendLastAgeMs = 0;
  private adverseTrendBuckets = 0;
  private neutralTrendBuckets = 0;

  constructor(config?: Partial<StrategyConfig>, decisionLog?: DecisionLog) {
    this.config = { ...defaultStrategyConfig, ...(config || {}) };
    const windowMs = Math.max(60_000, this.config.rollingWindowMin * 60_000);
    this.norm = new NormalizationStore(windowMs, 64);
    this.dfs = new DirectionalFlowScore(this.norm);
    this.regimeSelector = new RegimeSelector(this.norm, this.config.regimeLockTRMRTicks, this.config.regimeLockEVTicks);
    this.decisionLog = decisionLog;
  }

  evaluate(input: StrategyInput): StrategyDecision {
    const nowMs = input.nowMs;
    const reasons: DecisionReason[] = [];
    const gate = this.dataQualityGate(input);

    if (!gate.passed) {
      reasons.push(gate.reason || 'GATE_PAUSED');
    }

    const dfsOut = this.dfs.compute({
      deltaZ: input.market.deltaZ,
      cvdSlope: input.market.cvdSlope,
      obiWeighted: input.market.obiWeighted,
      obiDeep: input.market.obiDeep,
      sweepStrength: input.market.delta1s,
      burstCount: input.trades.consecutiveBurst.count,
      burstSide: input.trades.consecutiveBurst.side,
      aggressiveBuyVolume: input.trades.aggressiveBuyVolume,
      aggressiveSellVolume: input.trades.aggressiveSellVolume,
      oiChangePct: input.openInterest?.oiChangePct ?? 0,
      price: input.market.price,
      prevPrice: this.prevPrice,
      prevCvd: this.prevCvdSlope,
      nowMs,
    });

    this.norm.update('delta1sAbs', Math.abs(input.market.delta1s), nowMs);
    this.norm.update('delta5sAbs', Math.abs(input.market.delta5s), nowMs);
    this.norm.update('prints', input.trades.printsPerSecond, nowMs);
    this.norm.update('flow', input.trades.aggressiveBuyVolume + input.trades.aggressiveSellVolume, nowMs);

    const regimeOut = this.regimeSelector.update({
      nowMs,
      price: input.market.price,
      vwap: input.market.vwap,
      dfsPercentile: dfsOut.dfsPercentile,
      deltaZ: input.market.deltaZ,
      printsPerSecond: input.trades.printsPerSecond,
      burstCount: input.trades.consecutiveBurst.count,
      volatility: input.volatility,
    });

    const activeRegime = this.resolveActiveRegime(input, regimeOut.regime, dfsOut.dfsPercentile);
    const thresholds = this.computeThresholds(regimeOut.volLevel);
    const actions: StrategyAction[] = [];

    this.updateVwapTicks(input.market.price, input.market.vwap);
    this.updateTrendDecisionState(input);

    if (gate.passed) {
      this.lastDecisionTs = nowMs;
    }

    if (!gate.passed) {
      if (!input.position) {
        this.lastSoftReduceTs = 0;
        this.lastSoftReduceSide = null;
      }
      const canManageDuringGateFailure = gate.reason !== 'GATE_STALE_ORDERBOOK';
      if (input.position && canManageDuringGateFailure) {
        const reduceAction = this.maybeSoftReduce(input, dfsOut.dfsPercentile, thresholds);
        if (reduceAction) {
          actions.push(reduceAction);
          reasons.push(reduceAction.reason);
        }
      }
      if (actions.length === 0) {
        actions.push({ type: StrategyActionType.NOOP, reason: 'GATE_PAUSED' });
      }
      return this.buildDecision(input, activeRegime, dfsOut, thresholds, gate, actions, reasons);
    }

    if (!input.position) {
      this.lastSoftReduceTs = 0;
      this.lastSoftReduceSide = null;
      const entryAction = this.evaluateEntry(input, dfsOut.dfsPercentile, dfsOut.dfs, activeRegime, regimeOut.volLevel, thresholds, reasons);
      if (entryAction) {
        actions.push(entryAction);
        reasons.push(entryAction.reason);
        this.lastEntrySide = entryAction.side || null;
        this.lastEntryRegime = activeRegime;
      } else {
        reasons.push('NO_SIGNAL');
        actions.push({ type: StrategyActionType.NOOP, reason: 'NO_SIGNAL' });
      }
    } else {
      const hardRev = this.checkHardReversal(input, dfsOut.dfsPercentile);
      if (hardRev.valid) {
        const hardRevSize = this.config.hardRevSizeMultiplier ?? 0.75;
        if (!this.isHardReversalDebounced(input.position.side, nowMs)) {
          actions.push({ type: StrategyActionType.EXIT, side: input.position.side, reason: 'EXIT_HARD_REVERSAL' });
          actions.push({ type: StrategyActionType.ENTRY, side: this.flipSide(input.position.side), reason: 'HARD_REVERSAL_ENTRY', sizeMultiplier: hardRevSize });
          reasons.push('EXIT_HARD_REVERSAL', 'HARD_REVERSAL_ENTRY');
          this.lastExitTs = nowMs;
          this.lastExitSide = input.position.side;
          this.lastEntryTs = nowMs;
          this.lastEntrySide = this.flipSide(input.position.side);
          this.lastEntryRegime = activeRegime;
          this.lastHardReversalTs = nowMs;
          this.lastHardReversalSide = input.position.side;
        }
      } else {
        const hardExit = this.maybeHardExit(input, dfsOut.dfsPercentile, thresholds);
        if (hardExit) {
          if (!this.isHardExitDebounced(input.position.side, nowMs)) {
            actions.push(hardExit);
            reasons.push(hardExit.reason);
            this.lastExitTs = nowMs;
            this.lastExitSide = input.position.side;
            this.lastHardExitTs = nowMs;
            this.lastHardExitSide = input.position.side;
          }
        } else {
          const reduceAction = this.maybeSoftReduce(input, dfsOut.dfsPercentile, thresholds);
          if (reduceAction) {
            actions.push(reduceAction);
            reasons.push(reduceAction.reason);
          }

          const addAction = this.maybeAdd(input, dfsOut.dfsPercentile, regimeOut.volLevel);
          if (addAction) {
            actions.push(addAction);
            reasons.push(addAction.reason);
          }

          if (actions.length === 0) {
            actions.push({ type: StrategyActionType.NOOP, reason: 'NOOP' });
            reasons.push('NOOP');
          }
        }
      }
      if (actions.length === 0) {
        actions.push({ type: StrategyActionType.NOOP, reason: 'NOOP' });
        reasons.push('NOOP');
      }
    }

    this.lastDfsPercentile = dfsOut.dfsPercentile;
    this.lastDeltaZ = input.market.deltaZ;
    this.prevPrice = input.market.price;
    this.prevCvdSlope = input.market.cvdSlope;

    return this.buildDecision(input, activeRegime, dfsOut, thresholds, gate, actions, reasons);
  }

  private computeThresholds(volLevel: number) {
    let longEntry = this.config.dfsEntryLongBase;
    let shortEntry = this.config.dfsEntryShortBase;
    const longBreak = this.config.dfsBreakLongBase;
    const shortBreak = this.config.dfsBreakShortBase;

    if (volLevel > this.config.volHighP) {
      longEntry = 0.90;
      shortEntry = 0.10;
    } else if (volLevel < this.config.volLowP) {
      longEntry = 0.80;
      shortEntry = 0.20;
    }

    return { longEntry, shortEntry, longBreak, shortBreak };
  }

  private dataQualityGate(input: StrategyInput): { passed: boolean; reason: DecisionReason | null; details: Record<string, unknown> } {
    const details: Record<string, unknown> = {};
    if (!input.bootstrap?.backfillDone || Number(input.bootstrap?.barsLoaded1m || 0) <= 0) {
      return {
        passed: false,
        reason: 'GATE_PAUSED',
        details: {
          bootstrapDone: Boolean(input.bootstrap?.backfillDone),
          barsLoaded1m: Number(input.bootstrap?.barsLoaded1m || 0),
        },
      };
    }
    if (input.source !== 'real' || (input.openInterest?.source && input.openInterest.source !== 'real')) {
      return { passed: false, reason: 'GATE_SOURCE_NOT_REAL', details: { source: input.source } };
    }
    if (input.execution?.tradeReady === false) {
      return {
        passed: false,
        reason: 'GATE_PAUSED',
        details: {
          startupMode: input.execution?.startupMode ?? null,
          seedReady: Boolean(input.execution?.seedReady),
          addonReady: Boolean(input.execution?.addonReady),
          vetoReason: input.execution?.vetoReason ?? null,
        },
      };
    }
    if (input.execution?.orderbookTrusted === false || (input.execution?.integrityLevel && input.execution.integrityLevel !== 'OK')) {
      details.integrityLevel = input.execution?.integrityLevel ?? null;
      details.orderbookTrusted = Boolean(input.execution?.orderbookTrusted);
      return { passed: false, reason: 'GATE_STALE_ORDERBOOK', details };
    }
    const tradeLag = Math.max(0, input.nowMs - input.trades.lastUpdatedMs);
    const bookLag = Math.max(0, input.nowMs - input.orderbook.lastUpdatedMs);
    details.tradeLagMs = tradeLag;
    details.bookLagMs = bookLag;
    details.bestBid = input.orderbook.bestBid ?? null;
    details.bestAsk = input.orderbook.bestAsk ?? null;
    if (tradeLag > 1000) {
      return { passed: false, reason: 'GATE_STALE_TRADES', details };
    }
    const hasTopOfBook = Number(input.orderbook.bestBid || 0) > 0
      && Number(input.orderbook.bestAsk || 0) > 0
      && Number(input.orderbook.bestAsk || 0) > Number(input.orderbook.bestBid || 0);
    if (!hasTopOfBook) {
      return { passed: false, reason: 'GATE_STALE_ORDERBOOK', details };
    }
    if (bookLag > DEFAULT_ORDERBOOK_STALE_HARD_MS) {
      return { passed: false, reason: 'GATE_STALE_ORDERBOOK', details };
    }
    if (bookLag > DEFAULT_ORDERBOOK_STALE_SOFT_MS && input.trades.printsPerSecond < DEFAULT_ORDERBOOK_STALE_MIN_PRINTS) {
      return { passed: false, reason: 'GATE_STALE_ORDERBOOK', details };
    }
    if (input.trades.printsPerSecond < 0.2 || input.trades.tradeCount < 5) {
      details.printsPerSecond = input.trades.printsPerSecond;
      details.tradeCount = input.trades.tradeCount;
      return { passed: false, reason: 'GATE_LOW_PRINTS', details };
    }
    if ((input.orderbook.spreadPct ?? 0) > 0.5) {
      details.spreadPct = input.orderbook.spreadPct;
      return { passed: false, reason: 'GATE_WIDE_SPREAD', details };
    }
    return { passed: true, reason: null, details };
  }

  private evaluateEntry(
    input: StrategyInput,
    dfsP: number,
    dfs: number,
    regime: StrategyRegime,
    volLevel: number,
    thresholds: { longEntry: number; shortEntry: number },
    reasons: DecisionReason[]
  ): StrategyAction | null {
    if (this.config.structureEnabled && !this.hasFreshStructure(input)) {
      reasons.push(DEFAULT_STRUCTURE_ENTRY_BLOCK_REASON);
      return null;
    }

    const desiredSide = this.selectEntrySide(input, dfsP, regime, thresholds);
    if (!desiredSide) return null;

    if (this.isInCooldown(desiredSide, input.nowMs, volLevel)) {
      reasons.push('ENTRY_BLOCKED_COOLDOWN');
      return null;
    }

    if (this.isInMHT(desiredSide, input.nowMs, volLevel)) {
      reasons.push('ENTRY_BLOCKED_MHT');
      return null;
    }

    const filtersOk = this.entryFilters(input, dfsP, dfs, regime, volLevel, thresholds, desiredSide);
    if (!filtersOk) {
      reasons.push('ENTRY_BLOCKED_FILTERS');
      return null;
    }

    this.lastEntryTs = input.nowMs;
    return {
      type: StrategyActionType.ENTRY,
      side: desiredSide,
      reason: regime === 'EV' ? 'ENTRY_EV' : regime === 'MR' ? 'ENTRY_MR' : 'ENTRY_TR',
      expectedPrice: input.market.price,
      sizeMultiplier: this.getEntrySizeMultiplier(input),
    };
  }

  private selectEntrySide(
    input: StrategyInput,
    dfsP: number,
    regime: StrategyRegime,
    thresholds: { longEntry: number; shortEntry: number }
  ): StrategySide | null {
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    if (bias15m === 'UP' && veto1h !== 'DOWN' && this.isStructureEntryAligned(input, 'LONG')) {
      return 'LONG';
    }
    if (bias15m === 'DOWN' && veto1h !== 'UP' && this.isStructureEntryAligned(input, 'SHORT')) {
      return 'SHORT';
    }
    return null;
  }

  private entryFilters(
    input: StrategyInput,
    dfsP: number,
    dfs: number,
    regime: StrategyRegime,
    volLevel: number,
    thresholds: { longEntry: number; shortEntry: number },
    desiredSide: StrategySide
  ): boolean {
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    if (desiredSide === 'LONG' && (bias15m !== 'UP' || veto1h === 'DOWN')) {
      return false;
    }
    if (desiredSide === 'SHORT' && (bias15m !== 'DOWN' || veto1h === 'UP')) {
      return false;
    }
    if (!this.isStructureEntryAligned(input, desiredSide)) {
      return false;
    }
    if (!this.allowTrendCarryEntry(input, desiredSide, dfsP, thresholds)) {
      return false;
    }
    return true;
  }

  private isLiquidTrendContext(input: StrategyInput): boolean {
    const spreadPct = Number(input.orderbook.spreadPct ?? 0);
    const printsPerSecond = Number(input.trades.printsPerSecond || 0);
    const tradeCount = Number(input.trades.tradeCount || 0);
    return spreadPct > 0
      && spreadPct <= 0.0004
      && printsPerSecond >= 4
      && tradeCount >= 12;
  }

  private allowNeutralBiasContinuation(
    input: StrategyInput,
    side: StrategySide,
    dfsP: number,
    regime: StrategyRegime,
    thresholds: { longEntry: number; shortEntry: number }
  ): boolean {
    if (!this.isLiquidTrendContext(input)) return false;
    const price = input.market.price;
    const vwap = input.market.vwap;
    const pullbackDistancePct = vwap > 0 ? Math.abs(price - vwap) / vwap : 0;
    if (pullbackDistancePct > 0.012) return false;
    const mrMode = regime === 'MR';
    if (side === 'LONG') {
      return (
        price >= (vwap * (mrMode ? 0.9975 : 0.9985)) &&
        dfsP >= Math.max(mrMode ? 0.72 : 0.68, thresholds.longEntry - (mrMode ? 0.1 : 0.15)) &&
        input.market.deltaZ > (mrMode ? 1.0 : 0.75) &&
        input.market.delta5s > 0 &&
        input.market.cvdSlope > 0 &&
        input.market.obiWeighted > (mrMode ? -0.08 : -0.02) &&
        input.market.obiDeep > (mrMode ? -0.18 : -0.12)
      );
    }
    return (
      price <= (vwap * (mrMode ? 1.0025 : 1.0015)) &&
      dfsP <= Math.min(mrMode ? 0.28 : 0.32, thresholds.shortEntry + (mrMode ? 0.18 : 0.15)) &&
      input.market.deltaZ < (mrMode ? -1.0 : -0.75) &&
      input.market.delta5s < 0 &&
      input.market.cvdSlope < 0 &&
      input.market.obiWeighted < (mrMode ? 0.08 : 0.02) &&
      input.market.obiDeep < (mrMode ? 0.18 : 0.12)
    );
  }

  private resolveActiveRegime(
    input: StrategyInput,
    regime: StrategyRegime,
    dfsP: number
  ): StrategyRegime {
    if (this.shouldForceTrendCarryRegime(input, dfsP)) {
      return 'TR';
    }
    return regime;
  }

  private shouldForceTrendCarryRegime(input: StrategyInput, dfsP: number): boolean {
    if (input.execution?.tradeReady === false) return false;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    if (bias15m === 'NEUTRAL') return false;
    const pullbackDistancePct = input.market.vwap > 0
      ? Math.abs(input.market.price - input.market.vwap) / input.market.vwap
      : 0;
    if (pullbackDistancePct > 0.02) return false;
    if (bias15m === 'UP' && veto1h !== 'DOWN') {
      return dfsP >= 0.45
        && input.market.deltaZ > -0.5
        && input.market.cvdSlope > -0.15
        && input.market.delta5s > -0.25
        && input.market.obiWeighted > -0.15;
    }
    if (bias15m === 'DOWN' && veto1h !== 'UP') {
      return dfsP <= 0.55
        && input.market.deltaZ < 0.5
        && input.market.cvdSlope < 0.15
        && input.market.delta5s < 0.25
        && input.market.obiWeighted < 0.15;
    }
    return false;
  }

  private allowTrendCarryEntry(
    input: StrategyInput,
    side: StrategySide,
    dfsP: number,
    thresholds: { longEntry: number; shortEntry: number }
  ): boolean {
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const price = input.market.price;
    const vwap = input.market.vwap;
    const earlySeed = this.isEarlySeedPhase(input);
    const pullbackDistancePct = vwap > 0 ? Math.abs(price - vwap) / vwap : 0;
    const trendState = this.getRuntimeTrendState(input);
    if (input.execution?.orderbookTrusted === false) return false;
    if (!this.isAlignedTrendState(side, trendState)) return false;
    if (pullbackDistancePct > 0.012) return false;
    if (!this.hasFeeAwareEdge(input)) return false;
    const burstSide = input.trades.consecutiveBurst.side;
    const burstCount = Number(input.trades.consecutiveBurst.count || 0);

    if (side === 'LONG') {
      if (!(bias15m === 'UP' && veto1h !== 'DOWN')) return false;
      const noStrongCounterBurst = burstSide !== 'sell' || burstCount <= 3;
      return noStrongCounterBurst
        && price >= (vwap * 0.992)
        && dfsP >= Math.max(earlySeed ? 0.42 : 0.48, thresholds.longEntry - 0.38)
        && input.market.deltaZ > -0.35
        && input.market.delta5s > -0.15
        && input.market.cvdSlope > -0.1
        && input.market.obiWeighted > -0.18
        && input.market.obiDeep > -0.25;
    }

    if (!(bias15m === 'DOWN' && veto1h !== 'UP')) return false;
    const noStrongCounterBurst = burstSide !== 'buy' || burstCount <= 3;
    return noStrongCounterBurst
      && price <= (vwap * 1.008)
      && dfsP <= Math.min(earlySeed ? 0.58 : 0.52, thresholds.shortEntry + 0.38)
      && input.market.deltaZ < 0.35
      && input.market.delta5s < 0.15
      && input.market.cvdSlope < 0.1
      && input.market.obiWeighted < 0.18
      && input.market.obiDeep < 0.25;
  }

  private getEntrySizeMultiplier(input: StrategyInput): number {
    return this.isEarlySeedPhase(input)
      ? this.getStartupSeedSizeMultiplier()
      : 1;
  }

  private isEarlySeedPhase(input: StrategyInput): boolean {
    if (input.execution?.tradeReady === false) return false;
    const startupMode = input.execution?.startupMode ?? 'EARLY_SEED_THEN_MICRO';
    if (startupMode !== 'EARLY_SEED_THEN_MICRO') return false;
    if (input.execution?.seedReady === false) return false;
    return input.execution?.addonReady === false;
  }

  private getStartupSeedSizeMultiplier(): number {
    const configured = Number(this.config.startupSeedSizeMultiplier);
    if (Number.isFinite(configured) && configured > 0 && configured <= 1) return configured;
    return 0.4;
  }

  private hasFeeAwareEdge(input: StrategyInput): boolean {
    const price = Number(input.market.price || 0);
    const vwap = Number(input.market.vwap || 0);
    if (!(price > 0)) return false;

    const spreadPct = Math.max(0, Number(input.orderbook.spreadPct ?? 0)) / 100;
    const vwapDistancePct = vwap > 0 ? Math.abs(price - vwap) / vwap : 0;
    const volatilityPct = Math.max(0, Number(input.volatility || 0)) / price;
    const expectedMovePct = Math.max(volatilityPct, vwapDistancePct + 0.0015, 0.0025);
    const estimatedCostPct = spreadPct + 0.0008 + 0.0005;

    return expectedMovePct >= (estimatedCostPct * 1.35);
  }

  private maybeAdd(input: StrategyInput, dfsP: number, volLevel: number): StrategyAction | null {
    if (!input.position) return null;
    if (input.execution && !input.execution.addonReady) return null;
    if (input.position.addsUsed >= this.config.addSizing.length) return null;
    if (this.config.structureEnabled && !this.hasFreshStructure(input)) return null;
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    const timeInPositionMs = Math.max(0, Number(input.position.timeInPositionMs || 0));
    const isWinnerAdd = unrealizedPnlPct > 0;
    if (!isWinnerAdd) return null;
    const side = input.position.side;
    const sideStrength = side === 'LONG' ? dfsP : (1 - dfsP);
    const lastSideStrength = side === 'LONG' ? this.lastDfsPercentile : (1 - this.lastDfsPercentile);
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    if (side === 'LONG' && (bias15m !== 'UP' || veto1h === 'DOWN')) return null;
    if (side === 'SHORT' && (bias15m !== 'DOWN' || veto1h === 'UP')) return null;
    if (this.config.winnerAddRequireStructure && !this.hasStructureContinuation(input, side)) return null;
    if (isWinnerAdd) {
      if (unrealizedPnlPct < WINNER_ADD_MIN_UPNL_PCT) return null;
      if (timeInPositionMs < WINNER_ADD_MIN_HOLD_MS) return null;
      if (sideStrength < 0.75 || sideStrength < lastSideStrength) return null;
    }
    if (side === 'LONG' && input.market.cvdSlope <= 0) return null;
    if (side === 'SHORT' && input.market.cvdSlope >= 0) return null;
    if (Math.abs(input.market.price - input.market.vwap) > Math.abs(input.market.vwap) * 0.0075) return null;

    const maxPositionSizePct = this.config.maxPositionSizePct ?? 0.25;
    const currentPositionPct = input.position.sizePct ?? 0;
    const addIndex = input.position.addsUsed;
    const proposedAddSize = this.config.addSizing[addIndex] ?? 0.4;
    const newPositionPct = currentPositionPct + proposedAddSize;
    if (newPositionPct > maxPositionSizePct) return null;
    const sizeMultiplier = proposedAddSize;
    this.lastAddTs = input.nowMs;

    return {
      type: StrategyActionType.ADD,
      side: input.position.side,
      reason: 'ADD_WINNER',
      sizeMultiplier: clamp(sizeMultiplier, 0.1, 1),
      expectedPrice: input.market.price,
      metadata: {
        volLevel,
        currentPositionPct,
        newPositionPct,
        maxPositionSizePct,
        addMode: isWinnerAdd ? 'WINNER' : 'DEFENSIVE',
        unrealizedPnlPct,
        structureContinuation: this.hasStructureContinuation(input, side),
      },
    };
  }

  private maybeSoftReduce(
    input: StrategyInput,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): StrategyAction | null {
    if (!input.position) return null;
    const side = input.position.side;
    if (this.isFreshPosition(input, this.getFreshSoftReduceProtectMs())) return null;
    if (
      this.lastSoftReduceSide === side
      && this.lastSoftReduceTs > 0
      && (input.nowMs - this.lastSoftReduceTs) < this.getSoftReduceCooldownMs()
    ) {
      return null;
    }
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const positionAgeMs = this.getPositionAgeMs(input) ?? 0;
    const trendAligned = this.isTrendAligned(side, bias15m, veto1h);
    const htfOpposes = this.isHtfOpposing(side, bias15m, veto1h);
    const confirmedTrendExit = this.hasConfirmedTrendExitContext(input, side);
    const softReduceRequireProfit = this.config.softReduceRequireProfit ?? true;
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    const peakPnlPct = this.getPeakPnlPct(input);
    const givebackPct = this.getProfitGivebackPct(input);
    const carryReduceArmed = peakPnlPct >= this.getTrendCarryReduceMinPeakPnlPct();
    const carryReduceTriggered = carryReduceArmed && givebackPct >= this.getTrendCarryReduceGivebackPct();
    const structureInvalidation = this.isStructureInvalidated(input, side);
    const stillHoldingTrendWinner = trendAligned
      && carryReduceArmed
      && !carryReduceTriggered
      && unrealizedPnlPct >= Math.max(0.003, peakPnlPct * 0.45);
    if (softReduceRequireProfit && unrealizedPnlPct <= 0) return null;
    if (structureInvalidation && unrealizedPnlPct > 0) {
      this.lastSoftReduceTs = input.nowMs;
      this.lastSoftReduceSide = side;
      return {
        type: StrategyActionType.REDUCE,
        side,
        reason: 'REDUCE_SOFT',
        reducePct: trendAligned ? 0.35 : 0.5,
        expectedPrice: input.market.price,
        metadata: {
          unrealizedPnlPct,
          peakPnlPct,
          givebackPct,
          structureInvalidation: true,
          mode: 'STRUCTURE_INVALIDATION',
        },
      };
    }
    if (htfOpposes) {
      if (!confirmedTrendExit) return null;
      if (stillHoldingTrendWinner && positionAgeMs < (18 * 3 * 60 * 1000)) {
        return null;
      }
      this.lastSoftReduceTs = input.nowMs;
      this.lastSoftReduceSide = side;
      return {
        type: StrategyActionType.REDUCE,
        side,
        reason: 'REDUCE_SOFT',
        reducePct: carryReduceTriggered ? 0.5 : 0.35,
          expectedPrice: input.market.price,
          metadata: {
            unrealizedPnlPct,
            peakPnlPct,
            givebackPct,
            carryReduceTriggered,
            mode: 'OPPOSITE_TREND',
          },
      };
    }

    if (trendAligned && positionAgeMs < DEFAULT_TREND_CARRY_PROTECT_MS) {
      return null;
    }

    const sideStrength = side === 'LONG' ? dfsP : (1 - dfsP);
    const lastSideStrength = side === 'LONG' ? this.lastDfsPercentile : (1 - this.lastDfsPercentile);
    const weakening = lastSideStrength >= 0.82
      && sideStrength <= 0.62
      && (lastSideStrength - sideStrength) >= 0.18;
    const adverseFlow = this.hasTrendCarryPressure(input, side);
    const structureBreak = this.hasTrendStructureBreak(input, side, dfsP, thresholds);
    const agedWinnerGiveback = positionAgeMs >= (15 * 60 * 1000) && carryReduceTriggered && adverseFlow && structureBreak;
    const timeStop = positionAgeMs >= (18 * 3 * 60 * 1000)
      && (!trendAligned || adverseFlow || (side === 'LONG' ? dfsP < 0.45 : dfsP > 0.55));
    const trailingReduce = confirmedTrendExit
      && weakening
      && adverseFlow
      && structureBreak
      && (!trendAligned || carryReduceTriggered || peakPnlPct <= 0.0035 || unrealizedPnlPct <= 0.0025);
    const timeStopTriggered = timeStop
      && (confirmedTrendExit || htfOpposes)
      && (!stillHoldingTrendWinner || carryReduceTriggered || unrealizedPnlPct <= 0.002);

    if (trailingReduce || timeStopTriggered || agedWinnerGiveback) {
      this.lastSoftReduceTs = input.nowMs;
      this.lastSoftReduceSide = side;
      return {
        type: StrategyActionType.REDUCE,
        side,
        reason: 'REDUCE_SOFT',
        reducePct: timeStopTriggered ? 0.5 : (trendAligned ? 0.25 : 0.4),
        expectedPrice: input.market.price,
        metadata: {
          unrealizedPnlPct,
          peakPnlPct,
          givebackPct,
          carryReduceTriggered,
          timeStop: timeStopTriggered,
          agedWinnerGiveback,
          adverseFlow,
          structureBreak,
          trendAligned,
        },
      };
    }
    return null;
  }

  private maybeHardExit(
    input: StrategyInput,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): StrategyAction | null {
    if (!input.position) return null;
    const side = input.position.side;
    const price = input.market.price;
    const vwap = input.market.vwap;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const positionAgeMs = this.getPositionAgeMs(input) ?? 0;
    const trendAligned = this.isTrendAligned(side, bias15m, veto1h);
    const htfOpposes = this.isHtfOpposing(side, bias15m, veto1h);
    const vwapHoldTicks = this.config.hardRevTicks;
    const configuredMaxLossPct = Number.isFinite(this.config.maxLossPct as number)
      ? Math.min(-0.0001, Number(this.config.maxLossPct))
      : -0.02;
    const hasDefensiveAddCapacity = Boolean(this.config.defensiveAddEnabled)
      && input.position.addsUsed < this.config.addSizing.length;
    const stopLossThreshold = hasDefensiveAddCapacity
      ? configuredMaxLossPct * 1.5
      : configuredMaxLossPct;
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    const peakPnlPct = this.getPeakPnlPct(input);
    const givebackPct = this.getProfitGivebackPct(input);
    const carryHardExitArmed = peakPnlPct >= this.getTrendCarryHardExitMinPeakPnlPct();
    const carryHardExitTriggered = carryHardExitArmed && givebackPct >= this.getTrendCarryHardExitGivebackPct();
    const confirmedTrendExit = this.hasConfirmedTrendExitContext(input, side);
    const structureInvalidation = this.isStructureInvalidated(input, side);
    const confirmedOppositePressure = this.adverseTrendBuckets >= this.getTrendExitConfirmBars();
    if (unrealizedPnlPct <= stopLossThreshold) {
      return {
        type: StrategyActionType.EXIT,
        side,
        reason: 'EXIT_STOP_LOSS',
        expectedPrice: price,
        metadata: {
          unrealizedPnlPct,
          maxLossPct: configuredMaxLossPct,
          stopLossThreshold,
          defensiveAddArmed: hasDefensiveAddCapacity,
        },
      };
    }
    if (this.isTrendCarryHoldLocked(input, side) && !confirmedTrendExit) {
      return null;
    }
    if (this.shouldProtectFreshExit(input, dfsP, thresholds)) {
      return null;
    }
    if (structureInvalidation && (!trendAligned || htfOpposes || confirmedTrendExit || unrealizedPnlPct <= 0 || carryHardExitTriggered)) {
      return {
        type: StrategyActionType.EXIT,
        side,
        reason: 'EXIT_HARD',
        expectedPrice: price,
        metadata: {
          structureInvalidation: true,
          trendAligned,
          htfOpposes,
          confirmedTrendExit,
        },
      };
    }

    if (
      positionAgeMs >= (15 * 60 * 1000)
      && carryHardExitTriggered
      && (!trendAligned || htfOpposes)
      && this.hasDirectCarryShock(input, side, dfsP, thresholds)
    ) {
      return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price };
    }

    if (this.hasSevereOppositePressure(input, dfsP, thresholds)) {
      const ageMs = this.getPositionAgeMs(input);
      const missingAgeEmergency = ageMs === null;
      if ((confirmedTrendExit || missingAgeEmergency) && (!trendAligned || unrealizedPnlPct <= 0 || carryHardExitTriggered)) {
        return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price };
      }
      return null;
    }

    const strongStructureFailure = side === 'LONG'
      ? price < vwap
        && (this.vwapBelowTicks >= Math.max(6, vwapHoldTicks) || confirmedOppositePressure)
        && dfsP <= Math.min(0.22, thresholds.longBreak - 0.15)
        && input.market.deltaZ <= -1.2
        && input.market.delta5s < 0
        && input.market.cvdSlope < 0
        && input.market.obiWeighted < -0.05
      : price > vwap
        && (this.vwapAboveTicks >= Math.max(6, vwapHoldTicks) || confirmedOppositePressure)
        && dfsP >= Math.max(0.78, thresholds.shortBreak + 0.15)
        && input.market.deltaZ >= 1.2
        && input.market.delta5s > 0
        && input.market.cvdSlope > 0
        && input.market.obiWeighted > 0.05;

    if (!trendAligned && strongStructureFailure && confirmedTrendExit) {
      return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price };
    }

    if (
      confirmedTrendExit
      &&
      trendAligned
      && strongStructureFailure
      && (
        unrealizedPnlPct <= 0.001
        || carryHardExitTriggered
        || (positionAgeMs >= (18 * 3 * 60 * 1000) && unrealizedPnlPct <= 0.002)
      )
    ) {
      return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price };
    }
    return null;
  }

  private checkHardReversal(
    input: StrategyInput,
    dfsP: number
  ): { valid: boolean; reason: DecisionReason } {
    if (!input.position) return { valid: false, reason: 'HARD_REVERSAL_REJECTED' };
    if (this.isFreshPosition(input, this.getFreshReversalProtectMs())) {
      return { valid: false, reason: 'HARD_REVERSAL_REJECTED' };
    }
    const side = input.position.side;
    if (this.isTrendCarryHoldLocked(input, side) || !this.hasConfirmedTrendReversalContext(input, side)) {
      return { valid: false, reason: 'HARD_REVERSAL_REJECTED' };
    }
    const price = input.market.price;
    const vwap = input.market.vwap;
    const devP = this.norm.percentile('dev', Math.abs(price - vwap));
    const deltaAbsP = this.norm.percentile('deltaAbs', Math.abs(input.market.deltaZ));
    const delta1sP = this.norm.percentile('delta1sAbs', Math.abs(input.market.delta1s));
    const delta5sP = this.norm.percentile('delta5sAbs', Math.abs(input.market.delta5s));

    const extreme = devP > 0.95 && (deltaAbsP > 0.95 || delta1sP > 0.95 || delta5sP > 0.95);

    const absorptionOk = this.config.hardRevRequireAbsorption
      ? Boolean(input.absorption?.value) && (input.absorption?.side === (side === 'LONG' ? 'sell' : 'buy'))
      : true;

    const printsHigh = this.norm.percentile('prints', input.trades.printsPerSecond) > 0.8;
    const flowHigh = this.norm.percentile('flow', input.trades.aggressiveBuyVolume + input.trades.aggressiveSellVolume) > 0.8;
    const priceStall = this.prevPrice !== null ? Math.abs(price - this.prevPrice) <= Math.abs(price) * 0.0002 : false;

    const stall = absorptionOk && printsHigh && flowHigh && priceStall;

    const obiDiv = input.market.obiDivergence;
    const obiDivOpposite = side === 'LONG' ? obiDiv < 0 : obiDiv > 0;

    const reversalDfsThreshold = Math.max(this.config.hardRevDfsP, 0.18);
    const counterAggression = side === 'LONG'
      ? dfsP <= reversalDfsThreshold && input.market.cvdSlope < 0 && input.market.obiDeep < 0
      : dfsP >= (1 - reversalDfsThreshold) && input.market.cvdSlope > 0 && input.market.obiDeep > 0;

    const vwapHold = side === 'LONG'
      ? this.vwapBelowTicks >= this.config.hardRevTicks
      : this.vwapAboveTicks >= this.config.hardRevTicks;
    const confirmedOppositePersistence = this.adverseTrendBuckets >= this.getTrendReversalConfirmBars();
    const persistentOppositeContext = vwapHold || confirmedOppositePersistence;

    if (extreme && stall && obiDivOpposite && counterAggression && persistentOppositeContext) {
      return { valid: true, reason: 'EXIT_HARD_REVERSAL' };
    }

    if (absorptionOk && obiDivOpposite && counterAggression && persistentOppositeContext) {
      return { valid: true, reason: 'EXIT_HARD_REVERSAL' };
    }

    return { valid: false, reason: 'HARD_REVERSAL_REJECTED' };
  }

  private shouldProtectFreshExit(
    input: StrategyInput,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): boolean {
    if (!input.position) return false;
    if (!this.isFreshPosition(input, this.getFreshExitProtectMs())) return false;
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    if (unrealizedPnlPct <= this.getFreshExitOverrideLossPct()) {
      return false;
    }
    return !this.hasSevereOppositePressure(input, dfsP, thresholds);
  }

  private hasSevereOppositePressure(
    input: StrategyInput,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): boolean {
    if (!input.position) return false;
    const side = input.position.side;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const burstSide = input.trades.consecutiveBurst.side;
    const printsStrong = this.norm.percentile('prints', input.trades.printsPerSecond) >= 0.7 || input.trades.printsPerSecond >= 8;
    const flowAligned = side === 'LONG'
      ? input.market.deltaZ <= -1.2
        && input.market.delta5s < 0
        && input.market.cvdSlope < 0
        && input.market.obiWeighted < -0.05
        && input.market.obiDeep < -0.02
      : input.market.deltaZ >= 1.2
        && input.market.delta5s > 0
        && input.market.cvdSlope > 0
        && input.market.obiWeighted > 0.05
        && input.market.obiDeep > 0.02;
    const burstAligned = side === 'LONG' ? burstSide === 'sell' : burstSide === 'buy';
    const burstCount = Number(input.trades.consecutiveBurst.count || 0);
    const dfsBroken = side === 'LONG'
      ? dfsP <= Math.min(0.25, thresholds.longBreak - 0.1)
      : dfsP >= Math.max(0.75, thresholds.shortBreak + 0.1);
    const vwapPersist = side === 'LONG'
      ? this.vwapBelowTicks >= Math.max(5, this.config.hardRevTicks - 1)
      : this.vwapAboveTicks >= Math.max(5, this.config.hardRevTicks - 1);
    const htfOpposes = this.isHtfOpposing(side, bias15m, veto1h);
    const htfBroken = side === 'LONG'
      ? Boolean(input.htf?.m15?.structureBreakDn || input.htf?.h1?.structureBreakDn || veto1h === 'DOWN')
      : Boolean(input.htf?.m15?.structureBreakUp || input.htf?.h1?.structureBreakUp || veto1h === 'UP');
    const extremeOppositeTape = side === 'LONG'
      ? input.market.deltaZ <= -3
        && input.market.delta5s < -1
        && input.market.cvdSlope < -1
        && input.market.obiDeep < -0.4
      : input.market.deltaZ >= 3
        && input.market.delta5s > 1
        && input.market.cvdSlope > 1
        && input.market.obiDeep > 0.4;
    const impulseExtreme = side === 'LONG'
      ? input.market.delta1s <= -4
      : input.market.delta1s >= 4;
    const persistentOppositeBurst = burstAligned && burstCount >= Math.max(8, this.config.hardRevTicks + 3);
    const brokenStructurePressure = htfBroken
      && flowAligned
      && dfsBroken
      && vwapPersist
      && (printsStrong || burstAligned || impulseExtreme);
    const tapeShockPressure = (htfOpposes || extremeOppositeTape)
      && flowAligned
      && dfsBroken
      && vwapPersist
      && (persistentOppositeBurst || (printsStrong && impulseExtreme));
    return brokenStructurePressure || tapeShockPressure;
  }

  private hasDirectCarryShock(
    input: StrategyInput,
    side: StrategySide,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): boolean {
    const burstSide = input.trades.consecutiveBurst.side;
    const burstAligned = side === 'LONG' ? burstSide === 'sell' : burstSide === 'buy';
    const burstCount = Number(input.trades.consecutiveBurst.count || 0);
    const printsStrong = this.norm.percentile('prints', input.trades.printsPerSecond) >= 0.7 || input.trades.printsPerSecond >= 8;
    const dfsBroken = side === 'LONG'
      ? dfsP <= Math.min(0.25, thresholds.longBreak - 0.1)
      : dfsP >= Math.max(0.75, thresholds.shortBreak + 0.1);
    const flowAligned = side === 'LONG'
      ? input.market.deltaZ <= -1.2
        && input.market.delta5s < 0
        && input.market.cvdSlope < 0
        && input.market.obiWeighted < -0.05
        && input.market.obiDeep < -0.02
      : input.market.deltaZ >= 1.2
        && input.market.delta5s > 0
        && input.market.cvdSlope > 0
        && input.market.obiWeighted > 0.05
        && input.market.obiDeep > 0.02;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const htfOpposes = this.isHtfOpposing(side, bias15m, veto1h);
    const htfBroken = side === 'LONG'
      ? Boolean(input.htf?.m15?.structureBreakDn || input.htf?.h1?.structureBreakDn || veto1h === 'DOWN')
      : Boolean(input.htf?.m15?.structureBreakUp || input.htf?.h1?.structureBreakUp || veto1h === 'UP');
    const extremeOppositeTape = side === 'LONG'
      ? input.market.deltaZ <= -3
        && input.market.delta5s < -1
        && input.market.cvdSlope < -1
        && input.market.obiDeep < -0.4
      : input.market.deltaZ >= 3
        && input.market.delta5s > 1
        && input.market.cvdSlope > 1
        && input.market.obiDeep > 0.4;
    const impulseExtreme = side === 'LONG' ? input.market.delta1s <= -4 : input.market.delta1s >= 4;
    return (htfOpposes || htfBroken || extremeOppositeTape)
      && flowAligned
      && dfsBroken
      && (burstAligned && burstCount >= Math.max(8, this.config.hardRevTicks + 3) || (printsStrong && impulseExtreme));
  }

  private hasTrendCarryPressure(input: StrategyInput, side: StrategySide): boolean {
    const burstSide = input.trades.consecutiveBurst.side;
    const burstOpposite = side === 'LONG' ? burstSide === 'sell' : burstSide === 'buy';
    const printsStrong = this.norm.percentile('prints', input.trades.printsPerSecond) >= 0.6 || input.trades.printsPerSecond >= 6;
    if (side === 'LONG') {
      return input.market.deltaZ <= -0.8
        && input.market.delta5s < 0
        && input.market.cvdSlope < 0
        && input.market.obiWeighted < -0.02
        && (printsStrong || burstOpposite);
    }
    return input.market.deltaZ >= 0.8
      && input.market.delta5s > 0
      && input.market.cvdSlope > 0
      && input.market.obiWeighted > 0.02
      && (printsStrong || burstOpposite);
  }

  private hasTrendStructureBreak(
    input: StrategyInput,
    side: StrategySide,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): boolean {
    const vwapPersist = side === 'LONG'
      ? this.vwapBelowTicks >= Math.max(5, Math.floor(this.config.hardRevTicks * 0.8))
      : this.vwapAboveTicks >= Math.max(5, Math.floor(this.config.hardRevTicks * 0.8));
    const dfsBroken = side === 'LONG'
      ? dfsP <= Math.min(0.32, thresholds.longBreak - 0.08)
      : dfsP >= Math.max(0.68, thresholds.shortBreak + 0.08);
    const vwapBroken = side === 'LONG'
      ? input.market.price < input.market.vwap
      : input.market.price > input.market.vwap;
    const momentumBroken = side === 'LONG'
      ? input.market.deltaZ <= -1.2 && input.market.delta5s < 0 && input.market.cvdSlope < 0
      : input.market.deltaZ >= 1.2 && input.market.delta5s > 0 && input.market.cvdSlope > 0;
    return (vwapPersist && dfsBroken && vwapBroken) || (vwapBroken && dfsBroken && momentumBroken);
  }

  private isTrendAligned(side: StrategySide, bias15m: 'UP' | 'DOWN' | 'NEUTRAL', veto1h: 'NONE' | 'UP' | 'DOWN'): boolean {
    return side === 'LONG'
      ? bias15m === 'UP' && veto1h !== 'DOWN'
      : bias15m === 'DOWN' && veto1h !== 'UP';
  }

  private isHtfOpposing(side: StrategySide, bias15m: 'UP' | 'DOWN' | 'NEUTRAL', veto1h: 'NONE' | 'UP' | 'DOWN'): boolean {
    return side === 'LONG'
      ? (bias15m === 'DOWN' || veto1h === 'DOWN')
      : (bias15m === 'UP' || veto1h === 'UP');
  }

  private getPositionAgeMs(input: StrategyInput): number | null {
    const ageMs = Number(input.position?.timeInPositionMs);
    if (!Number.isFinite(ageMs) || ageMs <= 0) return null;
    return ageMs;
  }

  private isFreshPosition(input: StrategyInput, protectMs: number): boolean {
    const ageMs = this.getPositionAgeMs(input);
    return ageMs !== null && ageMs < protectMs;
  }

  private getFreshExitProtectMs(): number {
    const configured = Number(this.config.freshExitProtectS);
    if (Number.isFinite(configured) && configured > 0) return configured * 1000;
    return DEFAULT_FRESH_EXIT_PROTECT_MS;
  }

  private getFreshSoftReduceProtectMs(): number {
    const configured = Number(this.config.freshSoftReduceProtectS);
    if (Number.isFinite(configured) && configured > 0) return configured * 1000;
    return DEFAULT_FRESH_SOFT_REDUCE_PROTECT_MS;
  }

  private getSoftReduceCooldownMs(): number {
    const configured = Number(this.config.softReduceCooldownS);
    if (Number.isFinite(configured) && configured > 0) return configured * 1000;
    return DEFAULT_SOFT_REDUCE_COOLDOWN_MS;
  }

  private getFreshReversalProtectMs(): number {
    const configured = Number(this.config.freshReversalProtectS);
    if (Number.isFinite(configured) && configured > 0) return configured * 1000;
    return DEFAULT_FRESH_REVERSAL_PROTECT_MS;
  }

  private getFreshExitOverrideLossPct(): number {
    const configured = Number(this.config.freshExitOverrideLossPct);
    if (Number.isFinite(configured) && configured < 0) return configured;
    return DEFAULT_FRESH_EXIT_OVERRIDE_LOSS_PCT;
  }

  private getTrendCarryReduceMinPeakPnlPct(): number {
    const configured = Number(this.config.trendCarryReduceMinPeakPnlPct);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return 0.006;
  }

  private getTrendCarryReduceGivebackPct(): number {
    const configured = Number(this.config.trendCarryReduceGivebackPct);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return 0.003;
  }

  private getTrendCarryHardExitMinPeakPnlPct(): number {
    const configured = Number(this.config.trendCarryHardExitMinPeakPnlPct);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return 0.009;
  }

  private getTrendCarryHardExitGivebackPct(): number {
    const configured = Number(this.config.trendCarryHardExitGivebackPct);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return 0.0045;
  }

  private getTrendDecisionBarMs(): number {
    return DEFAULT_TREND_DECISION_BAR_MS;
  }

  private getTrendCarryMinHoldMs(): number {
    const configuredBars = Number(this.config.trendCarryMinHoldBars);
    const bars = Number.isFinite(configuredBars) && configuredBars > 0 ? configuredBars : 2;
    return Math.max(this.getFreshExitProtectMs(), bars * this.getTrendDecisionBarMs());
  }

  private getTrendExitConfirmBars(): number {
    const configured = Number(this.config.trendExitConfirmBars);
    if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.floor(configured));
    return 2;
  }

  private getTrendReversalConfirmBars(): number {
    const configured = Number(this.config.trendReversalConfirmBars);
    if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.floor(configured));
    return 3;
  }

  private getRuntimeTrendState(input: StrategyInput): StrategyTrendState {
    const executionTrendState = input.execution?.trendState ?? null;
    if (executionTrendState) return executionTrendState;
    const bias15m = this.bias15m(input);
    if (bias15m === 'UP') {
      return input.market.price >= input.market.vwap ? 'UPTREND' : 'PULLBACK_UP';
    }
    if (bias15m === 'DOWN') {
      return input.market.price <= input.market.vwap ? 'DOWNTREND' : 'PULLBACK_DOWN';
    }
    return 'RANGE';
  }

  private isAlignedTrendState(side: StrategySide, trendState: StrategyTrendState): boolean {
    return side === 'LONG'
      ? (trendState === 'UPTREND' || trendState === 'PULLBACK_UP')
      : (trendState === 'DOWNTREND' || trendState === 'PULLBACK_DOWN');
  }

  private isOpposingTrendState(side: StrategySide, trendState: StrategyTrendState): boolean {
    return side === 'LONG'
      ? (trendState === 'DOWNTREND' || trendState === 'PULLBACK_DOWN')
      : (trendState === 'UPTREND' || trendState === 'PULLBACK_UP');
  }

  private resetTrendDecisionState(): void {
    this.trackedTrendPositionSide = null;
    this.trackedTrendLastBucket = -1;
    this.trackedTrendLastAgeMs = 0;
    this.adverseTrendBuckets = 0;
    this.neutralTrendBuckets = 0;
  }

  private updateTrendDecisionState(input: StrategyInput): void {
    if (!input.position) {
      this.resetTrendDecisionState();
      return;
    }

    const side = input.position.side;
    const ageMs = Math.max(0, Number(input.position.timeInPositionMs || 0));
    if (this.trackedTrendPositionSide !== side || ageMs < this.trackedTrendLastAgeMs) {
      this.resetTrendDecisionState();
      this.trackedTrendPositionSide = side;
    }

    this.trackedTrendPositionSide = side;
    this.trackedTrendLastAgeMs = ageMs;
    const bucket = Math.floor(input.nowMs / this.getTrendDecisionBarMs());
    if (bucket === this.trackedTrendLastBucket) return;
    this.trackedTrendLastBucket = bucket;

    const trendState = this.getRuntimeTrendState(input);
    if (this.isOpposingTrendState(side, trendState)) {
      this.adverseTrendBuckets += 1;
      this.neutralTrendBuckets = 0;
      return;
    }
    if (trendState === 'RANGE') {
      this.neutralTrendBuckets += 1;
      this.adverseTrendBuckets = 0;
      return;
    }

    this.adverseTrendBuckets = 0;
    this.neutralTrendBuckets = 0;
  }

  private hasConfirmedTrendExitContext(input: StrategyInput, side: StrategySide): boolean {
    const ageMs = this.getPositionAgeMs(input);
    if (ageMs !== null && ageMs < this.getTrendCarryMinHoldMs()) return false;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const htfOpposes = this.isHtfOpposing(side, bias15m, veto1h);
    const trendState = this.getRuntimeTrendState(input);
    const requiredBars = this.getTrendExitConfirmBars();

    if (this.isOpposingTrendState(side, trendState) && this.adverseTrendBuckets >= requiredBars) {
      return true;
    }
    if (trendState === 'RANGE' && htfOpposes && this.neutralTrendBuckets >= requiredBars) {
      return true;
    }
    return false;
  }

  private hasConfirmedTrendReversalContext(input: StrategyInput, side: StrategySide): boolean {
    const ageMs = this.getPositionAgeMs(input);
    if (ageMs !== null && ageMs < Math.max(this.getFreshReversalProtectMs(), this.getTrendCarryMinHoldMs())) return false;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const trendState = this.getRuntimeTrendState(input);
    if (!this.isHtfOpposing(side, bias15m, veto1h)) return false;
    return this.isOpposingTrendState(side, trendState) && this.adverseTrendBuckets >= this.getTrendReversalConfirmBars();
  }

  private isTrendCarryHoldLocked(input: StrategyInput, side: StrategySide): boolean {
    const ageMs = this.getPositionAgeMs(input);
    if (ageMs === null) return false;
    if (ageMs >= this.getTrendCarryMinHoldMs()) return false;
    return this.isAlignedTrendState(side, this.getRuntimeTrendState(input));
  }

  private getPeakPnlPct(input: StrategyInput): number {
    if (!input.position) return 0;
    const current = Number(input.position.unrealizedPnlPct ?? 0);
    const peak = Number(input.position.peakPnlPct ?? current);
    if (!Number.isFinite(peak)) return Math.max(0, current);
    return Math.max(peak, current);
  }

  private getProfitGivebackPct(input: StrategyInput): number {
    if (!input.position) return 0;
    const peak = this.getPeakPnlPct(input);
    const current = Number(input.position.unrealizedPnlPct ?? 0);
    return Math.max(0, peak - current);
  }

  private isHardExitDebounced(side: StrategySide, nowMs: number): boolean {
    return this.lastHardExitSide === side && this.lastHardExitTs > 0 && (nowMs - this.lastHardExitTs) < DEFAULT_HARD_EXIT_DEBOUNCE_MS;
  }

  private isHardReversalDebounced(side: StrategySide, nowMs: number): boolean {
    return this.lastHardReversalSide === side && this.lastHardReversalTs > 0 && (nowMs - this.lastHardReversalTs) < DEFAULT_HARD_REVERSAL_DEBOUNCE_MS;
  }

  private isInCooldown(side: StrategySide, nowMs: number, volLevel: number): boolean {
    if (this.lastExitTs <= 0 || !this.lastExitSide) return false;
    const flip = this.lastExitSide !== side;
    const volAdj = this.volMultiplier(volLevel);
    const cooldownMs = flip
      ? this.config.cooldownFlipS * 1000 * volAdj
      : this.config.cooldownSameS * 1000;
    return nowMs < this.lastExitTs + cooldownMs;
  }

  private isInMHT(side: StrategySide, nowMs: number, volLevel: number): boolean {
    if (this.lastEntryTs <= 0 || !this.lastEntrySide) return false;
    if (side === this.lastEntrySide) return false;
    const elapsed = nowMs - this.lastEntryTs;
    const base = this.mhtBaseMs(this.lastEntryRegime);
    const mhtMs = base * this.volMultiplier(volLevel);
    return elapsed < mhtMs;
  }

  private updateVwapTicks(price: number, vwap: number): void {
    if (price < vwap) {
      this.vwapBelowTicks += 1;
      this.vwapAboveTicks = 0;
    } else if (price > vwap) {
      this.vwapAboveTicks += 1;
      this.vwapBelowTicks = 0;
    }
  }

  private getStructure(input: StrategyInput): StructureSnapshot | null {
    if (!this.config.structureEnabled) return null;
    if (!input.structure) return null;
    return input.structure;
  }

  private hasFreshStructure(input: StrategyInput): boolean {
    const structure = this.getStructure(input);
    if (!structure) return false;
    if (!this.config.structureEntryRequireFreshness) return true;
    return Boolean(structure.isFresh);
  }

  private isStructureEntryAligned(input: StrategyInput, side: StrategySide): boolean {
    if (!this.config.structureEnabled) return true;
    const structure = this.getStructure(input);
    if (!structure) return false;
    if (this.config.structureEntryRequireFreshness && !structure.isFresh) return false;
    if (side === 'LONG') {
      return structure.bias === 'BULLISH' && (structure.bosUp || structure.reclaimUp);
    }
    return structure.bias === 'BEARISH' && (structure.bosDn || structure.reclaimDn);
  }

  private hasStructureContinuation(input: StrategyInput, side: StrategySide): boolean {
    if (!this.config.structureEnabled) return true;
    const structure = this.getStructure(input);
    if (!structure || !structure.isFresh) return false;
    return side === 'LONG'
      ? Boolean(structure.continuationLong && structure.bias !== 'BEARISH')
      : Boolean(structure.continuationShort && structure.bias !== 'BULLISH');
  }

  private isStructureInvalidated(input: StrategyInput, side: StrategySide): boolean {
    if (!this.config.structureEnabled) return false;
    const structure = this.getStructure(input);
    if (!structure || !structure.isFresh) return false;
    const price = Number(input.market.price || 0);
    if (!(price > 0)) return false;
    if (side === 'LONG') {
      const stopAnchor = this.config.structureTrailEnabled ? structure.anchors.longStopAnchor : null;
      return Boolean(structure.bosDn || (stopAnchor != null && price <= stopAnchor));
    }
    const stopAnchor = this.config.structureTrailEnabled ? structure.anchors.shortStopAnchor : null;
    return Boolean(structure.bosUp || (stopAnchor != null && price >= stopAnchor));
  }

  private flipSide(side: StrategySide): StrategySide {
    return side === 'LONG' ? 'SHORT' : 'LONG';
  }

  private bias15m(input: StrategyInput): 'UP' | 'DOWN' | 'NEUTRAL' {
    const executionBias = input.execution?.bias15m;
    if (executionBias === 'UP' || executionBias === 'DOWN' || executionBias === 'NEUTRAL') {
      return executionBias;
    }
    return deriveBias15m(input.htf?.m15, input.market.price);
  }

  private veto1h(input: StrategyInput): 'NONE' | 'UP' | 'DOWN' {
    const executionVeto = input.execution?.veto1h;
    if (executionVeto === 'UP' || executionVeto === 'DOWN' || executionVeto === 'NONE') {
      return executionVeto;
    }
    return deriveVeto1h(input.htf?.h1, input.market.price);
  }

  private mhtBaseMs(regime: StrategyRegime): number {
    if (regime === 'EV') return this.config.mhtEVs * 1000;
    if (regime === 'MR') return this.config.mhtMRs * 1000;
    return this.config.mhtTRs * 1000;
  }

  private volMultiplier(volLevel: number): number {
    if (volLevel > this.config.volHighP) return 1.5;
    if (volLevel < this.config.volLowP) return 0.75;
    return 1;
  }

  private buildDecision(
    input: StrategyInput,
    regime: StrategyRegime,
    dfsOut: { dfs: number; dfsPercentile: number },
    thresholds: { longEntry: number; longBreak: number; shortEntry: number; shortBreak: number },
    gate: { passed: boolean; reason: DecisionReason | null; details: Record<string, unknown> },
    actions: StrategyAction[],
    reasons: DecisionReason[]
  ): StrategyDecision {
    const log = {
      timestampMs: input.nowMs,
      symbol: input.symbol,
      regime,
      gate,
      dfs: dfsOut.dfs,
      dfsPercentile: dfsOut.dfsPercentile,
      volLevel: this.norm.percentile('vol', input.volatility),
      thresholds: {
        longEntry: thresholds.longEntry,
        longBreak: thresholds.longBreak,
        shortEntry: thresholds.shortEntry,
        shortBreak: thresholds.shortBreak,
      },
      reasons,
      actions,
      stats: {
        price: input.market.price,
        vwap: input.market.vwap,
        deltaZ: input.market.deltaZ,
        cvdSlope: input.market.cvdSlope,
        obiDeep: input.market.obiDeep,
        printsPerSecond: input.trades.printsPerSecond,
        unrealizedPnlPct: input.position?.unrealizedPnlPct ?? null,
        peakPnlPct: input.position?.peakPnlPct ?? null,
        givebackPnlPct: input.position ? this.getProfitGivebackPct(input) : null,
        structureFresh: input.structure?.isFresh ? 1 : 0,
        structureLongStopAnchor: input.structure?.anchors.longStopAnchor ?? null,
        structureShortStopAnchor: input.structure?.anchors.shortStopAnchor ?? null,
      },
      replayInput: INCLUDE_REPLAY_INPUT ? this.cloneReplayInput(input) : undefined,
    };

    if (this.decisionLog) {
      this.decisionLog.record(log);
    }

    return {
      symbol: input.symbol,
      timestampMs: input.nowMs,
      regime,
      dfs: dfsOut.dfs,
      dfsPercentile: dfsOut.dfsPercentile,
      volLevel: log.volLevel,
      gatePassed: gate.passed,
      actions,
      reasons,
      log,
    };
  }

  private cloneReplayInput(input: StrategyInput): StrategyInput {
    return {
      symbol: input.symbol,
      nowMs: input.nowMs,
      source: input.source,
      orderbook: {
        lastUpdatedMs: input.orderbook.lastUpdatedMs,
        spreadPct: input.orderbook.spreadPct ?? null,
        bestBid: input.orderbook.bestBid ?? null,
        bestAsk: input.orderbook.bestAsk ?? null,
      },
      trades: {
        lastUpdatedMs: input.trades.lastUpdatedMs,
        printsPerSecond: input.trades.printsPerSecond,
        tradeCount: input.trades.tradeCount,
        aggressiveBuyVolume: input.trades.aggressiveBuyVolume,
        aggressiveSellVolume: input.trades.aggressiveSellVolume,
        consecutiveBurst: {
          side: input.trades.consecutiveBurst.side,
          count: input.trades.consecutiveBurst.count,
        },
      },
      market: {
        price: input.market.price,
        vwap: input.market.vwap,
        delta1s: input.market.delta1s,
        delta5s: input.market.delta5s,
        deltaZ: input.market.deltaZ,
        cvdSlope: input.market.cvdSlope,
        obiWeighted: input.market.obiWeighted,
        obiDeep: input.market.obiDeep,
        obiDivergence: input.market.obiDivergence,
      },
      openInterest: input.openInterest
        ? {
            oiChangePct: input.openInterest.oiChangePct,
            lastUpdatedMs: input.openInterest.lastUpdatedMs,
            source: input.openInterest.source,
          }
        : null,
      absorption: input.absorption
        ? {
            value: input.absorption.value,
            side: input.absorption.side,
          }
        : null,
      bootstrap: input.bootstrap
        ? {
            backfillDone: input.bootstrap.backfillDone,
            barsLoaded1m: input.bootstrap.barsLoaded1m,
          }
        : null,
      htf: input.htf
        ? {
            m15: input.htf.m15
              ? {
                  close: input.htf.m15.close,
                  atr: input.htf.m15.atr,
                  lastSwingHigh: input.htf.m15.lastSwingHigh,
                  lastSwingLow: input.htf.m15.lastSwingLow,
                  structureBreakUp: input.htf.m15.structureBreakUp,
                  structureBreakDn: input.htf.m15.structureBreakDn,
                }
              : null,
            h1: input.htf.h1
              ? {
                  close: input.htf.h1.close,
                  atr: input.htf.h1.atr,
                  lastSwingHigh: input.htf.h1.lastSwingHigh,
                  lastSwingLow: input.htf.h1.lastSwingLow,
                  structureBreakUp: input.htf.h1.structureBreakUp,
                  structureBreakDn: input.htf.h1.structureBreakDn,
                }
              : null,
          }
        : null,
      structure: input.structure
        ? {
            enabled: input.structure.enabled,
            updatedAtMs: input.structure.updatedAtMs,
            freshnessMs: input.structure.freshnessMs,
            isFresh: input.structure.isFresh,
            bias: input.structure.bias,
            primaryTimeframe: input.structure.primaryTimeframe,
            recentClose: input.structure.recentClose,
            recentAtr: input.structure.recentAtr,
            sourceBarCount: input.structure.sourceBarCount,
            zone: input.structure.zone
              ? {
                  high: input.structure.zone.high,
                  low: input.structure.zone.low,
                  mid: input.structure.zone.mid,
                  range: input.structure.zone.range,
                  timeframe: input.structure.zone.timeframe,
                  formedAtMs: input.structure.zone.formedAtMs,
                }
              : null,
            anchors: {
              longStopAnchor: input.structure.anchors.longStopAnchor,
              shortStopAnchor: input.structure.anchors.shortStopAnchor,
              longTargetBand: input.structure.anchors.longTargetBand,
              shortTargetBand: input.structure.anchors.shortTargetBand,
            },
            bosUp: input.structure.bosUp,
            bosDn: input.structure.bosDn,
            reclaimUp: input.structure.reclaimUp,
            reclaimDn: input.structure.reclaimDn,
            continuationLong: input.structure.continuationLong,
            continuationShort: input.structure.continuationShort,
            lastSwingLabel: input.structure.lastSwingLabel,
            lastSwingTimestampMs: input.structure.lastSwingTimestampMs,
            lastConfirmedHH: input.structure.lastConfirmedHH,
            lastConfirmedHL: input.structure.lastConfirmedHL,
            lastConfirmedLH: input.structure.lastConfirmedLH,
            lastConfirmedLL: input.structure.lastConfirmedLL,
          }
        : null,
      execution: input.execution
        ? {
            startupMode: input.execution.startupMode ?? null,
            seedReady: input.execution.seedReady ?? input.execution.tradeReady,
            tradeReady: input.execution.tradeReady,
            addonReady: input.execution.addonReady,
            vetoReason: input.execution.vetoReason,
            orderbookTrusted: input.execution.orderbookTrusted,
            integrityLevel: input.execution.integrityLevel ?? null,
            trendState: input.execution.trendState ?? null,
            trendConfidence: input.execution.trendConfidence ?? null,
            bias15m: input.execution.bias15m ?? null,
            veto1h: input.execution.veto1h ?? null,
          }
        : null,
      volatility: input.volatility,
      position: input.position
        ? {
            side: input.position.side,
            qty: input.position.qty,
            entryPrice: input.position.entryPrice,
            unrealizedPnlPct: input.position.unrealizedPnlPct,
            addsUsed: input.position.addsUsed,
            sizePct: input.position.sizePct,
            timeInPositionMs: input.position.timeInPositionMs,
            peakPnlPct: input.position.peakPnlPct,
          }
        : null,
    };
  }
}
