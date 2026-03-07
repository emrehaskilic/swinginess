// Minimal assertion helper
function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { StrategyInput, StrategyPositionState } from '../types/strategy';

function makeInput(nowMs: number, overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    symbol: 'TEST',
    nowMs,
    source: 'real',
    orderbook: {
      lastUpdatedMs: nowMs,
      spreadPct: 0.05,
      bestBid: 100,
      bestAsk: 100.1,
    },
    trades: {
      lastUpdatedMs: nowMs,
      printsPerSecond: 8,
      tradeCount: 25,
      aggressiveBuyVolume: 5,
      aggressiveSellVolume: 20,
      consecutiveBurst: { side: 'sell', count: 7 },
    },
    market: {
      price: 99.0,
      vwap: 100.0,
      delta1s: -3.0,
      delta5s: -2.5,
      deltaZ: -3.5,
      cvdSlope: -1.2,
      obiWeighted: -0.8,
      obiDeep: -0.9,
      obiDivergence: -0.4,
    },
    openInterest: null,
    absorption: { value: 1, side: 'sell' },
    bootstrap: { backfillDone: true, barsLoaded1m: 1440 },
    htf: {
      m15: { close: 99, atr: 1, lastSwingHigh: 101, lastSwingLow: 98, structureBreakUp: false, structureBreakDn: false },
      h1: { close: 100, atr: 2, lastSwingHigh: 102, lastSwingLow: 97, structureBreakUp: false, structureBreakDn: false },
    },
    execution: { tradeReady: true, addonReady: true, vetoReason: null },
    volatility: 1.5,
    position: null,
    ...overrides,
  };
}

export function runTests() {
  const strategy = new NewStrategyV11({ hardRevTicks: 5 });
  let now = 2_000_000;

  // Warm-up baseline
  for (let i = 0; i < 15; i += 1) {
    strategy.evaluate(makeInput(now + i * 1000, {
      market: {
        price: 100,
        vwap: 100,
        delta1s: 0.1,
        delta5s: 0.1,
        deltaZ: 0.1,
        cvdSlope: 0.05,
        obiWeighted: 0.05,
        obiDeep: 0.05,
        obiDivergence: 0.01,
      },
      trades: {
        lastUpdatedMs: now + i * 1000,
        printsPerSecond: 3,
        tradeCount: 15,
        aggressiveBuyVolume: 8,
        aggressiveSellVolume: 7,
        consecutiveBurst: { side: 'buy', count: 2 },
      },
      absorption: { value: 0, side: null },
    }));
  }

  const position: StrategyPositionState = {
    side: 'LONG',
    qty: 1,
    entryPrice: 101,
    unrealizedPnlPct: -0.01,
    addsUsed: 0,
  };

  // Feed vwap-below ticks to satisfy persistence
  for (let i = 0; i < 5; i += 1) {
    now += 1000;
    strategy.evaluate(makeInput(now, { position }));
  }

  // Hard reversal tick
  now += 1000;
  const decision = strategy.evaluate(makeInput(now, {
    position,
    market: {
      price: 98.9,
      vwap: 100.0,
      delta1s: -4.5,
      delta5s: -4.0,
      deltaZ: -4.2,
      cvdSlope: -2.0,
      obiWeighted: -0.9,
      obiDeep: -1.0,
      obiDivergence: -0.5,
    },
    trades: {
      lastUpdatedMs: now,
      printsPerSecond: 12,
      tradeCount: 40,
      aggressiveBuyVolume: 4,
      aggressiveSellVolume: 30,
      consecutiveBurst: { side: 'sell', count: 10 },
    },
    absorption: { value: 1, side: 'sell' },
  }));

  const hasHardExit = decision.actions.some((a) => a.reason === 'EXIT_HARD');
  const hasHardEntry = decision.actions.some((a) => a.reason === 'HARD_REVERSAL_ENTRY');
  assert(hasHardExit, 'persistent opposite pressure should emit EXIT_HARD');
  assert(!hasHardEntry, 'immediate reverse entry should remain suppressed');

  const protectedFreshDecision = strategy.evaluate(makeInput(now + 2_000, {
    position: {
      side: 'LONG',
      qty: 1,
      entryPrice: 101,
      unrealizedPnlPct: -0.002,
      addsUsed: 0,
      timeInPositionMs: 45_000,
    },
    market: {
      price: 98.9,
      vwap: 100.0,
      delta1s: -4.5,
      delta5s: -4.0,
      deltaZ: -4.2,
      cvdSlope: -2.0,
      obiWeighted: -0.9,
      obiDeep: -1.0,
      obiDivergence: -0.5,
    },
    trades: {
      lastUpdatedMs: now + 2_000,
      printsPerSecond: 12,
      tradeCount: 40,
      aggressiveBuyVolume: 4,
      aggressiveSellVolume: 30,
      consecutiveBurst: { side: 'sell', count: 10 },
    },
    absorption: { value: 1, side: 'sell' },
  }));
  assert(
    !protectedFreshDecision.actions.some((a) => a.reason === 'HARD_REVERSAL_ENTRY'),
    'fresh positions should not flip immediately on the first opposite burst'
  );

  const confirmedReversalStrategy = new NewStrategyV11({
    hardRevTicks: 4,
    freshReversalProtectS: 0,
    trendCarryMinHoldBars: 2,
    trendExitConfirmBars: 2,
    trendReversalConfirmBars: 3,
  });
  let reversalNow = 3_000_000;
  for (let i = 0; i < 15; i += 1) {
    confirmedReversalStrategy.evaluate(makeInput(reversalNow + (i * 1000), {
      market: {
        price: 100,
        vwap: 100,
        delta1s: 0.2,
        delta5s: 0.1,
        deltaZ: 0.15,
        cvdSlope: 0.08,
        obiWeighted: 0.05,
        obiDeep: 0.05,
        obiDivergence: 0.01,
      },
      trades: {
        lastUpdatedMs: reversalNow + (i * 1000),
        printsPerSecond: 3,
        tradeCount: 16,
        aggressiveBuyVolume: 7,
        aggressiveSellVolume: 6,
        consecutiveBurst: { side: 'buy', count: 2 },
      },
      absorption: { value: 0, side: null },
    }));
  }

  const reversalPosition: StrategyPositionState = {
    side: 'LONG',
    qty: 1,
    entryPrice: 101,
    unrealizedPnlPct: -0.011,
    addsUsed: 0,
    timeInPositionMs: 10 * 60 * 1000,
  };
  const reversalOverrides = {
    position: reversalPosition,
    execution: {
      tradeReady: true,
      addonReady: true,
      vetoReason: null,
      trendState: 'DOWNTREND' as const,
      bias15m: 'DOWN' as const,
      veto1h: 'DOWN' as const,
    },
    htf: {
      m15: { close: 98.9, atr: 1, lastSwingHigh: 101, lastSwingLow: 98, structureBreakUp: false, structureBreakDn: true },
      h1: { close: 99.2, atr: 2, lastSwingHigh: 102, lastSwingLow: 97, structureBreakUp: false, structureBreakDn: true },
    },
    market: {
      price: 98.8,
      vwap: 100.0,
      delta1s: -4.6,
      delta5s: -4.1,
      deltaZ: -4.3,
      cvdSlope: -2.1,
      obiWeighted: -0.92,
      obiDeep: -1.0,
      obiDivergence: -0.52,
    },
    trades: {
      printsPerSecond: 12,
      tradeCount: 42,
      aggressiveBuyVolume: 4,
      aggressiveSellVolume: 31,
      consecutiveBurst: { side: 'sell' as const, count: 10 },
    },
    absorption: { value: 1, side: 'sell' as const },
  };

  const firstReversalBar = confirmedReversalStrategy.evaluate(makeInput(reversalNow + 30_000, {
    ...reversalOverrides,
    trades: {
      ...reversalOverrides.trades,
      lastUpdatedMs: reversalNow + 30_000,
    },
  }));
  assert(
    !firstReversalBar.actions.some((a) => a.reason === 'HARD_REVERSAL_ENTRY'),
    'one adverse 3m bar must not flip the position'
  );

  const secondReversalBar = confirmedReversalStrategy.evaluate(makeInput(reversalNow + 210_000, {
    ...reversalOverrides,
    position: { ...reversalPosition, timeInPositionMs: 13 * 60 * 1000 },
    trades: {
      ...reversalOverrides.trades,
      lastUpdatedMs: reversalNow + 210_000,
    },
  }));
  assert(
    !secondReversalBar.actions.some((a) => a.reason === 'HARD_REVERSAL_ENTRY'),
    'two adverse 3m bars still must not flip the position'
  );

  const thirdReversalBar = confirmedReversalStrategy.evaluate(makeInput(reversalNow + 390_000, {
    ...reversalOverrides,
    position: { ...reversalPosition, timeInPositionMs: 16 * 60 * 1000 },
    trades: {
      ...reversalOverrides.trades,
      lastUpdatedMs: reversalNow + 390_000,
    },
  }));
  assert(
    thirdReversalBar.actions.some((a) => a.reason === 'HARD_REVERSAL_ENTRY'),
    'hard reversal should require three confirmed adverse 3m bars'
  );
}
