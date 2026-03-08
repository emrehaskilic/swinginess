import type { AdvancedMicrostructureBundle } from '../metrics/AdvancedMicrostructureMetrics';
import type {
  AuctionAcceptance,
  AuctionLocation,
  EntrySetupKind,
  ExecutionQualityLevel,
  LiquidityQuality,
  ManipulationRiskLevel,
  SessionProfileSnapshot,
  StrategyDecisionContext,
  StrategyTrendState,
} from '../types/strategy';
import type { StructureSnapshot } from '../structure/types';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function resolveLiquidityQuality(input: {
  orderbookTrusted: boolean;
  integrityLevel?: 'OK' | 'DEGRADED' | 'CRITICAL' | null;
  spreadPct: number | null;
  expectedSlippageBps: number;
  voidGapScore: number;
  vpinApprox: number;
}): LiquidityQuality {
  if (!input.orderbookTrusted || (input.integrityLevel && input.integrityLevel === 'CRITICAL')) return 'BLOCKED';
  if (input.expectedSlippageBps >= 12 || input.voidGapScore >= 0.75 || input.vpinApprox >= 0.8) return 'TOXIC';
  if (input.expectedSlippageBps >= 6 || (input.spreadPct ?? 0) >= 0.08 || input.voidGapScore >= 0.45) return 'THIN';
  return 'GOOD';
}

function resolveManipulationRisk(input: {
  spoofScore: number;
  vpinApprox: number;
  burstPersistenceScore: number;
}): ManipulationRiskLevel {
  if (input.spoofScore >= 2 || input.vpinApprox >= 0.8 || input.burstPersistenceScore >= 0.8) return 'HIGH';
  if (input.spoofScore >= 1 || input.vpinApprox >= 0.6 || input.burstPersistenceScore >= 0.55) return 'MEDIUM';
  return 'LOW';
}

function resolveManipulationReasons(input: {
  spoofScore: number;
  vpinApprox: number;
  burstPersistenceScore: number;
}): string[] {
  const reasons: string[] = [];
  if (input.spoofScore >= 2) reasons.push('SPOOF_SCORE_HIGH');
  else if (input.spoofScore >= 1) reasons.push('SPOOF_SCORE_ELEVATED');
  if (input.vpinApprox >= 0.8) reasons.push('TOXIC_FLOW_HIGH');
  else if (input.vpinApprox >= 0.6) reasons.push('TOXIC_FLOW_ELEVATED');
  if (input.burstPersistenceScore >= 0.8) reasons.push('BURST_PERSISTENCE_HIGH');
  else if (input.burstPersistenceScore >= 0.55) reasons.push('BURST_PERSISTENCE_ELEVATED');
  return reasons;
}

function resolveExecutionQuality(input: {
  orderbookTrusted: boolean;
  integrityLevel?: 'OK' | 'DEGRADED' | 'CRITICAL' | null;
  liquidityQuality: LiquidityQuality;
  manipulationRisk: ManipulationRiskLevel;
  netEdgePct: number;
}): { quality: ExecutionQualityLevel; blockedReasons: string[] } {
  const blockedReasons: string[] = [];
  if (!input.orderbookTrusted) blockedReasons.push('ORDERBOOK_UNTRUSTED');
  if (input.integrityLevel && input.integrityLevel !== 'OK') blockedReasons.push(`INTEGRITY_${input.integrityLevel}`);
  if (input.liquidityQuality === 'BLOCKED') blockedReasons.push('LIQUIDITY_BLOCKED');
  if (input.netEdgePct <= 0) blockedReasons.push('EDGE_NEGATIVE');

  if (blockedReasons.length > 0) {
    return { quality: 'BLOCKED', blockedReasons };
  }
  if (input.liquidityQuality !== 'GOOD' || input.manipulationRisk !== 'LOW') {
    return { quality: 'DEGRADED', blockedReasons };
  }
  return { quality: 'GOOD', blockedReasons };
}

function resolvePreferredSetup(input: {
  location: AuctionLocation;
  acceptance: AuctionAcceptance;
  trendState: StrategyTrendState | null;
  structure: StructureSnapshot | null;
}): EntrySetupKind | null {
  if (
    (input.location === 'ABOVE_VAH' && input.acceptance === 'ACCEPTING_ABOVE')
    || (input.location === 'BELOW_VAL' && input.acceptance === 'ACCEPTING_BELOW')
  ) {
    return 'BREAKOUT_ACCEPTANCE';
  }
  if (
    (input.location === 'ABOVE_VAH' && input.acceptance === 'REJECTING_HIGH')
    || (input.location === 'BELOW_VAL' && input.acceptance === 'REJECTING_LOW')
  ) {
    return 'AUCTION_REVERSION';
  }
  if (input.trendState && input.trendState !== 'RANGE') {
    return 'TREND_CONTINUATION';
  }
  if (input.structure?.reclaimUp || input.structure?.reclaimDn) {
    return 'AUCTION_REVERSION';
  }
  return null;
}

export function assembleDecisionContext(input: {
  nowMs: number;
  price: number;
  vwap: number;
  spreadPct: number | null;
  orderbookTrusted: boolean;
  integrityLevel?: 'OK' | 'DEGRADED' | 'CRITICAL' | null;
  bias15m: 'UP' | 'DOWN' | 'NEUTRAL';
  trendState: StrategyTrendState | null;
  trendConfidence: number;
  profile: SessionProfileSnapshot | null;
  advancedBundle: AdvancedMicrostructureBundle;
  structure: StructureSnapshot | null;
}): StrategyDecisionContext {
  const price = Number(input.price || 0);
  const spreadPct = Number(input.spreadPct ?? 0);
  const effectiveSpreadAbs = Math.max(0, Number(input.advancedBundle.liquidityMetrics.effectiveSpread || 0));
  const expectedSlippageAbs = Math.max(
    Number(input.advancedBundle.liquidityMetrics.expectedSlippageBuy || 0),
    Number(input.advancedBundle.liquidityMetrics.expectedSlippageSell || 0),
  );
  const expectedSlippageBps = price > 0 ? (expectedSlippageAbs / price) * 10_000 : 0;
  const effectiveSpreadBps = price > 0 ? (effectiveSpreadAbs / price) * 10_000 : spreadPct * 100;
  const voidGapScore = clamp(Number(input.advancedBundle.liquidityMetrics.voidGapScore || 0), 0, 1);
  const wallScore = clamp(Number(input.advancedBundle.liquidityMetrics.liquidityWallScore || 0), 0, 1);
  const spoofScore = Math.max(0, Number(input.advancedBundle.passiveFlowMetrics.spoofScore || 0));
  const vpinApprox = clamp(Number(input.advancedBundle.toxicityMetrics.vpinApprox || 0), 0, 1);
  const burstPersistenceScore = clamp(Number(input.advancedBundle.toxicityMetrics.burstPersistenceScore || 0), 0, 1);
  const liquidityQuality = resolveLiquidityQuality({
    orderbookTrusted: input.orderbookTrusted,
    integrityLevel: input.integrityLevel,
    spreadPct,
    expectedSlippageBps,
    voidGapScore,
    vpinApprox,
  });
  const manipulationRisk = resolveManipulationRisk({ spoofScore, vpinApprox, burstPersistenceScore });
  const manipulationReasons = resolveManipulationReasons({ spoofScore, vpinApprox, burstPersistenceScore });

  const spreadCostPct = Math.max(0, spreadPct) / 100;
  const volatilityPct = price > 0 ? Math.max(0, Number(input.advancedBundle.regimeMetrics.microATR || 0)) / price : 0;
  const vwapDistancePct = Number(input.vwap || 0) > 0 ? Math.abs(price - Number(input.vwap || 0)) / Number(input.vwap || 0) : 0;
  const expectedMovePct = Math.max(volatilityPct, vwapDistancePct + 0.0015, 0.0025);
  const estimatedCostPct = spreadCostPct + (expectedSlippageBps / 10_000) + 0.0008 + 0.0005;
  const netEdgePct = expectedMovePct - estimatedCostPct;
  const edgeScore = clamp((netEdgePct + 0.0015) / 0.0045, 0, 1);
  const execution = resolveExecutionQuality({
    orderbookTrusted: input.orderbookTrusted,
    integrityLevel: input.integrityLevel,
    liquidityQuality,
    manipulationRisk,
    netEdgePct,
  });
  const liquidityScore = clamp(
    1
      - ((expectedSlippageBps / 15) * 0.45)
      - (voidGapScore * 0.3)
      - (Math.max(0, spreadPct - 0.02) * 2.5),
    0,
    1,
  );
  const trendinessScore = clamp(Number(input.advancedBundle.regimeMetrics.trendinessScore || 0), 0, 1);
  const chopScore = clamp(Number(input.advancedBundle.regimeMetrics.chopScore || 0), 0, 1);
  const location = input.profile?.location ?? 'UNKNOWN';
  const acceptance = input.profile?.acceptance ?? 'NEUTRAL';
  const preferredSetup = resolvePreferredSetup({
    location,
    acceptance,
    trendState: input.trendState,
    structure: input.structure,
  });

  return {
    updatedAtMs: input.nowMs,
    trend: {
      bias15m: input.bias15m,
      trendState: input.trendState,
      trendinessScore,
      chopScore,
      confidence: clamp(Number(input.trendConfidence || 0), 0, 1),
    },
    liquidity: {
      quality: liquidityQuality,
      score: liquidityScore,
      expectedSlippageBps,
      effectiveSpreadBps,
      voidGapScore,
      wallScore,
    },
    manipulation: {
      risk: manipulationRisk,
      spoofScore,
      vpinApprox,
      burstPersistenceScore,
      blocked: manipulationRisk === 'HIGH',
      reasons: manipulationReasons,
    },
    auction: {
      profile: input.profile,
      location,
      acceptance,
      inValue: location === 'IN_VALUE',
      aboveVah: location === 'ABOVE_VAH',
      belowVal: location === 'BELOW_VAL',
      distanceToPocBps: input.profile?.distanceToPocBps ?? null,
      distanceToValueEdgeBps: input.profile?.distanceToValueEdgeBps ?? null,
    },
    edge: {
      expectedMovePct,
      estimatedCostPct,
      netEdgePct,
      score: edgeScore,
    },
    execution: {
      quality: execution.quality,
      blockedReasons: execution.blockedReasons,
      confidence: clamp(
        (Number(input.trendConfidence || 0) * 0.35)
        + (liquidityScore * 0.25)
        + (edgeScore * 0.25)
        + ((manipulationRisk === 'LOW' ? 1 : manipulationRisk === 'MEDIUM' ? 0.5 : 0) * 0.15),
        0,
        1,
      ),
    },
    preferredSetup,
  };
}
