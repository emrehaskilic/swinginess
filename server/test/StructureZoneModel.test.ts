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

import type { StructureBar, SwingPoint } from '../structure/types';
import {
  buildZone,
  computeAnchors,
  computeAtr,
  detectBosState,
  determineBias,
} from '../structure/ZoneModel';

function swing(label: SwingPoint['label'], kind: SwingPoint['kind'], price: number, timestampMs: number): SwingPoint {
  return { label, kind, price, timestampMs, timeframe: '1m', index: 0 };
}

export function runTests() {
  const atrBars: StructureBar[] = [
    { timestamp: 60_000, open: 100, high: 102, low: 99, close: 101, volume: 10 },
    { timestamp: 120_000, open: 101, high: 103, low: 100, close: 102, volume: 11 },
    { timestamp: 180_000, open: 102, high: 104, low: 98, close: 103, volume: 12 },
    { timestamp: 240_000, open: 103, high: 105, low: 101, close: 104, volume: 13 },
  ];
  assertNear(computeAtr(atrBars, 14), (3 + 6 + 4) / 3, 1e-9, 'ATR should average true range over the available window');

  const zone = buildZone(atrBars, '5m', 4);
  assert(zone != null, 'zone should build with enough bars');
  assertNear(zone?.high ?? null, 105, 1e-9, 'zone high should use the highest high');
  assertNear(zone?.low ?? null, 98, 1e-9, 'zone low should use the lowest low');
  assertNear(zone?.mid ?? null, 101.5, 1e-9, 'zone midpoint should bisect the range');

  const bosBars: StructureBar[] = [
    { timestamp: 60_000, open: 100, high: 102, low: 99, close: 101, volume: 10 },
    { timestamp: 120_000, open: 101, high: 103, low: 100, close: 102, volume: 10 },
    { timestamp: 180_000, open: 102, high: 104, low: 98, close: 99, volume: 10 },
    { timestamp: 240_000, open: 99, high: 106, low: 100, close: 106, volume: 10 },
  ];
  const bosState = detectBosState({
    bars: bosBars,
    atr: 4,
    zone,
    lastConfirmedHH: swing('HH', 'HIGH', 104, 180_000),
    lastConfirmedHL: swing('HL', 'LOW', 98, 180_000),
    lastConfirmedLH: null,
    lastConfirmedLL: null,
    bosMinAtr: 0.25,
    reclaimTolerancePct: 0.002,
    referencePrice: 106,
  });
  assert(bosState.bosUp === true, 'close above swing high plus ATR padding should flag bullish BOS');
  assert(bosState.bosDn === false, 'bullish BOS scenario should not flag bearish BOS');

  const reclaimBars: StructureBar[] = [
    { timestamp: 60_000, open: 100, high: 101, low: 99, close: 99.1, volume: 10 },
    { timestamp: 120_000, open: 99.1, high: 100.4, low: 98.9, close: 99.95, volume: 10 },
  ];
  const reclaimZone = {
    high: 101,
    low: 99,
    mid: 100,
    range: 2,
    timeframe: '5m' as const,
    formedAtMs: 120_000,
  };
  const reclaimState = detectBosState({
    bars: reclaimBars,
    atr: 1.2,
    zone: reclaimZone,
    lastConfirmedHH: null,
    lastConfirmedHL: null,
    lastConfirmedLH: null,
    lastConfirmedLL: null,
    bosMinAtr: 0.25,
    reclaimTolerancePct: 0.005,
    referencePrice: 99.95,
  });
  assert(reclaimState.reclaimUp === true, 'crossing back above the zone midpoint should flag bullish reclaim');
  assert(reclaimState.reclaimDn === false, 'bullish reclaim case should not flag bearish reclaim');

  const anchors = computeAnchors({
    zone,
    lastConfirmedHH: swing('HH', 'HIGH', 105, 240_000),
    lastConfirmedHL: swing('HL', 'LOW', 99, 180_000),
    lastConfirmedLH: swing('LH', 'HIGH', 103, 210_000),
    lastConfirmedLL: swing('LL', 'LOW', 97, 120_000),
  });
  assertNear(anchors.longStopAnchor, 99, 1e-9, 'long stop anchor should prefer confirmed HL');
  assertNear(anchors.shortStopAnchor, 103, 1e-9, 'short stop anchor should prefer confirmed LH');
  assertNear(anchors.longTargetBand, 105, 1e-9, 'long target band should prefer confirmed HH');
  assertNear(anchors.shortTargetBand, 97, 1e-9, 'short target band should prefer confirmed LL');

  const bias = determineBias({
    price: 106,
    zone,
    bosUp: true,
    bosDn: false,
    reclaimUp: false,
    reclaimDn: false,
    lastConfirmedHH: swing('HH', 'HIGH', 105, 240_000),
    lastConfirmedHL: swing('HL', 'LOW', 99, 180_000),
    lastConfirmedLH: null,
    lastConfirmedLL: null,
    lastSwingLabel: 'HH',
  });
  assert(bias === 'BULLISH', 'bullish BOS should dominate bias selection');
}
