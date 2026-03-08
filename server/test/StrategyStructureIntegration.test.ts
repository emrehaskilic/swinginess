function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import type { StructureSnapshot } from '../structure/types';
import { StrategyInput, StrategyPositionState } from '../types/strategy';

function makeStructureSnapshot(nowMs: number, overrides: Partial<StructureSnapshot> = {}): StructureSnapshot {
  return {
    enabled: true,
    updatedAtMs: nowMs,
    freshnessMs: 0,
    isFresh: true,
    bias: 'BULLISH',
    primaryTimeframe: '3m',
    recentClose: 100.6,
    recentAtr: 1.4,
    sourceBarCount: 120,
    zone: {
      high: 101.8,
      low: 99.7,
      mid: 100.75,
      range: 2.1,
      timeframe: '5m',
      formedAtMs: nowMs - 60_000,
    },
    anchors: {
      longStopAnchor: 99.9,
      shortStopAnchor: 101.8,
      longTargetBand: 102.3,
      shortTargetBand: 99.1,
    },
    bosUp: true,
    bosDn: false,
    reclaimUp: false,
    reclaimDn: false,
    continuationLong: true,
    continuationShort: false,
    lastSwingLabel: 'HL',
    lastSwingTimestampMs: nowMs - 60_000,
    lastConfirmedHH: {
      label: 'HH',
      kind: 'HIGH',
      price: 101.8,
      timestampMs: nowMs - 180_000,
      timeframe: '3m',
      index: 1,
    },
    lastConfirmedHL: {
      label: 'HL',
      kind: 'LOW',
      price: 99.9,
      timestampMs: nowMs - 60_000,
      timeframe: '3m',
      index: 2,
    },
    lastConfirmedLH: null,
    lastConfirmedLL: null,
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
      spreadPct: 0.03,
      bestBid: 100.5,
      bestAsk: 100.51,
    },
    trades: {
      lastUpdatedMs: nowMs,
      printsPerSecond: 10,
      tradeCount: 36,
      aggressiveBuyVolume: 18,
      aggressiveSellVolume: 5,
      consecutiveBurst: { side: 'buy', count: 5 },
    },
    market: {
      price: 100.6,
      vwap: 100.2,
      delta1s: 1.1,
      delta5s: 1.4,
      deltaZ: 1.8,
      cvdSlope: 0.35,
      obiWeighted: 0.2,
      obiDeep: 0.18,
      obiDivergence: 0.04,
    },
    openInterest: null,
    absorption: { value: 1, side: 'buy' },
    bootstrap: { backfillDone: true, barsLoaded1m: 1440 },
    htf: {
      m15: { close: 100.7, atr: 1, lastSwingHigh: 101.5, lastSwingLow: 99.4, structureBreakUp: true, structureBreakDn: false },
      h1: { close: 100.9, atr: 2, lastSwingHigh: 103, lastSwingLow: 98.8, structureBreakUp: false, structureBreakDn: false },
    },
    structure: makeStructureSnapshot(nowMs),
    execution: {
      startupMode: 'EARLY_SEED_THEN_MICRO',
      seedReady: true,
      tradeReady: true,
      addonReady: true,
      vetoReason: null,
      orderbookTrusted: true,
      integrityLevel: 'OK',
      trendState: 'UPTREND',
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
        price: 100,
        vwap: 100,
        delta1s: -0.2,
        delta5s: -0.2,
        deltaZ: -0.2,
        cvdSlope: -0.05,
        obiWeighted: -0.05,
        obiDeep: -0.05,
        obiDivergence: -0.01,
      },
      trades: {
        lastUpdatedMs: startMs + (index * 1000),
        printsPerSecond: 4,
        tradeCount: 15,
        aggressiveBuyVolume: 4,
        aggressiveSellVolume: 7,
        consecutiveBurst: { side: 'sell', count: 2 },
      },
      structure: makeStructureSnapshot(startMs + (index * 1000), {
        bias: 'BULLISH',
        bosUp: false,
        reclaimUp: true,
      }),
      absorption: { value: 0, side: null },
    }));
  }
}

export function runTests() {
  const structureStrategy = new NewStrategyV11({
    structureEnabled: true,
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
    addSizing: [0.2, 0.2, 0.2],
    maxPositionSizePct: 2,
  });
  warm(structureStrategy, 9_000_000);

  const blockedMissingStructure = structureStrategy.evaluate(makeInput(9_020_000, {
    structure: null,
  }));
  assert(
    blockedMissingStructure.reasons.includes('ENTRY_BLOCKED_STRUCTURE'),
    'missing structure should veto otherwise valid entries when structure mode is enabled',
  );
  assert(
    !blockedMissingStructure.actions.some((action) => action.type === 'ENTRY'),
    'missing structure should prevent entry actions',
  );

  const allowedLong = structureStrategy.evaluate(makeInput(9_030_000));
  assert(
    allowedLong.actions.some((action) => action.type === 'ENTRY' && action.side === 'LONG'),
    'bullish fresh structure plus aligned orderflow should permit a long entry',
  );

  const weakOrderflow = structureStrategy.evaluate(makeInput(9_040_000, {
    market: {
      price: 100.35,
      vwap: 100.2,
      delta1s: -0.3,
      delta5s: -0.2,
      deltaZ: -0.4,
      cvdSlope: -0.1,
      obiWeighted: -0.22,
      obiDeep: -0.3,
      obiDivergence: -0.05,
    },
    trades: {
      lastUpdatedMs: 9_040_000,
      printsPerSecond: 8,
      tradeCount: 28,
      aggressiveBuyVolume: 7,
      aggressiveSellVolume: 11,
      consecutiveBurst: { side: 'sell', count: 4 },
    },
  }));
  assert(
    !weakOrderflow.actions.some((action) => action.type === 'ENTRY'),
    'structure alignment should not override weak or contradictory orderflow',
  );

  const winnerPosition: StrategyPositionState = {
    side: 'LONG',
    qty: 1,
    entryPrice: 100,
    unrealizedPnlPct: 0.006,
    addsUsed: 0,
    sizePct: 0.2,
    timeInPositionMs: 120_000,
    peakPnlPct: 0.006,
  };

  const staleAddStrategy = new NewStrategyV11({
    structureEnabled: true,
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
    addSizing: [0.2, 0.2, 0.2],
    maxPositionSizePct: 2,
  });
  warm(staleAddStrategy, 9_050_000);

  const staleAdd = staleAddStrategy.evaluate(makeInput(9_070_000, {
    position: winnerPosition,
    structure: makeStructureSnapshot(9_050_000, {
      isFresh: false,
      freshnessMs: 20 * 60_000,
    }),
  }));
  assert(
    !staleAdd.actions.some((action) => action.type === 'ADD'),
    'stale structure should block add decisions',
  );

  const continuationStrategy = new NewStrategyV11({
    structureEnabled: true,
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
    addSizing: [0.2, 0.2, 0.2],
    maxPositionSizePct: 2,
  });
  warm(continuationStrategy, 9_080_000);

  const continuationMissing = continuationStrategy.evaluate(makeInput(9_100_000, {
    position: winnerPosition,
    structure: makeStructureSnapshot(9_100_000, {
      continuationLong: false,
      lastSwingLabel: 'HH',
    }),
  }));
  assert(
    !continuationMissing.actions.some((action) => action.type === 'ADD'),
    'winner adds should require fresh continuation structure',
  );

  const winnerAddStrategy = new NewStrategyV11({
    structureEnabled: true,
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
    addSizing: [0.2, 0.2, 0.2],
    maxPositionSizePct: 2,
  });
  warm(winnerAddStrategy, 9_110_000);

  const winnerAdd = winnerAddStrategy.evaluate(makeInput(9_130_000, {
    position: winnerPosition,
    structure: makeStructureSnapshot(9_130_000, {
      continuationLong: true,
      lastSwingLabel: 'HL',
    }),
  }));
  assert(
    winnerAdd.actions.some((action) => action.type === 'ADD' && action.reason === 'ADD_WINNER'),
    'fresh HL continuation should unlock winner add behavior',
  );

  const exitStrategy = new NewStrategyV11({
    structureEnabled: true,
    mhtTRs: 0,
    mhtMRs: 0,
    mhtEVs: 0,
    cooldownSameS: 0,
    cooldownFlipS: 0,
    addSizing: [0.2, 0.2, 0.2],
    maxPositionSizePct: 2,
  });
  warm(exitStrategy, 9_140_000);

  const invalidatedLong = exitStrategy.evaluate(makeInput(9_160_000, {
    position: {
      side: 'LONG',
      qty: 1,
      entryPrice: 100.4,
      unrealizedPnlPct: -0.002,
      addsUsed: 0,
      sizePct: 0.2,
      timeInPositionMs: 12 * 60_000,
      peakPnlPct: 0.004,
    },
    execution: {
      tradeReady: true,
      addonReady: true,
      vetoReason: null,
      orderbookTrusted: true,
      integrityLevel: 'OK',
      trendState: 'DOWNTREND',
      bias15m: 'DOWN',
      veto1h: 'DOWN',
    },
    market: {
      price: 99.7,
      vwap: 100.2,
      delta1s: -1.4,
      delta5s: -1.1,
      deltaZ: -1.8,
      cvdSlope: -0.4,
      obiWeighted: -0.18,
      obiDeep: -0.22,
      obiDivergence: -0.07,
    },
    trades: {
      lastUpdatedMs: 9_160_000,
      printsPerSecond: 9,
      tradeCount: 30,
      aggressiveBuyVolume: 5,
      aggressiveSellVolume: 16,
      consecutiveBurst: { side: 'sell', count: 6 },
    },
    structure: makeStructureSnapshot(9_160_000, {
      bias: 'BEARISH',
      bosUp: false,
      bosDn: true,
      reclaimUp: false,
      continuationLong: false,
      lastSwingLabel: 'LL',
      anchors: {
        longStopAnchor: 99.85,
        shortStopAnchor: 101.4,
        longTargetBand: 101.2,
        shortTargetBand: 98.7,
      },
      lastConfirmedHH: null,
      lastConfirmedHL: null,
      lastConfirmedLH: {
        label: 'LH',
        kind: 'HIGH',
        price: 100.8,
        timestampMs: 9_020_000,
        timeframe: '3m',
        index: 1,
      },
      lastConfirmedLL: {
        label: 'LL',
        kind: 'LOW',
        price: 99.6,
        timestampMs: 9_060_000,
        timeframe: '3m',
        index: 2,
      },
    }),
  }));
  assert(
    invalidatedLong.actions.some((action) => action.type === 'EXIT' && action.reason === 'EXIT_HARD'),
    'bearish structure invalidation should escalate to hard exit on an opposing long',
  );
}
