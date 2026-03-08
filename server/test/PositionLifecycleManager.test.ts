function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

import { PositionLifecycleManager } from '../dryrun/PositionLifecycleManager';

export function runTests(): void {
  const manager = new PositionLifecycleManager();
  const trade = manager.createActiveTrade({
    tradeId: 't-1',
    position: {
      side: 'LONG',
      qty: 2,
      entryPrice: 100,
      entryTimestampMs: 1_000,
    },
    eventTimestampMs: 1_000,
    openingFee: 1,
    leverage: 10,
    signalType: 'ENTRY_TR',
    signalScore: 0.8,
    candidate: { entryPrice: 100, slPrice: 98, tpPrice: 105 },
    orderflow: {
      obiWeighted: 0.2,
      obiDeep: 0.18,
      deltaZ: 1.5,
      cvdSlope: 0.8,
    },
  });

  manager.accumulateTrade(trade, 12, 0.5, 0.25);
  const exit = manager.buildExitSnapshot(trade);
  assert(Math.abs(exit.net - 10.75) < 1e-9, 'exit snapshot should net realized, fees, and funding');
  assert(exit.rMultiple !== null && exit.rMultiple > 2.6 && exit.rMultiple < 2.8, 'r multiple should reflect candidate stop distance');

  manager.syncTradePosition(trade, {
    side: 'LONG',
    qty: 3,
    entryPrice: 101,
    entryTimestampMs: 1_200,
  }, 12);
  assert(trade.qty === 3, 'sync should refresh current quantity');
  assert(trade.maxQtySeen === 3, 'sync should track max quantity seen');

  const profitReason = manager.resolveExitReason({
    pendingExitReason: null,
    liquidation: false,
    realized: 1,
    fallback: null,
  });
  assert(profitReason === 'PROFITLOCK_STOP', 'positive realized exit should classify as profit lock');
}
