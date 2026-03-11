import { DecisionLog } from '../telemetry/DecisionLog';
import {
  EntrySetupKind,
  DecisionReason,
  StrategyAction,
  StrategyActionType,
  StrategyConfig,
  StrategyDecisionContext,
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
import { ProbabilisticRegimeScorer, RegimePosterior } from './ProbabilisticRegimeScorer';
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
  private readonly regimeScorer: ProbabilisticRegimeScorer;
  private lastRegimePosterior: RegimePosterior | null = null;
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

  // Scale-out state: tracks partial stops and breakeven arm per position
  // Keyed by `${symbol}:${entryPrice}` — resets automatically when a new position opens
  private scaleOutState = new Map<string, {
    stop1Used: boolean;
    stop2Used: boolean;
    breakevenArmed: boolean;
    entryPrice: number;
  }>();

  // ─── DFS Peak/Trough tracker for Exhaustion Fade & Trend Pullback setups ───
  // Rolling window of DFS percentile samples (last 120 seconds / ~120 ticks)
  private dfsRollingWindow: { ts: number; dfsP: number }[] = [];
  private readonly DFS_ROLLING_WINDOW_MS = 120_000; // 2 minutes lookback
  // Track whether DFS peak/trough condition was met (arm) and then triggered
  private exhaustionFadeArmed = false;   // DFS >= 0.90 peak seen
  private exhaustionFadeArmTs = 0;
  private trendPullbackArmed = false;    // DFS <= 0.10 trough seen
  private trendPullbackArmTs = 0;
  private readonly SETUP_ARM_EXPIRY_MS = 60_000; // armed state expires after 60s

  constructor(config?: Partial<StrategyConfig>, decisionLog?: DecisionLog) {
    this.config = { ...defaultStrategyConfig, ...(config || {}) };
    const windowMs = Math.max(60_000, this.config.rollingWindowMin * 60_000);
    this.norm = new NormalizationStore(windowMs, 64);
    this.dfs = new DirectionalFlowScore(this.norm);
    this.regimeSelector = new RegimeSelector(this.norm, this.config.regimeLockTRMRTicks, this.config.regimeLockEVTicks);
    this.regimeScorer = new ProbabilisticRegimeScorer();
    this.decisionLog = decisionLog;
  }

  /** Returns the latest probabilistic regime posterior (TR/MR/EV probabilities) */
  getRegimePosterior(): RegimePosterior | null {
    return this.lastRegimePosterior;
  }

  /**
   * Call after a position closes to update DFS component weights via EMA.
   * @param side        - closed position side
   * @param pnlFraction - realized PnL as fraction (e.g. 0.012 = +1.2%)
   */
  updateDfsWeightsFromTrade(side: 'LONG' | 'SHORT', pnlFraction: number): void {
    this.dfs.updateWeightsFromTrade(side, pnlFraction);
  }

  /**
   * Patch strategy config at runtime (e.g. from GA optimizer).
   * Only numeric fields are updated; all other config remains unchanged.
   */
  patchConfig(patch: Partial<StrategyConfig>): void {
    Object.assign(this.config, patch);
  }

  /** Returns a snapshot of the current config (read-only copy). */
  getConfig(): Readonly<StrategyConfig> {
    return { ...this.config };
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

    // Probabilistic regime scoring (HMM-inspired Bayesian posterior)
    this.lastRegimePosterior = this.regimeScorer.update({
      volLevel: regimeOut.volLevel,
      trendStrength: Math.abs(dfsOut.dfsPercentile - 0.5) * 2,
      meanRevScore: regimeOut.scores.meanRevScore,
      eventScore: regimeOut.scores.eventScore,
      nowMs,
    });

    const activeRegime = this.resolveActiveRegime(input, regimeOut.regime, dfsOut.dfsPercentile);
    const thresholds = this.computeThresholds(regimeOut.volLevel, activeRegime);
    const actions: StrategyAction[] = [];

    this.updateVwapTicks(input.market.price, input.market.vwap);
    this.updateTrendDecisionState(input);
    this.updateDfsRollingWindow(nowMs, dfsOut.dfsPercentile);

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

  private computeThresholds(volLevel: number, regime?: StrategyRegime) {
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

    // MR: Exhaustion Fade setup has its own trigger logic (DFS peak → drop)
    // No need to tighten DFS thresholds — the setup handles conviction internally
    // TR: Pullback entries don't use traditional DFS threshold crossing

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
    // P0-3: EV (Extreme Volatility) rejiminde yeni pozisyon açma — sadece mevcut pozisyonu yönet
    if (regime === 'EV') {
      reasons.push('ENTRY_BLOCKED_EV_REGIME');
      return null;
    }

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

    const setupKind = this.entryFilters(input, dfsP, dfs, regime, volLevel, thresholds, desiredSide);
    if (!setupKind) {
      reasons.push('ENTRY_BLOCKED_FILTERS');
      return null;
    }

    this.lastEntryTs = input.nowMs;
    const entryReason: DecisionReason = setupKind === 'EXHAUSTION_FADE'
      ? 'ENTRY_EXHAUSTION_FADE'
      : setupKind === 'TREND_PULLBACK_RELOAD'
        ? 'ENTRY_TREND_PULLBACK'
        : regime === 'EV' ? 'ENTRY_EV' : regime === 'MR' ? 'ENTRY_MR' : 'ENTRY_TR';
    return {
      type: StrategyActionType.ENTRY,
      side: desiredSide,
      reason: entryReason,
      expectedPrice: input.market.price,
      sizeMultiplier: this.getEntrySizeMultiplier(input, setupKind),
      metadata: {
        setupKind,
        contextQuality: input.decisionContext?.execution.quality ?? null,
        exhaustionFadeArmed: setupKind === 'EXHAUSTION_FADE' ? this.exhaustionFadeArmed : undefined,
        trendPullbackArmed: setupKind === 'TREND_PULLBACK_RELOAD' ? this.trendPullbackArmed : undefined,
      },
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
    const context = this.getDecisionContext(input);

    // ─── SETUP 1: Exhaustion Fade (primarily MR) ───
    // SHORT: DFS peaked >= 0.90, now dropped < 0.70, CVD Slope < 0, OBI Deep < -0.20
    // LONG:  DFS troughed <= 0.10, now risen > 0.30, CVD Slope > 0, OBI Deep > 0.20
    if (regime === 'MR') {
      const shortFade = this.checkExhaustionFadeShort(input, dfsP, context);
      if (shortFade && veto1h !== 'UP') return 'SHORT';
      const longFade = this.checkExhaustionFadeLong(input, dfsP, context);
      if (longFade && veto1h !== 'DOWN') return 'LONG';
    }

    // ─── SETUP 2: Trend Pullback & Reload (primarily TR) ───
    // LONG:  Trend UP, price near VWAP/VAL, DFS dipped <= 0.10, now DeltaZ > 0 & DFS > 0.30
    // SHORT: Trend DOWN, price near VWAP/VAH, DFS spiked >= 0.90, now DeltaZ < 0 & DFS < 0.70
    if (regime === 'TR') {
      const longPullback = this.checkTrendPullbackLong(input, dfsP, context);
      if (longPullback && bias15m === 'UP' && veto1h !== 'DOWN') return 'LONG';
      const shortPullback = this.checkTrendPullbackShort(input, dfsP, context);
      if (shortPullback && bias15m === 'DOWN' && veto1h !== 'UP') return 'SHORT';
    }

    // Legacy fallback: if none of the two setups fire, allow structure-aligned
    // trend continuation with original logic (but NOT breakout chasing)
    if (regime === 'TR') {
      // TR: only pullback entries near VWAP — never breakout buying
      const price = input.market.price;
      const vwap = input.market.vwap;
      const nearVwap = vwap > 0 && Math.abs(price - vwap) / vwap < 0.004;
      if (nearVwap && bias15m === 'UP' && veto1h !== 'DOWN' && this.isStructureEntryAligned(input, 'LONG')) {
        return 'LONG';
      }
      if (nearVwap && bias15m === 'DOWN' && veto1h !== 'UP' && this.isStructureEntryAligned(input, 'SHORT')) {
        return 'SHORT';
      }
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
  ): EntrySetupKind | null {
    if (this.shouldBlockEntryByDecisionContext(input)) {
      return null;
    }

    // Funding Rate overcrowding filter
    const fundingRate = input.funding?.rate ?? null;
    if (fundingRate !== null) {
      const FUNDING_OVERCROWD_THRESHOLD = Number((this.config as any).fundingOvercrowdThreshold ?? 0.0003);
      if (desiredSide === 'LONG' && fundingRate > FUNDING_OVERCROWD_THRESHOLD) return null;
      if (desiredSide === 'SHORT' && fundingRate < -FUNDING_OVERCROWD_THRESHOLD) return null;
    }

    const context = this.getDecisionContext(input);

    // ─── SETUP 1: Exhaustion Fade (MR) ───
    if (regime === 'MR') {
      if (desiredSide === 'SHORT' && this.checkExhaustionFadeShort(input, dfsP, context)) {
        return 'EXHAUSTION_FADE';
      }
      if (desiredSide === 'LONG' && this.checkExhaustionFadeLong(input, dfsP, context)) {
        return 'EXHAUSTION_FADE';
      }
    }

    // ─── SETUP 2: Trend Pullback & Reload (TR) ───
    if (regime === 'TR') {
      if (desiredSide === 'LONG' && this.checkTrendPullbackLong(input, dfsP, context)) {
        return 'TREND_PULLBACK_RELOAD';
      }
      if (desiredSide === 'SHORT' && this.checkTrendPullbackShort(input, dfsP, context)) {
        return 'TREND_PULLBACK_RELOAD';
      }
    }

    // ─── Legacy: Trend continuation at VWAP pullback (no breakout chasing) ───
    const cvdQuadrant = this.detectCVDQuadrant(input);
    if (cvdQuadrant === 'BUY_EXHAUSTION' && desiredSide === 'LONG') return null;
    if (cvdQuadrant === 'SELL_EXHAUSTION' && desiredSide === 'SHORT') return null;

    const absorptionOverride =
      (cvdQuadrant === 'PASSIVE_BUY_ABSORPTION' && desiredSide === 'LONG') ||
      (cvdQuadrant === 'PASSIVE_SELL_ABSORPTION' && desiredSide === 'SHORT');

    if (!absorptionOverride) {
      const cvdSlope = input.market.cvdSlope ?? 0;
      const bias15m = this.bias15m(input);
      const CVD_DIVERG_THRESHOLD = 0.25;
      if (desiredSide === 'LONG' && bias15m === 'UP' && cvdSlope < -CVD_DIVERG_THRESHOLD) return null;
      if (desiredSide === 'SHORT' && bias15m === 'DOWN' && cvdSlope > CVD_DIVERG_THRESHOLD) return null;
    }

    // TR: only pullback entries (never breakout) → require price near VWAP
    if (regime === 'TR') {
      const price = input.market.price;
      const vwap = input.market.vwap;
      if (vwap > 0 && Math.abs(price - vwap) / vwap > 0.005) return null; // too far from VWAP
      // Require OBI/CVD alignment for pullback entry
      if (desiredSide === 'LONG' && (input.market.obiWeighted < 0 || input.market.cvdSlope < -0.15)) return null;
      if (desiredSide === 'SHORT' && (input.market.obiWeighted > 0 || input.market.cvdSlope > 0.15)) return null;
    }

    return this.allowTrendCarryEntry(input, desiredSide, dfsP, thresholds) ? 'TREND_CONTINUATION' : null;
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

  private getDecisionContext(input: StrategyInput): StrategyDecisionContext | null {
    return input.decisionContext ?? null;
  }

  private shouldBlockEntryByDecisionContext(input: StrategyInput): boolean {
    if (!this.config.contextEntryVetoEnabled) return false;
    const context = this.getDecisionContext(input);
    if (!context) return false;
    const spoofThreshold = context.adaptive?.ready
      ? context.adaptive.spoofScoreThreshold
      : this.config.maxSpoofScoreForEntry;
    const vpinThreshold = context.adaptive?.ready
      ? context.adaptive.vpinThreshold
      : this.config.maxVpinForEntry;
    const slippageThreshold = context.adaptive?.ready
      ? context.adaptive.expectedSlippageBpsThreshold
      : this.config.maxExpectedSlippageBpsForEntry;
    if (context.execution.quality === 'BLOCKED') return true;
    if (context.manipulation.spoofScore > spoofThreshold) return true;
    if (context.manipulation.vpinApprox > vpinThreshold) return true;
    if (context.liquidity.expectedSlippageBps > slippageThreshold) return true;
    return false;
  }

  private shouldBlockAddByDecisionContext(input: StrategyInput): boolean {
    const context = this.getDecisionContext(input);
    if (!context) return false;
    if (context.execution.quality === 'BLOCKED') return true;
    if (context.manipulation.risk === 'HIGH') return true;
    if (context.preferredSetup === 'AUCTION_REVERSION') return true;
    return false;
  }

  private resolveEntrySetupKind(input: StrategyInput, side: StrategySide): EntrySetupKind {
    const context = this.getDecisionContext(input);
    if (!context) return 'TREND_CONTINUATION';
    if (context.preferredSetup === 'BREAKOUT_ACCEPTANCE') {
      if ((side === 'LONG' && context.auction.aboveVah) || (side === 'SHORT' && context.auction.belowVal)) {
        return 'BREAKOUT_ACCEPTANCE';
      }
    }
    if (context.preferredSetup === 'AUCTION_REVERSION') {
      if (
        (side === 'LONG' && context.auction.acceptance === 'REJECTING_LOW')
        || (side === 'SHORT' && context.auction.acceptance === 'REJECTING_HIGH')
      ) {
        return 'AUCTION_REVERSION';
      }
    }
    return 'TREND_CONTINUATION';
  }

  private allowBreakoutAcceptanceEntry(
    input: StrategyInput,
    side: StrategySide,
    dfsP: number,
    thresholds: { longEntry: number; shortEntry: number }
  ): boolean {
    const context = this.getDecisionContext(input);
    if (!context) return false;
    if (context.execution.quality === 'BLOCKED') return false;
    if (!this.allowTrendCarryEntry(input, side, dfsP, thresholds)) return false;
    if (side === 'LONG') {
      return context.auction.aboveVah
        && context.auction.acceptance === 'ACCEPTING_ABOVE'
        && context.edge.netEdgePct > 0
        && context.liquidity.quality !== 'TOXIC';
    }
    return context.auction.belowVal
      && context.auction.acceptance === 'ACCEPTING_BELOW'
      && context.edge.netEdgePct > 0
      && context.liquidity.quality !== 'TOXIC';
  }

  private allowAuctionReversionEntry(
    input: StrategyInput,
    side: StrategySide,
    dfsP: number,
    regime: StrategyRegime,
    thresholds: { longEntry: number; shortEntry: number }
  ): boolean {
    const context = this.getDecisionContext(input);
    if (!context) return false;
    if (context.execution.quality === 'BLOCKED') return false;
    if (!this.allowNeutralBiasContinuation(input, side, dfsP, regime, thresholds) && !this.allowTrendCarryEntry(input, side, dfsP, thresholds)) {
      return false;
    }
    if (side === 'LONG') {
      return context.auction.acceptance === 'REJECTING_LOW'
        && !context.auction.aboveVah
        && Boolean(input.structure?.reclaimUp || input.structure?.continuationLong);
    }
    return context.auction.acceptance === 'REJECTING_HIGH'
      && !context.auction.belowVal
      && Boolean(input.structure?.reclaimDn || input.structure?.continuationShort);
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
    const context = this.getDecisionContext(input);
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    const price = input.market.price;
    const vwap = input.market.vwap;
    const earlySeed = this.isEarlySeedPhase(input);
    const pullbackDistancePct = vwap > 0 ? Math.abs(price - vwap) / vwap : 0;
    const trendState = this.getRuntimeTrendState(input);
    if (input.execution?.orderbookTrusted === false) return false;
    if (context?.execution.quality === 'BLOCKED') return false;
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

  private getEntrySizeMultiplier(input: StrategyInput, setupKind: EntrySetupKind): number {
    if (this.isEarlySeedPhase(input)) {
      return this.getStartupSeedSizeMultiplier();
    }
    if (!this.config.edgeSizingEnabled) return 1;
    const context = this.getDecisionContext(input);
    if (!context) return 1;
    const floor = clamp(Number(this.config.edgeSizeFloorMultiplier || 0.8), 0.1, 1);
    const ceil = clamp(Number(this.config.edgeSizeCeilMultiplier || 1.15), floor, 1.5);
    let multiplier = floor + ((ceil - floor) * context.edge.score);
    if (setupKind === 'BREAKOUT_ACCEPTANCE') multiplier += 0.05;
    if (context.execution.quality === 'DEGRADED') multiplier *= 0.9;
    if (context.manipulation.risk === 'MEDIUM') multiplier *= 0.9;
    const volNorm = this.getVolNormMultiplier(input);
    return clamp(multiplier * volNorm, floor, ceil);
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
    const context = this.getDecisionContext(input);
    if (context?.edge) {
      return context.edge.netEdgePct > 0 && context.edge.expectedMovePct >= (context.edge.estimatedCostPct * 1.35);
    }
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
    if (this.shouldBlockAddByDecisionContext(input)) return null;
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    const timeInPositionMs = Math.max(0, Number(input.position.timeInPositionMs || 0));
    const isWinnerAdd = unrealizedPnlPct > 0;
    if (!isWinnerAdd) return null;
    const side = input.position.side;
    const context = this.getDecisionContext(input);
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
        setupKind: context?.preferredSetup ?? null,
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
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    if (unrealizedPnlPct <= 0) return null; // sadece kârdayken soft reduce

    const context = this.getDecisionContext(input);

    // Manipülasyon/toxic likidite koruması — kârı koru
    if (
      context
      && (context.manipulation.risk === 'HIGH' || context.liquidity.quality === 'TOXIC')
    ) {
      this.lastSoftReduceTs = input.nowMs;
      this.lastSoftReduceSide = side;
      return {
        type: StrategyActionType.REDUCE, side, reason: 'REDUCE_SOFT',
        reducePct: 0.5, expectedPrice: input.market.price,
        metadata: { mode: 'CONTEXT_PROTECT', manipulationRisk: context.manipulation.risk },
      };
    }

    // Yapı kırılımı — akış teyitli
    const structureInvalidation = this.isStructureInvalidated(input, side);
    if (structureInvalidation) {
      const bias15m = this.bias15m(input);
      const veto1h = this.veto1h(input);
      const trendAligned = this.isTrendAligned(side, bias15m, veto1h);
      this.lastSoftReduceTs = input.nowMs;
      this.lastSoftReduceSide = side;
      return {
        type: StrategyActionType.REDUCE, side, reason: 'REDUCE_SOFT',
        reducePct: trendAligned ? 0.35 : 0.5, expectedPrice: input.market.price,
        metadata: { mode: 'STRUCTURE_INVALIDATION', unrealizedPnlPct },
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
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;

    // ═══════════════════════════════════════════════════════════════
    // HARD STOP: Yapısal %1.5 stop — tek katman, kademeli stop yok
    // Swing noktası / VAH-VAL arkasına yerleştirilir.
    // Eğer structure varsa, structure anchor kullanılır.
    // ═══════════════════════════════════════════════════════════════
    const HARD_STOP_PCT = -0.015; // %1.5 yapısal stop
    const structuralStopPct = this.getStructuralStopPct(input, side);
    const stopLossThreshold = structuralStopPct !== null
      ? Math.min(structuralStopPct, HARD_STOP_PCT) // whichever is tighter
      : HARD_STOP_PCT;

    if (unrealizedPnlPct <= stopLossThreshold) {
      return {
        type: StrategyActionType.EXIT,
        side,
        reason: 'EXIT_STOP_LOSS',
        expectedPrice: price,
        metadata: {
          unrealizedPnlPct,
          stopLossThreshold,
          structuralStop: structuralStopPct,
          mode: 'STRUCTURAL_HARD_STOP',
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // FLOW REVERSAL EXIT: Mikro yapı (order flow) tersine döndüğünde çık
    // Bu, partial stop'lar ve breakeven stop'un yerini alır.
    // Kârdayken akış tersine dönerse → pozisyonu kapat
    // ═══════════════════════════════════════════════════════════════
    const flowReversalExit = this.checkFlowReversalExit(input, dfsP, side);
    if (flowReversalExit) {
      return {
        type: StrategyActionType.EXIT,
        side,
        reason: 'EXIT_FLOW_REVERSAL',
        expectedPrice: price,
        metadata: {
          unrealizedPnlPct,
          peakPnlPct: this.getPeakPnlPct(input),
          dfsP,
          cvdSlope: input.market.cvdSlope,
          obiWeighted: input.market.obiWeighted,
          mode: 'FLOW_REVERSAL',
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // SEVERE OPPOSITE PRESSURE: Extreme karşı akış → acil çıkış
    // ═══════════════════════════════════════════════════════════════
    if (this.hasSevereOppositePressure(input, dfsP, thresholds)) {
      const confirmedTrendExit = this.hasConfirmedTrendExitContext(input, side);
      const bias15m = this.bias15m(input);
      const veto1h = this.veto1h(input);
      const trendAligned = this.isTrendAligned(side, bias15m, veto1h);
      if (confirmedTrendExit || !trendAligned || unrealizedPnlPct <= 0) {
        return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price,
          metadata: { mode: 'SEVERE_PRESSURE', unrealizedPnlPct } };
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CONTEXT BLOCKED: Execution blocked by manipulation/liquidity
    // ═══════════════════════════════════════════════════════════════
    const context = this.getDecisionContext(input);
    if (
      context
      && context.execution.quality === 'BLOCKED'
      && (context.manipulation.risk === 'HIGH' || unrealizedPnlPct <= 0)
    ) {
      return {
        type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price,
        metadata: { mode: 'CONTEXT_BLOCKED', blockedReasons: context.execution.blockedReasons },
      };
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
    if (this.isTrendCarryHoldLocked(input, side) !== 'UNLOCKED' || !this.hasConfirmedTrendReversalContext(input, side)) {
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

  private isAuctionReversionAgainstPosition(input: StrategyInput, side: StrategySide): boolean {
    const context = this.getDecisionContext(input);
    if (!context) return false;
    if (side === 'LONG') {
      return context.auction.acceptance === 'REJECTING_HIGH';
    }
    return context.auction.acceptance === 'REJECTING_LOW';
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

  private getOrResetScaleOutState(symbol: string, entryPrice: number) {
    const key = `${symbol}:${entryPrice.toFixed(8)}`;
    let state = this.scaleOutState.get(key);
    if (!state || state.entryPrice !== entryPrice) {
      // New position opened — reset all partial stop flags
      state = { stop1Used: false, stop2Used: false, breakevenArmed: false, entryPrice };
      // Clean up stale keys for the same symbol
      for (const k of this.scaleOutState.keys()) {
        if (k.startsWith(`${symbol}:`)) this.scaleOutState.delete(k);
      }
      this.scaleOutState.set(key, state);
    }
    return state;
  }

  private getDynamicStopLossPct(input: StrategyInput): number {
    const base = Number.isFinite(this.config.maxLossPct as number)
      ? Math.min(-0.0001, Number(this.config.maxLossPct))
      : -0.02;
    const price = Number(input.market.price || 0);
    const atr = Number(input.volatility || 0);
    if (price <= 0 || atr <= 0) return base;
    const atrPct = atr / price;
    const multiplier = Number.isFinite(Number(this.config.atrStopMultiplier)) && Number(this.config.atrStopMultiplier) > 0
      ? Number(this.config.atrStopMultiplier)
      : 1.5;
    const atrMin = Number.isFinite(Number(this.config.atrStopMin)) && Number(this.config.atrStopMin) > 0
      ? Number(this.config.atrStopMin)
      : 0.008;
    const atrMax = Number.isFinite(Number(this.config.atrStopMax)) && Number(this.config.atrStopMax) > 0
      ? Number(this.config.atrStopMax)
      : 0.020;
    return -(clamp(atrPct * multiplier, atrMin, atrMax));
  }

  private getVolAdjustedGivebackPct(base: number, input: StrategyInput): number {
    const price = Number(input.market.price || 0);
    const atr = Number(input.volatility || 0);
    if (price <= 0 || atr <= 0) return base;
    const atrPct = atr / price;
    // Reference: 0.5% ATR per bar = normal crypto volatility
    // Below 0.5%: tighter giveback; above 0.5%: wider giveback
    const REF_ATR_PCT = 0.005;
    return base * clamp(atrPct / REF_ATR_PCT, 0.5, 2.5);
  }

  private getVolNormMultiplier(input: StrategyInput): number {
    const price = Number(input.market.price || 0);
    const atr = Number(input.volatility || 0);
    if (price <= 0 || atr <= 0) return 1.0;
    const atrPct = atr / price;
    const target = Number.isFinite(Number(this.config.targetVolPct)) && Number(this.config.targetVolPct) > 0
      ? Number(this.config.targetVolPct)
      : 0.003;
    return clamp(target / atrPct, 0.5, 1.5);
  }

  // ═══════════════════════════════════════════════════════════════
  // DFS Rolling Window — Peak/Trough tracking for new setups
  // ═══════════════════════════════════════════════════════════════

  private updateDfsRollingWindow(nowMs: number, dfsP: number): void {
    this.dfsRollingWindow.push({ ts: nowMs, dfsP });
    // Trim old entries beyond lookback window
    const cutoff = nowMs - this.DFS_ROLLING_WINDOW_MS;
    while (this.dfsRollingWindow.length > 0 && this.dfsRollingWindow[0].ts < cutoff) {
      this.dfsRollingWindow.shift();
    }

    // Arm exhaustion fade: DFS peak >= 0.90
    if (dfsP >= 0.90) {
      this.exhaustionFadeArmed = true;
      this.exhaustionFadeArmTs = nowMs;
    }
    // Arm trend pullback: DFS trough <= 0.10
    if (dfsP <= 0.10) {
      this.trendPullbackArmed = true;
      this.trendPullbackArmTs = nowMs;
    }

    // Expire armed states after 60s
    if (this.exhaustionFadeArmed && (nowMs - this.exhaustionFadeArmTs > this.SETUP_ARM_EXPIRY_MS)) {
      this.exhaustionFadeArmed = false;
    }
    if (this.trendPullbackArmed && (nowMs - this.trendPullbackArmTs > this.SETUP_ARM_EXPIRY_MS)) {
      this.trendPullbackArmed = false;
    }
  }

  private getDfsPeakInWindow(): number {
    if (this.dfsRollingWindow.length === 0) return 0.5;
    let peak = 0;
    for (const s of this.dfsRollingWindow) {
      if (s.dfsP > peak) peak = s.dfsP;
    }
    return peak;
  }

  private getDfsTroughInWindow(): number {
    if (this.dfsRollingWindow.length === 0) return 0.5;
    let trough = 1;
    for (const s of this.dfsRollingWindow) {
      if (s.dfsP < trough) trough = s.dfsP;
    }
    return trough;
  }

  // ═══════════════════════════════════════════════════════════════
  // SETUP 1: Exhaustion Fade — Momentum tükenmesi ve ters dönüş
  // MR rejiminde: fiyat VAH kırılır, DFS 0.90'a ulaşır, sonra düşer
  // ═══════════════════════════════════════════════════════════════

  /**
   * SHORT Exhaustion Fade:
   * - DFS peak >= 0.90 in window (armed)
   * - Trigger: DFS dropped < 0.70 (momentum broken)
   * - CVD Slope < 0 (sellers stepping in via limits)
   * - OBI Deep < -0.20 (institutional sell walls in deep book)
   * - Price > VAH (outside value area to the upside)
   */
  private checkExhaustionFadeShort(
    input: StrategyInput,
    dfsP: number,
    context: StrategyDecisionContext | null,
  ): boolean {
    if (!this.exhaustionFadeArmed) return false;
    // Trigger: DFS must have dropped from peak
    if (dfsP >= 0.70) return false;

    // Absorption confirmation
    if (input.market.cvdSlope >= 0) return false;
    if (input.market.obiDeep >= -0.20) return false;

    // Price must be above VAH (outside value area)
    if (context?.auction.aboveVah === true) return true;

    // Fallback: price > VWAP (elevated)
    const price = input.market.price;
    const vwap = input.market.vwap;
    return vwap > 0 && price > vwap * 1.002;
  }

  /**
   * LONG Exhaustion Fade (mirror):
   * - DFS trough <= 0.10 in window (armed via trendPullbackArmed reused)
   * - Trigger: DFS risen > 0.30 (selling exhausted)
   * - CVD Slope > 0 (buyers stepping in)
   * - OBI Deep > 0.20 (institutional buy walls)
   * - Price < VAL (outside value area to the downside)
   */
  private checkExhaustionFadeLong(
    input: StrategyInput,
    dfsP: number,
    context: StrategyDecisionContext | null,
  ): boolean {
    if (!this.trendPullbackArmed) return false;
    if (dfsP <= 0.30) return false;

    if (input.market.cvdSlope <= 0) return false;
    if (input.market.obiDeep <= 0.20) return false;

    if (context?.auction.belowVal === true) return true;
    const price = input.market.price;
    const vwap = input.market.vwap;
    return vwap > 0 && price < vwap * 0.998;
  }

  // ═══════════════════════════════════════════════════════════════
  // SETUP 2: Trend Pullback & Reload — Trend içi yeniden yükleme
  // TR rejiminde: trend yukarıdır, fiyat VWAP/VAL'a çekilir,
  // panik satışı durur, alıcılar kontrolü ele alır
  // ═══════════════════════════════════════════════════════════════

  /**
   * LONG Trend Pullback:
   * - Trend UP (1h bias UP)
   * - Price near VWAP or near VAL
   * - DFS dipped <= 0.10 (panic selling)
   * - Trigger: DeltaZ > 0 AND DFS > 0.30 (selling stopped, buyers returning)
   * - OBI Weighted > 0.15 (orderbook buy pressure)
   */
  private checkTrendPullbackLong(
    input: StrategyInput,
    dfsP: number,
    context: StrategyDecisionContext | null,
  ): boolean {
    if (!this.trendPullbackArmed) return false;

    // Trigger: DFS recovered above 0.30 and deltaZ positive (buyers back)
    if (dfsP <= 0.30) return false;
    if (input.market.deltaZ <= 0) return false;

    // Filter: orderbook buy pressure
    if (input.market.obiWeighted <= 0.15) return false;

    // Price must be near VWAP or VAL
    const price = input.market.price;
    const vwap = input.market.vwap;
    const nearVwap = vwap > 0 && Math.abs(price - vwap) / vwap < 0.005;
    const nearVal = context?.auction.belowVal === true || (context?.auction.inValue === true);
    return nearVwap || nearVal;
  }

  /**
   * SHORT Trend Pullback (mirror):
   * - Trend DOWN
   * - Price near VWAP or near VAH
   * - DFS spiked >= 0.90 (FOMO buying)
   * - Trigger: DeltaZ < 0 AND DFS < 0.70 (buying stopped, sellers returning)
   * - OBI Weighted < -0.15 (orderbook sell pressure)
   */
  private checkTrendPullbackShort(
    input: StrategyInput,
    dfsP: number,
    context: StrategyDecisionContext | null,
  ): boolean {
    if (!this.exhaustionFadeArmed) return false;

    if (dfsP >= 0.70) return false;
    if (input.market.deltaZ >= 0) return false;
    if (input.market.obiWeighted >= -0.15) return false;

    const price = input.market.price;
    const vwap = input.market.vwap;
    const nearVwap = vwap > 0 && Math.abs(price - vwap) / vwap < 0.005;
    const nearVah = context?.auction.aboveVah === true || (context?.auction.inValue === true);
    return nearVwap || nearVah;
  }

  // ═══════════════════════════════════════════════════════════════
  // FLOW REVERSAL EXIT — Order flow tersine döndüğünde çık
  // Partial stop ve breakeven stop yerine: akış bazlı çıkış
  // ═══════════════════════════════════════════════════════════════

  /**
   * Flow Reversal: akış tersine döndü mü?
   * LONG pozisyonda: CVD Slope negatif, DFS düşüyor, OBI satış ağırlıklı
   * SHORT pozisyonda: CVD Slope pozitif, DFS yükseliyor, OBI alım ağırlıklı
   *
   * Sadece kârdayken veya çok uzun süredir tutulmuş pozisyonlarda tetiklenir.
   */
  private checkFlowReversalExit(
    input: StrategyInput,
    dfsP: number,
    side: StrategySide,
  ): boolean {
    if (!input.position) return false;
    const unrealizedPnlPct = input.position.unrealizedPnlPct ?? 0;
    const peakPnlPct = this.getPeakPnlPct(input);
    const positionAgeMs = this.getPositionAgeMs(input) ?? 0;

    // Only fire if we're in profit (protecting gains) OR position is very old (>20 min)
    const inProfit = unrealizedPnlPct > 0.002; // at least 0.2% profit
    const isAged = positionAgeMs >= 20 * 60_000;
    if (!inProfit && !isAged) return false;

    // Require meaningful peak first (at least 0.3% was achieved)
    if (peakPnlPct < 0.003) return false;

    // Check flow reversal conditions
    if (side === 'LONG') {
      // For LONG: sellers taking over
      return (
        input.market.cvdSlope < -0.3
        && dfsP < 0.35
        && input.market.obiWeighted < -0.10
        && input.market.deltaZ < -0.5
      );
    }

    // For SHORT: buyers taking over
    return (
      input.market.cvdSlope > 0.3
      && dfsP > 0.65
      && input.market.obiWeighted > 0.10
      && input.market.deltaZ > 0.5
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // STRUCTURAL STOP — VAH/VAL/Swing noktası arkasında %1.5 stop
  // ═══════════════════════════════════════════════════════════════

  private getStructuralStopPct(input: StrategyInput, side: StrategySide): number | null {
    const entryPrice = input.position?.entryPrice ?? 0;
    if (entryPrice <= 0) return null;
    const price = input.market.price;

    // Try structure anchor first (swing points)
    const structure = this.getStructure(input);
    if (structure) {
      if (side === 'LONG' && structure.anchors.longStopAnchor != null) {
        const stopDist = (entryPrice - structure.anchors.longStopAnchor) / entryPrice;
        return -(stopDist + 0.002); // add 0.2% buffer beyond swing low
      }
      if (side === 'SHORT' && structure.anchors.shortStopAnchor != null) {
        const stopDist = (structure.anchors.shortStopAnchor - entryPrice) / entryPrice;
        return -(stopDist + 0.002);
      }
    }

    // Try VAH/VAL from auction context
    const context = this.getDecisionContext(input);
    if (context?.auction.profile) {
      const vah = context.auction.profile.vah;
      const val = context.auction.profile.val;
      if (side === 'LONG' && val != null && val > 0) {
        const stopDist = (entryPrice - val) / entryPrice;
        if (stopDist > 0) return -(stopDist + 0.002);
      }
      if (side === 'SHORT' && vah != null && vah > 0) {
        const stopDist = (vah - entryPrice) / entryPrice;
        if (stopDist > 0) return -(stopDist + 0.002);
      }
    }

    return null; // no structural reference → fall through to default 1.5%
  }

  // CVD 4-Quadrant framework — detects absorpsiyon (pasif emilim) vs tükenme (exhaustion)
  // Returns:
  //   PASSIVE_BUY_ABSORPTION  → sellers active but buyers absorbing → bullish reversal setup
  //   PASSIVE_SELL_ABSORPTION → buyers active but sellers absorbing → bearish reversal setup
  //   BUY_EXHAUSTION          → price high but buying momentum fading → LONG veto
  //   SELL_EXHAUSTION         → price low but selling momentum fading → SHORT veto
  //   NEUTRAL                 → no strong divergence
  private detectCVDQuadrant(
    input: StrategyInput
  ): 'PASSIVE_BUY_ABSORPTION' | 'PASSIVE_SELL_ABSORPTION' | 'BUY_EXHAUSTION' | 'SELL_EXHAUSTION' | 'NEUTRAL' {
    const cvdSlope = input.market.cvdSlope ?? 0;
    const deltaZ = input.market.deltaZ ?? 0;
    const price = input.market.price;
    const vwap = input.market.vwap;
    if (!(price > 0) || !(vwap > 0)) return 'NEUTRAL';

    const priceAboveVwap = price > vwap;
    const priceBelowVwap = price < vwap;

    // Strong CVD signal thresholds
    const ABS_THRESHOLD = 0.5;    // High conviction — sellers/buyers very active
    const EXHAUS_THRESHOLD = 0.25; // Moderate — momentum fading

    // PASSIVE BUY ABSORPTION:
    // Price is depressed (below VWAP) AND CVD slope is strongly negative (lots of selling)
    // BUT instantaneous delta (deltaZ) is positive → buyers stepping in, absorbing sellers
    // → Bullish reversal: sellers running out of steam against institutional buyers
    if (priceBelowVwap && cvdSlope < -ABS_THRESHOLD && deltaZ > 0) {
      return 'PASSIVE_BUY_ABSORPTION';
    }

    // PASSIVE SELL ABSORPTION:
    // Price is elevated (above VWAP) AND CVD slope is strongly positive (lots of buying)
    // BUT instantaneous delta (deltaZ) is negative → sellers absorbing buyers at resistance
    // → Bearish reversal: buyers running out of steam against institutional sellers
    if (priceAboveVwap && cvdSlope > ABS_THRESHOLD && deltaZ < 0) {
      return 'PASSIVE_SELL_ABSORPTION';
    }

    // BUY EXHAUSTION:
    // Price at highs (above VWAP) but CVD slope turning negative with negative deltaZ
    // → Buying pressure fading at top → LONG veto, potential short setup
    if (priceAboveVwap && cvdSlope < -EXHAUS_THRESHOLD && deltaZ < -0.3) {
      return 'BUY_EXHAUSTION';
    }

    // SELL EXHAUSTION:
    // Price at lows (below VWAP) but CVD slope turning positive with positive deltaZ
    // → Selling pressure fading at bottom → SHORT veto, potential long setup
    if (priceBelowVwap && cvdSlope > EXHAUS_THRESHOLD && deltaZ > 0.3) {
      return 'SELL_EXHAUSTION';
    }

    return 'NEUTRAL';
  }

  private isTrendCarryEarlyStructureBreaking(input: StrategyInput, side: StrategySide): boolean {
    const ageMs = this.getPositionAgeMs(input);
    if (ageMs === null) return false;
    if (ageMs < 3 * 60_000) return false;
    if (ageMs >= this.getTrendCarryMinHoldMs()) return false;
    if (!this.isAlignedTrendState(side, this.getRuntimeTrendState(input))) return false;
    if (this.isStructureInvalidated(input, side)) return true;
    const bias15m = this.bias15m(input);
    const veto1h = this.veto1h(input);
    return this.isHtfOpposing(side, bias15m, veto1h);
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

  private isTrendCarryHoldLocked(input: StrategyInput, side: StrategySide): 'LOCKED' | 'SOFT_REDUCE_ONLY' | 'UNLOCKED' {
    const ageMs = this.getPositionAgeMs(input);
    if (ageMs === null) return 'UNLOCKED';
    if (ageMs >= this.getTrendCarryMinHoldMs()) return 'UNLOCKED';
    if (!this.isAlignedTrendState(side, this.getRuntimeTrendState(input))) return 'UNLOCKED';
    // After 3 min, if structure is already breaking, allow soft reduce only (not full lock)
    if (this.isTrendCarryEarlyStructureBreaking(input, side)) return 'SOFT_REDUCE_ONLY';
    return 'LOCKED';
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
        contextExecutionConfidence: input.decisionContext?.execution.confidence ?? null,
        contextEdgeScore: input.decisionContext?.edge.score ?? null,
        contextSpoofScore: input.decisionContext?.manipulation.spoofScore ?? null,
        contextSlippageBps: input.decisionContext?.liquidity.expectedSlippageBps ?? null,
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
      decisionContext: input.decisionContext
        ? {
            updatedAtMs: input.decisionContext.updatedAtMs,
            trend: {
              bias15m: input.decisionContext.trend.bias15m,
              trendState: input.decisionContext.trend.trendState,
              trendinessScore: input.decisionContext.trend.trendinessScore,
              chopScore: input.decisionContext.trend.chopScore,
              confidence: input.decisionContext.trend.confidence,
            },
            liquidity: {
              quality: input.decisionContext.liquidity.quality,
              score: input.decisionContext.liquidity.score,
              expectedSlippageBps: input.decisionContext.liquidity.expectedSlippageBps,
              effectiveSpreadBps: input.decisionContext.liquidity.effectiveSpreadBps,
              voidGapScore: input.decisionContext.liquidity.voidGapScore,
              wallScore: input.decisionContext.liquidity.wallScore,
            },
            manipulation: {
              risk: input.decisionContext.manipulation.risk,
              spoofScore: input.decisionContext.manipulation.spoofScore,
              vpinApprox: input.decisionContext.manipulation.vpinApprox,
              burstPersistenceScore: input.decisionContext.manipulation.burstPersistenceScore,
              blocked: input.decisionContext.manipulation.blocked,
              reasons: [...input.decisionContext.manipulation.reasons],
            },
            auction: {
              profile: input.decisionContext.auction.profile
                ? {
                    sessionName: input.decisionContext.auction.profile.sessionName,
                    sessionStartMs: input.decisionContext.auction.profile.sessionStartMs,
                    bucketSize: input.decisionContext.auction.profile.bucketSize,
                    poc: input.decisionContext.auction.profile.poc,
                    vah: input.decisionContext.auction.profile.vah,
                    val: input.decisionContext.auction.profile.val,
                    location: input.decisionContext.auction.profile.location,
                    acceptance: input.decisionContext.auction.profile.acceptance,
                    distanceToPocBps: input.decisionContext.auction.profile.distanceToPocBps,
                    distanceToValueEdgeBps: input.decisionContext.auction.profile.distanceToValueEdgeBps,
                    totalVolume: input.decisionContext.auction.profile.totalVolume,
                  }
                : null,
              location: input.decisionContext.auction.location,
              acceptance: input.decisionContext.auction.acceptance,
              inValue: input.decisionContext.auction.inValue,
              aboveVah: input.decisionContext.auction.aboveVah,
              belowVal: input.decisionContext.auction.belowVal,
              distanceToPocBps: input.decisionContext.auction.distanceToPocBps,
              distanceToValueEdgeBps: input.decisionContext.auction.distanceToValueEdgeBps,
            },
            edge: {
              expectedMovePct: input.decisionContext.edge.expectedMovePct,
              estimatedCostPct: input.decisionContext.edge.estimatedCostPct,
              netEdgePct: input.decisionContext.edge.netEdgePct,
              score: input.decisionContext.edge.score,
            },
            execution: {
              quality: input.decisionContext.execution.quality,
              blockedReasons: [...input.decisionContext.execution.blockedReasons],
              confidence: input.decisionContext.execution.confidence,
            },
            preferredSetup: input.decisionContext.preferredSetup,
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
