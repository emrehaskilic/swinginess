import type { StructureSnapshot } from '../structure/types';

export const StrategyRegime = {
  EV: 'EV',
  TR: 'TR',
  MR: 'MR',
} as const;

export type StrategyRegime = typeof StrategyRegime[keyof typeof StrategyRegime];

export const StrategySide = {
  LONG: 'LONG',
  SHORT: 'SHORT',
} as const;

export type StrategySide = typeof StrategySide[keyof typeof StrategySide];

export const StrategyActionType = {
  NOOP: 'NOOP',
  ENTRY: 'ENTRY',
  ADD: 'ADD',
  REDUCE: 'REDUCE',
  EXIT: 'EXIT',
} as const;

export type StrategyActionType = typeof StrategyActionType[keyof typeof StrategyActionType];

export type DecisionReason =
  | 'GATE_PAUSED'
  | 'GATE_SOURCE_NOT_REAL'
  | 'GATE_STALE_TRADES'
  | 'GATE_STALE_ORDERBOOK'
  | 'GATE_LOW_PRINTS'
  | 'GATE_WIDE_SPREAD'
  | 'REGIME_LOCKED'
  | 'REGIME_EV_OVERRIDE'
  | 'REGIME_TRMR_LOCK'
  | 'ENTRY_TR'
  | 'ENTRY_MR'
  | 'ENTRY_EV'
  | 'ENTRY_BLOCKED_COOLDOWN'
  | 'ENTRY_BLOCKED_MHT'
  | 'ENTRY_BLOCKED_GATE'
  | 'ENTRY_BLOCKED_STRUCTURE'
  | 'ENTRY_BLOCKED_FILTERS'
  | 'ADD_WINNER'
  | 'ADD_BLOCKED_STRUCTURE'
  | 'STRAT_ADD'
  | 'ADD_BLOCKED'
  | 'REDUCE_SOFT'
  | 'REDUCE_EXHAUSTION'
  | 'REDUCE_PARTIAL_STOP_1'
  | 'REDUCE_PARTIAL_STOP_2'
  | 'REDUCE_TIME_FLAT'
  | 'EXIT_HARD'
  | 'EXIT_STOP_LOSS'
  | 'EXIT_BREAKEVEN_STOP'
  | 'EXIT_HARD_REVERSAL'
  | 'HARD_REVERSAL_ENTRY'
  | 'HARD_REVERSAL_REJECTED'
  | 'NO_SIGNAL'
  | 'NOOP';

export interface StrategyAction {
  type: StrategyActionType;
  side?: StrategySide;
  reason: DecisionReason;
  expectedPrice?: number | null;
  sizeMultiplier?: number;
  reducePct?: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyDecisionLog {
  timestampMs: number;
  symbol: string;
  regime: StrategyRegime;
  gate: {
    passed: boolean;
    reason: DecisionReason | null;
    details: Record<string, unknown>;
  };
  dfs: number;
  dfsPercentile: number;
  volLevel: number;
  thresholds: {
    longEntry: number;
    longBreak: number;
    shortEntry: number;
    shortBreak: number;
  };
  reasons: DecisionReason[];
  actions: StrategyAction[];
  stats: Record<string, number | null>;
  replayInput?: StrategyInput;
}

export interface StrategyDecision {
  symbol: string;
  timestampMs: number;
  regime: StrategyRegime;
  dfs: number;
  dfsPercentile: number;
  volLevel: number;
  gatePassed: boolean;
  actions: StrategyAction[];
  reasons: DecisionReason[];
  log: StrategyDecisionLog;
}

export interface StrategyPositionState {
  side: StrategySide;
  qty: number;
  entryPrice: number;
  unrealizedPnlPct: number;
  addsUsed: number;
  sizePct?: number;
  timeInPositionMs?: number;
  peakPnlPct?: number;
  /** DFS percentile at position entry — used for alpha decay exit tracking */
  entryDfsP?: number | null;
}

export type StrategyTrendState = 'UPTREND' | 'DOWNTREND' | 'PULLBACK_UP' | 'PULLBACK_DOWN' | 'RANGE';
export type StrategyStartupMode = 'EARLY_SEED_THEN_MICRO' | 'WAIT_MICRO_WARMUP';
export type AuctionLocation = 'ABOVE_VAH' | 'IN_VALUE' | 'BELOW_VAL' | 'UNKNOWN';
export type AuctionAcceptance =
  | 'ACCEPTING_ABOVE'
  | 'ACCEPTING_VALUE'
  | 'ACCEPTING_BELOW'
  | 'REJECTING_HIGH'
  | 'REJECTING_LOW'
  | 'NEUTRAL';
export type LiquidityQuality = 'GOOD' | 'THIN' | 'TOXIC' | 'BLOCKED';
export type ManipulationRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ExecutionQualityLevel = 'GOOD' | 'DEGRADED' | 'BLOCKED';
export type EntrySetupKind = 'TREND_CONTINUATION' | 'BREAKOUT_ACCEPTANCE' | 'AUCTION_REVERSION';

export interface SessionProfileSnapshot {
  sessionName: 'asia' | 'london' | 'ny';
  sessionStartMs: number;
  bucketSize: number;
  poc: number | null;
  vah: number | null;
  val: number | null;
  location: AuctionLocation;
  acceptance: AuctionAcceptance;
  distanceToPocBps: number | null;
  distanceToValueEdgeBps: number | null;
  totalVolume: number;
}

export interface TrendDecisionContext {
  bias15m: 'UP' | 'DOWN' | 'NEUTRAL';
  trendState: StrategyTrendState | null;
  trendinessScore: number;
  chopScore: number;
  confidence: number;
}

export interface LiquidityDecisionContext {
  quality: LiquidityQuality;
  score: number;
  expectedSlippageBps: number;
  effectiveSpreadBps: number;
  voidGapScore: number;
  wallScore: number;
}

export interface ManipulationDecisionContext {
  risk: ManipulationRiskLevel;
  spoofScore: number;
  vpinApprox: number;
  burstPersistenceScore: number;
  blocked: boolean;
  reasons: string[];
}

export interface AuctionDecisionContext {
  profile: SessionProfileSnapshot | null;
  location: AuctionLocation;
  acceptance: AuctionAcceptance;
  inValue: boolean;
  aboveVah: boolean;
  belowVal: boolean;
  distanceToPocBps: number | null;
  distanceToValueEdgeBps: number | null;
}

export interface EdgeDecisionContext {
  expectedMovePct: number;
  estimatedCostPct: number;
  netEdgePct: number;
  score: number;
}

export interface ExecutionDecisionContext {
  quality: ExecutionQualityLevel;
  blockedReasons: string[];
  confidence: number;
}

export interface AdaptiveThresholdDecisionContext {
  ready: boolean;
  sampleCount: number;
  spoofScoreThreshold: number;
  vpinThreshold: number;
  expectedSlippageBpsThreshold: number;
  spoofScorePercentile: number | null;
  vpinPercentile: number | null;
  expectedSlippageBpsPercentile: number | null;
}

export interface StrategyDecisionContext {
  updatedAtMs: number;
  trend: TrendDecisionContext;
  liquidity: LiquidityDecisionContext;
  manipulation: ManipulationDecisionContext;
  auction: AuctionDecisionContext;
  edge: EdgeDecisionContext;
  execution: ExecutionDecisionContext;
  adaptive?: AdaptiveThresholdDecisionContext | null;
  preferredSetup: EntrySetupKind | null;
}

export interface StrategyInput {
  symbol: string;
  nowMs: number;
  source: 'real' | 'mock' | 'synthetic' | 'unknown';
  orderbook: {
    lastUpdatedMs: number;
    spreadPct?: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
  };
  trades: {
    lastUpdatedMs: number;
    printsPerSecond: number;
    tradeCount: number;
    aggressiveBuyVolume: number;
    aggressiveSellVolume: number;
    consecutiveBurst: { side: 'buy' | 'sell' | null; count: number };
  };
  market: {
    price: number;
    vwap: number;
    delta1s: number;
    delta5s: number;
    deltaZ: number;
    cvdSlope: number;
    obiWeighted: number;
    obiDeep: number;
    obiDivergence: number;
  };
  funding?: {
    rate: number | null;
    timeToFundingMs: number | null;
  } | null;
  openInterest?: {
    oiChangePct: number;
    lastUpdatedMs: number;
    source: 'real' | 'mock' | 'unknown';
  } | null;
  absorption?: {
    value: number; // 0 or 1
    side: 'buy' | 'sell' | null;
  } | null;
  bootstrap?: {
    backfillDone: boolean;
    barsLoaded1m: number;
  } | null;
  htf?: {
    m15?: {
      close: number | null;
      atr: number | null;
      lastSwingHigh: number | null;
      lastSwingLow: number | null;
      structureBreakUp: boolean;
      structureBreakDn: boolean;
    } | null;
    h1?: {
      close: number | null;
      atr: number | null;
      lastSwingHigh: number | null;
      lastSwingLow: number | null;
      structureBreakUp: boolean;
      structureBreakDn: boolean;
    } | null;
  } | null;
  structure?: StructureSnapshot | null;
  decisionContext?: StrategyDecisionContext | null;
  execution?: {
    startupMode?: StrategyStartupMode | null;
    seedReady?: boolean;
    tradeReady: boolean;
    addonReady: boolean;
    vetoReason: string | null;
    orderbookTrusted?: boolean;
    integrityLevel?: 'OK' | 'DEGRADED' | 'CRITICAL' | null;
    trendState?: StrategyTrendState | null;
    trendConfidence?: number | null;
    bias15m?: 'UP' | 'DOWN' | 'NEUTRAL' | null;
    veto1h?: 'NONE' | 'UP' | 'DOWN' | 'EXHAUSTION' | null;
  } | null;
  volatility: number;
  position: StrategyPositionState | null;
}

// Compatibility signal interface for dry-run engines.
export interface StrategySignal {
  signal: string | null;
  score: number;
  vetoReason: string | null;
  candidate: {
    entryPrice: number;
    tpPrice?: number;
    slPrice?: number;
  } | null;
  boost?: {
    score: number;
    contributions: Record<string, number>;
    timeframeMultipliers: Record<string, number>;
  };
  orderflow?: {
    obiWeighted?: number | null;
    obiDeep?: number | null;
    deltaZ?: number | null;
    cvdSlope?: number | null;
  };
  market?: {
    price?: number | null;
    atr?: number | null;
    avgAtr?: number | null;
    recentHigh?: number | null;
    recentLow?: number | null;
  };
}

export interface StrategyConfig {
  decisionTickMs: number;
  rollingWindowMin: number;
  regimeLockTRMRTicks: number;
  regimeLockEVTicks: number;
  volHighP: number;
  volLowP: number;
  dfsEntryLongBase: number;
  dfsBreakLongBase: number;
  dfsEntryShortBase: number;
  dfsBreakShortBase: number;
  mhtTRs: number;
  mhtMRs: number;
  mhtEVs: number;
  cooldownSameS: number;
  cooldownFlipS: number;
  hardRevTicks: number;
  hardRevDfsP: number;
  hardRevRequireAbsorption: boolean;
  defensiveAddEnabled: boolean;
  dryRun: boolean;
  addSizing: number[];
  maxLossPct?: number;
  maxPositionSizePct?: number;
  hardRevSizeMultiplier?: number;
  mrRequireAbsorption?: boolean;
  softReduceRequireProfit?: boolean;
  freshSoftReduceProtectS?: number;
  softReduceCooldownS?: number;
  freshExitProtectS?: number;
  freshReversalProtectS?: number;
  freshExitOverrideLossPct?: number;
  trendCarryReduceMinPeakPnlPct?: number;
  trendCarryReduceGivebackPct?: number;
  trendCarryHardExitMinPeakPnlPct?: number;
  trendCarryHardExitGivebackPct?: number;
  startupSeedSizeMultiplier?: number;
  trendCarryMinHoldBars?: number;
  trendExitConfirmBars?: number;
  trendReversalConfirmBars?: number;
  structureEnabled: boolean;
  structureStaleMs: number;
  swingLookback: number;
  zoneLookback: number;
  bosMinAtr: number;
  reclaimTolerancePct: number;
  winnerAddRequireStructure: boolean;
  structureTrailEnabled: boolean;
  structureEntryRequireFreshness: boolean;
  contextEntryVetoEnabled: boolean;
  maxSpoofScoreForEntry: number;
  maxExpectedSlippageBpsForEntry: number;
  maxVpinForEntry: number;
  edgeSizingEnabled: boolean;
  edgeSizeFloorMultiplier: number;
  edgeSizeCeilMultiplier: number;
  atrStopMultiplier?: number;
  atrStopMin?: number;
  atrStopMax?: number;
  targetVolPct?: number;
}

export const defaultStrategyConfig: StrategyConfig = {
  decisionTickMs: Number(process.env.DECISION_TICK_MS || 1000),
  rollingWindowMin: Number(process.env.ROLLING_WINDOW_MIN || 60),
  regimeLockTRMRTicks: Number(process.env.REGIME_LOCK_TRMR_TICKS || 20),
  regimeLockEVTicks: Number(process.env.REGIME_LOCK_EV_TICKS || 5),
  volHighP: Number(process.env.VOL_HIGH_P || 0.8),
  volLowP: Number(process.env.VOL_LOW_P || 0.2),
  dfsEntryLongBase: Number(process.env.DFS_ENTRY_LONG_BASE || 0.9),
  dfsBreakLongBase: Number(process.env.DFS_BREAK_LONG_BASE || 0.6),
  dfsEntryShortBase: Number(process.env.DFS_ENTRY_SHORT_BASE || 0.1),
  dfsBreakShortBase: Number(process.env.DFS_BREAK_SHORT_BASE || 0.4),
  mhtTRs: Number(process.env.MHT_TR_S || 180),
  mhtMRs: Number(process.env.MHT_MR_S || 90),
  mhtEVs: Number(process.env.MHT_EV_S || 15),
  cooldownSameS: Number(process.env.COOLDOWN_SAME_S || 45),
  cooldownFlipS: Number(process.env.COOLDOWN_FLIP_S || 180),
  hardRevTicks: Number(process.env.HARDREV_TICKS || 10),
  hardRevDfsP: Number(process.env.HARDREV_DFS_P || 0.08),
  hardRevRequireAbsorption: String(process.env.HARDREV_REQUIRE_ABSORPTION || 'true').toLowerCase() === 'true',
  defensiveAddEnabled: String(process.env.DEFENSIVE_ADD_ENABLED || 'false').toLowerCase() === 'true',
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
  addSizing: [1.0, 0.6, 0.4],
  maxLossPct: Number(process.env.STRATEGY_MAX_LOSS_PCT || -0.012),
  hardRevSizeMultiplier: Number(process.env.HARDREV_SIZE_MULTIPLIER || 0.5),
  mrRequireAbsorption: String(process.env.MR_REQUIRE_ABSORPTION || 'true').toLowerCase() === 'true',
  softReduceRequireProfit: String(process.env.SOFT_REDUCE_REQUIRE_PROFIT || 'true').toLowerCase() === 'true',
  freshSoftReduceProtectS: Number(process.env.FRESH_SOFT_REDUCE_PROTECT_S || 180),
  softReduceCooldownS: Number(process.env.SOFT_REDUCE_COOLDOWN_S || 180),
  freshExitProtectS: Number(process.env.FRESH_EXIT_PROTECT_S || 90),
  freshReversalProtectS: Number(process.env.FRESH_REVERSAL_PROTECT_S || 180),
  freshExitOverrideLossPct: Number(process.env.FRESH_EXIT_OVERRIDE_LOSS_PCT || -0.004),
  trendCarryReduceMinPeakPnlPct: Number(process.env.TREND_CARRY_REDUCE_MIN_PEAK_PNL_PCT || 0.006),
  trendCarryReduceGivebackPct: Number(process.env.TREND_CARRY_REDUCE_GIVEBACK_PCT || 0.003),
  trendCarryHardExitMinPeakPnlPct: Number(process.env.TREND_CARRY_HARD_EXIT_MIN_PEAK_PNL_PCT || 0.009),
  trendCarryHardExitGivebackPct: Number(process.env.TREND_CARRY_HARD_EXIT_GIVEBACK_PCT || 0.0045),
  startupSeedSizeMultiplier: Number(process.env.STARTUP_SEED_SIZE_MULTIPLIER || 0.4),
  trendCarryMinHoldBars: Number(process.env.TREND_CARRY_MIN_HOLD_BARS || 2),
  trendExitConfirmBars: Number(process.env.TREND_EXIT_CONFIRM_BARS || 2),
  trendReversalConfirmBars: Number(process.env.TREND_REVERSAL_CONFIRM_BARS || 3),
  structureEnabled: String(process.env.STRUCTURE_ENGINE_ENABLED || 'false').toLowerCase() === 'true',
  structureStaleMs: Number(process.env.STRUCTURE_STALE_MS || 600000),
  swingLookback: Number(process.env.STRUCTURE_SWING_LOOKBACK || 2),
  zoneLookback: Number(process.env.STRUCTURE_ZONE_LOOKBACK || 20),
  bosMinAtr: Number(process.env.STRUCTURE_BOS_MIN_ATR || 0.15),
  reclaimTolerancePct: Number(process.env.STRUCTURE_RECLAIM_TOLERANCE_PCT || 0.0015),
  winnerAddRequireStructure: String(process.env.STRUCTURE_WINNER_ADD_REQUIRE || 'true').toLowerCase() === 'true',
  structureTrailEnabled: String(process.env.STRUCTURE_TRAIL_ENABLED || 'true').toLowerCase() === 'true',
  structureEntryRequireFreshness: String(process.env.STRUCTURE_ENTRY_REQUIRE_FRESHNESS || 'true').toLowerCase() === 'true',
  contextEntryVetoEnabled: String(process.env.CONTEXT_ENTRY_VETO_ENABLED || 'true').toLowerCase() === 'true',
  maxSpoofScoreForEntry: Number(process.env.CONTEXT_MAX_SPOOF_SCORE || 2.25),
  maxExpectedSlippageBpsForEntry: Number(process.env.CONTEXT_MAX_EXPECTED_SLIPPAGE_BPS || 8),
  maxVpinForEntry: Number(process.env.CONTEXT_MAX_VPIN || 0.68),
  edgeSizingEnabled: String(process.env.EDGE_SIZING_ENABLED || 'true').toLowerCase() === 'true',
  edgeSizeFloorMultiplier: Number(process.env.EDGE_SIZE_FLOOR_MULTIPLIER || 0.75),
  edgeSizeCeilMultiplier: Number(process.env.EDGE_SIZE_CEIL_MULTIPLIER || 1.1),
};
