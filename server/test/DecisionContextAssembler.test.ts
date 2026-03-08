function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

import { assembleDecisionContext } from '../runtime/DecisionContextAssembler';
import type { AdvancedMicrostructureBundle } from '../metrics/AdvancedMicrostructureMetrics';
import type { SessionProfileSnapshot } from '../types/strategy';

function makeBundle(overrides: Partial<AdvancedMicrostructureBundle> = {}): AdvancedMicrostructureBundle {
  return {
    liquidityMetrics: {
      microPrice: 100,
      imbalanceCurve: { level1: 0.6, level5: 0.62, level10: 0.64, level20: 0.63, level50: 0.6 },
      bookSlopeBid: 0.4,
      bookSlopeAsk: 0.2,
      bookConvexity: 0.1,
      liquidityWallScore: 0.2,
      voidGapScore: 0.12,
      expectedSlippageBuy: 0.03,
      expectedSlippageSell: 0.03,
      resiliencyMs: 100,
      effectiveSpread: 0.02,
      realizedSpreadShortWindow: 0.01,
    },
    passiveFlowMetrics: {
      bidAddRate: 1,
      askAddRate: 1,
      bidCancelRate: 0.3,
      askCancelRate: 0.4,
      depthDeltaDecomposition: {
        addVolume: 10,
        cancelVolume: 3,
        tradeRelatedVolume: 2,
        netDepthDelta: 5,
      },
      queueDeltaBestBid: 2,
      queueDeltaBestAsk: -1,
      spoofScore: 0.6,
      refreshRate: 2,
    },
    derivativesMetrics: {
      markLastDeviationPct: 0.02,
      indexLastDeviationPct: 0.01,
      perpBasis: 0.03,
      perpBasisZScore: 0.2,
      liquidationProxyScore: 0.1,
    },
    toxicityMetrics: {
      vpinApprox: 0.32,
      signedVolumeRatio: 0.55,
      priceImpactPerSignedNotional: 0.02,
      tradeToBookRatio: 0.2,
      burstPersistenceScore: 0.25,
    },
    regimeMetrics: {
      realizedVol1m: 0.2,
      realizedVol5m: 0.3,
      realizedVol15m: 0.4,
      volOfVol: 0.2,
      microATR: 0.35,
      chopScore: 0.25,
      trendinessScore: 0.72,
    },
    crossMarketMetrics: null,
    enableCrossMarketConfirmation: false,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<SessionProfileSnapshot> = {}): SessionProfileSnapshot {
  return {
    sessionName: 'london',
    sessionStartMs: Date.UTC(2026, 2, 8, 8, 0, 0, 0),
    bucketSize: 0.05,
    poc: 100.1,
    vah: 100.6,
    val: 99.8,
    location: 'ABOVE_VAH',
    acceptance: 'ACCEPTING_ABOVE',
    distanceToPocBps: 18,
    distanceToValueEdgeBps: 4,
    totalVolume: 120,
    ...overrides,
  };
}

export function runTests() {
  const breakout = assembleDecisionContext({
    nowMs: 1_000_000,
    price: 100.85,
    vwap: 100.3,
    spreadPct: 0.02,
    orderbookTrusted: true,
    integrityLevel: 'OK',
    bias15m: 'UP',
    trendState: 'UPTREND',
    trendConfidence: 0.7,
    profile: makeProfile(),
    advancedBundle: makeBundle(),
    structure: null,
  });
  assert(breakout.preferredSetup === 'BREAKOUT_ACCEPTANCE', 'acceptance above value should map to breakout acceptance');
  assert(breakout.execution.quality === 'GOOD', 'healthy tape should keep execution quality good');
  assert(breakout.liquidity.quality === 'GOOD', 'moderate spread/slippage should classify as good liquidity');

  const blocked = assembleDecisionContext({
    nowMs: 1_001_000,
    price: 100.2,
    vwap: 100.15,
    spreadPct: 0.12,
    orderbookTrusted: false,
    integrityLevel: 'CRITICAL',
    bias15m: 'UP',
    trendState: 'UPTREND',
    trendConfidence: 0.55,
    profile: makeProfile({
      location: 'IN_VALUE',
      acceptance: 'ACCEPTING_VALUE',
    }),
    advancedBundle: makeBundle({
      liquidityMetrics: {
        ...makeBundle().liquidityMetrics,
        expectedSlippageBuy: 0.18,
        expectedSlippageSell: 0.16,
        voidGapScore: 0.82,
      },
      passiveFlowMetrics: {
        ...makeBundle().passiveFlowMetrics,
        spoofScore: 2.4,
      },
      toxicityMetrics: {
        ...makeBundle().toxicityMetrics,
        vpinApprox: 0.88,
        burstPersistenceScore: 0.83,
      },
    }),
    structure: null,
  });
  assert(blocked.execution.quality === 'BLOCKED', 'untrusted critical orderbook should block execution');
  assert(blocked.manipulation.risk === 'HIGH', 'high spoof and toxicity scores should classify manipulation risk as high');
}
