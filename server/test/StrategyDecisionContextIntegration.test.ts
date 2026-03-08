function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import type { StrategyDecisionContext, StrategyInput } from '../types/strategy';

function makeContext(overrides: Partial<StrategyDecisionContext> = {}): StrategyDecisionContext {
  return {
    updatedAtMs: 1_000_000,
    trend: {
      bias15m: 'UP',
      trendState: 'UPTREND',
      trendinessScore: 0.72,
      chopScore: 0.25,
      confidence: 0.78,
    },
    liquidity: {
      quality: 'GOOD',
      score: 0.82,
      expectedSlippageBps: 3,
      effectiveSpreadBps: 2,
      voidGapScore: 0.1,
      wallScore: 0.2,
    },
    manipulation: {
      risk: 'LOW',
      spoofScore: 0.3,
      vpinApprox: 0.28,
      burstPersistenceScore: 0.22,
      blocked: false,
      reasons: [],
    },
    auction: {
      profile: {
        sessionName: 'london',
        sessionStartMs: 900_000,
        bucketSize: 0.05,
        poc: 100.1,
        vah: 100.5,
        val: 99.8,
        location: 'ABOVE_VAH',
        acceptance: 'ACCEPTING_ABOVE',
        distanceToPocBps: 20,
        distanceToValueEdgeBps: 4,
        totalVolume: 120,
      },
      location: 'ABOVE_VAH',
      acceptance: 'ACCEPTING_ABOVE',
      inValue: false,
      aboveVah: true,
      belowVal: false,
      distanceToPocBps: 20,
      distanceToValueEdgeBps: 4,
    },
    edge: {
      expectedMovePct: 0.004,
      estimatedCostPct: 0.0015,
      netEdgePct: 0.0025,
      score: 0.9,
    },
    execution: {
      quality: 'GOOD',
      blockedReasons: [],
      confidence: 0.82,
    },
    preferredSetup: 'BREAKOUT_ACCEPTANCE',
    ...overrides,
  };
}

function makeInput(nowMs: number, overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    symbol: 'BTCUSDT',
    nowMs,
    source: 'real',
    orderbook: {
      lastUpdatedMs: nowMs,
      spreadPct: 0.02,
      bestBid: 100.84,
      bestAsk: 100.86,
    },
    trades: {
      lastUpdatedMs: nowMs,
      printsPerSecond: 9,
      tradeCount: 32,
      aggressiveBuyVolume: 18,
      aggressiveSellVolume: 6,
      consecutiveBurst: { side: 'buy', count: 5 },
    },
    market: {
      price: 100.85,
      vwap: 100.3,
      delta1s: 1.1,
      delta5s: 1.4,
      deltaZ: 1.7,
      cvdSlope: 0.32,
      obiWeighted: 0.18,
      obiDeep: 0.22,
      obiDivergence: 0.05,
    },
    openInterest: null,
    absorption: { value: 1, side: 'buy' },
    bootstrap: { backfillDone: true, barsLoaded1m: 1440 },
    htf: {
      m15: { close: 100.8, atr: 0.8, lastSwingHigh: 101.2, lastSwingLow: 99.7, structureBreakUp: true, structureBreakDn: false },
      h1: { close: 101, atr: 1.7, lastSwingHigh: 102.8, lastSwingLow: 98.9, structureBreakUp: false, structureBreakDn: false },
    },
    decisionContext: makeContext(),
    execution: {
      startupMode: 'EARLY_SEED_THEN_MICRO',
      seedReady: true,
      tradeReady: true,
      addonReady: true,
      vetoReason: null,
      orderbookTrusted: true,
      integrityLevel: 'OK',
      trendState: 'UPTREND',
      trendConfidence: 0.8,
      bias15m: 'UP',
      veto1h: 'NONE',
    },
    volatility: 0.5,
    position: null,
    ...overrides,
  };
}

function warm(strategy: NewStrategyV11, startMs: number): void {
  for (let index = 0; index < 16; index += 1) {
    strategy.evaluate(makeInput(startMs + (index * 1000), {
      market: {
        price: 100.1,
        vwap: 100.1,
        delta1s: -0.2,
        delta5s: -0.25,
        deltaZ: -0.3,
        cvdSlope: -0.1,
        obiWeighted: -0.05,
        obiDeep: -0.06,
        obiDivergence: -0.02,
      },
      trades: {
        lastUpdatedMs: startMs + (index * 1000),
        printsPerSecond: 5,
        tradeCount: 18,
        aggressiveBuyVolume: 4,
        aggressiveSellVolume: 7,
        consecutiveBurst: { side: 'sell', count: 2 },
      },
      decisionContext: makeContext({
        updatedAtMs: startMs + (index * 1000),
        preferredSetup: 'TREND_CONTINUATION',
        auction: {
          ...makeContext().auction,
          location: 'IN_VALUE',
          acceptance: 'ACCEPTING_VALUE',
          inValue: true,
          aboveVah: false,
          belowVal: false,
          distanceToPocBps: 0,
          distanceToValueEdgeBps: 5,
          profile: {
            ...makeContext().auction.profile!,
            location: 'IN_VALUE',
            acceptance: 'ACCEPTING_VALUE',
          },
        },
      }),
    }));
  }
}

export function runTests() {
  const strategy = new NewStrategyV11({
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
  });
  warm(strategy, 2_000_000);

  const breakoutEntry = strategy.evaluate(makeInput(2_030_000));
  assert(
    breakoutEntry.actions.some((action) => action.type === 'ENTRY' && action.side === 'LONG'),
    'breakout acceptance context should permit aligned long entries',
  );

  const blockedByContext = strategy.evaluate(makeInput(2_040_000, {
    decisionContext: makeContext({
      manipulation: {
        risk: 'HIGH',
        spoofScore: 3,
        vpinApprox: 0.84,
        burstPersistenceScore: 0.88,
        blocked: true,
        reasons: ['SPOOF_SCORE_HIGH'],
      },
      liquidity: {
        ...makeContext().liquidity,
        expectedSlippageBps: 14,
        quality: 'TOXIC',
      },
      execution: {
        quality: 'BLOCKED',
        blockedReasons: ['ORDERBOOK_UNTRUSTED'],
        confidence: 0.2,
      },
    }),
  }));
  assert(
    !blockedByContext.actions.some((action) => action.type === 'ENTRY'),
    'blocked execution context should veto otherwise valid entries',
  );

  const adaptiveStrategy = new NewStrategyV11({
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
  });
  warm(adaptiveStrategy, 3_000_000);

  const adaptiveAllowed = adaptiveStrategy.evaluate(makeInput(3_030_000, {
    decisionContext: makeContext({
      manipulation: {
        risk: 'MEDIUM',
        spoofScore: 9,
        vpinApprox: 0.72,
        burstPersistenceScore: 0.32,
        blocked: false,
        reasons: ['SPOOF_SCORE_ELEVATED'],
      },
      adaptive: {
        ready: true,
        sampleCount: 180,
        spoofScoreThreshold: 12,
        vpinThreshold: 0.78,
        expectedSlippageBpsThreshold: 6,
        spoofScorePercentile: 0.74,
        vpinPercentile: 0.7,
        expectedSlippageBpsPercentile: 0.5,
      },
    }),
  }));
  assert(
    adaptiveAllowed.actions.some((action) => action.type === 'ENTRY' && action.side === 'LONG'),
    'adaptive pair thresholds should allow entries that are noisy but normal for that symbol',
  );

  const adaptiveBlocked = adaptiveStrategy.evaluate(makeInput(3_040_000, {
    decisionContext: makeContext({
      manipulation: {
        risk: 'HIGH',
        spoofScore: 15,
        vpinApprox: 0.84,
        burstPersistenceScore: 0.4,
        blocked: true,
        reasons: ['SPOOF_SCORE_HIGH', 'TOXIC_FLOW_HIGH'],
      },
      adaptive: {
        ready: true,
        sampleCount: 180,
        spoofScoreThreshold: 12,
        vpinThreshold: 0.78,
        expectedSlippageBpsThreshold: 6,
        spoofScorePercentile: 0.99,
        vpinPercentile: 0.98,
        expectedSlippageBpsPercentile: 0.5,
      },
    }),
  }));
  assert(
    !adaptiveBlocked.actions.some((action) => action.type === 'ENTRY'),
    'adaptive pair thresholds should still block true local extremes',
  );
}
