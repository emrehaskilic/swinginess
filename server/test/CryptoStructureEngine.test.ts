function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNear(actual: number | null, expected: number, epsilon: number, message: string): void {
  if (actual == null || Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}. expected=${expected}, actual=${actual}`);
  }
}

import type { KlineData } from '../backfill/KlineBackfill';
import { CryptoStructureEngine } from '../structure/CryptoStructureEngine';

const ONE_MINUTE_MS = 60_000;

function buildKlines(): KlineData[] {
  return [
    { timestamp: ONE_MINUTE_MS * 1, open: 100, high: 101, low: 99, close: 100, volume: 10 },
    { timestamp: ONE_MINUTE_MS * 2, open: 100, high: 102, low: 100, close: 101, volume: 11 },
    { timestamp: ONE_MINUTE_MS * 3, open: 101, high: 104, low: 101, close: 103, volume: 12 },
    { timestamp: ONE_MINUTE_MS * 4, open: 103, high: 103, low: 98, close: 99, volume: 13 },
    { timestamp: ONE_MINUTE_MS * 5, open: 99, high: 105, low: 100, close: 104, volume: 14 },
    { timestamp: ONE_MINUTE_MS * 6, open: 104, high: 104, low: 102, close: 103, volume: 15 },
    { timestamp: ONE_MINUTE_MS * 7, open: 103, high: 103.5, low: 102.5, close: 103, volume: 16 },
    { timestamp: ONE_MINUTE_MS * 8, open: 103, high: 104, low: 101.5, close: 103.5, volume: 17 },
    { timestamp: ONE_MINUTE_MS * 9, open: 103.5, high: 106, low: 103, close: 105, volume: 18 },
    { timestamp: ONE_MINUTE_MS * 10, open: 105, high: 109, low: 104, close: 108, volume: 19 },
  ];
}

export function runTests() {
  const engine = new CryptoStructureEngine({
    enabled: true,
    swingLookback: 1,
    zoneLookback: 6,
    bosMinAtr: 0.05,
    reclaimTolerancePct: 0.0005,
    structureStaleMs: 5 * ONE_MINUTE_MS,
    continuationMaxAgeMs: 10 * ONE_MINUTE_MS,
  });

  const klines = buildKlines();
  engine.seedFromKlines(klines);
  assert(engine.hasSeed(), 'engine should report seeded state after historical seed');

  const freshSnapshot = engine.getSnapshot((ONE_MINUTE_MS * 11) - 1, 108);
  assert(freshSnapshot.enabled === true, 'seeded engine should produce enabled snapshots');
  assert(freshSnapshot.primaryTimeframe === '1m', 'short seed should stay on 1m primary timeframe');
  assert(freshSnapshot.bias === 'BULLISH', 'snapshot bias should turn bullish after BOS up');
  assert(freshSnapshot.bosUp === true, 'latest close should confirm bullish BOS');
  assert(freshSnapshot.bosDn === false, 'bullish seed should not also flag bearish BOS');
  assert(freshSnapshot.continuationLong === true, 'latest confirmed HL should arm long continuation');
  assert(freshSnapshot.lastSwingLabel === 'HL', 'last confirmed swing should be HL before breakout bar');
  assertNear(freshSnapshot.anchors.longStopAnchor, 101.5, 1e-9, 'long stop anchor should use latest confirmed HL');
  assertNear(freshSnapshot.anchors.longTargetBand, 105, 1e-9, 'long target band should use latest confirmed HH');
  assert(freshSnapshot.sourceBarCount === klines.length, 'source bar count should reflect seeded bars');

  const staleSnapshot = engine.getSnapshot(ONE_MINUTE_MS * 20, 108);
  assert(staleSnapshot.isFresh === false, 'snapshot should turn stale after configured freshness window');
  assert(staleSnapshot.freshnessMs != null && staleSnapshot.freshnessMs > (5 * ONE_MINUTE_MS), 'staleness should report positive freshness age');
}
