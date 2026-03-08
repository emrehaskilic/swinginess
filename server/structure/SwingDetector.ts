import type { StructureBar, StructureTimeframe, SwingPoint } from './types';

export interface SwingState {
  swings: SwingPoint[];
  lastSwingLabel: SwingPoint['label'] | null;
  lastSwingTimestampMs: number | null;
  lastConfirmedHH: SwingPoint | null;
  lastConfirmedHL: SwingPoint | null;
  lastConfirmedLH: SwingPoint | null;
  lastConfirmedLL: SwingPoint | null;
}

function clampLookback(lookback: number): number {
  if (!Number.isFinite(lookback)) return 2;
  return Math.max(1, Math.min(10, Math.trunc(lookback)));
}

function isPivotHigh(bars: StructureBar[], index: number, lookback: number): boolean {
  const center = bars[index]?.high;
  if (!(center > 0)) return false;
  for (let offset = 1; offset <= lookback; offset += 1) {
    const left = bars[index - offset]?.high;
    const right = bars[index + offset]?.high;
    if (!(center > Number(left))) return false;
    if (!(center >= Number(right))) return false;
  }
  return true;
}

function isPivotLow(bars: StructureBar[], index: number, lookback: number): boolean {
  const center = bars[index]?.low;
  if (!(center > 0)) return false;
  for (let offset = 1; offset <= lookback; offset += 1) {
    const left = bars[index - offset]?.low;
    const right = bars[index + offset]?.low;
    if (!(center < Number(left))) return false;
    if (!(center <= Number(right))) return false;
  }
  return true;
}

export function detectSwingState(
  bars: StructureBar[],
  timeframe: StructureTimeframe,
  lookbackRaw: number,
): SwingState {
  const lookback = clampLookback(lookbackRaw);
  const swings: SwingPoint[] = [];
  let prevHigh: number | null = null;
  let prevLow: number | null = null;

  if (bars.length < ((lookback * 2) + 1)) {
    return {
      swings,
      lastSwingLabel: null,
      lastSwingTimestampMs: null,
      lastConfirmedHH: null,
      lastConfirmedHL: null,
      lastConfirmedLH: null,
      lastConfirmedLL: null,
    };
  }

  for (let index = lookback; index < (bars.length - lookback); index += 1) {
    const bar = bars[index];
    if (!bar) continue;

    if (isPivotHigh(bars, index, lookback)) {
      const label = prevHigh == null || bar.high >= prevHigh ? 'HH' : 'LH';
      prevHigh = bar.high;
      swings.push({
        label,
        kind: 'HIGH',
        price: bar.high,
        timestampMs: bar.timestamp,
        timeframe,
        index,
      });
    }

    if (isPivotLow(bars, index, lookback)) {
      const label = prevLow == null || bar.low >= prevLow ? 'HL' : 'LL';
      prevLow = bar.low;
      swings.push({
        label,
        kind: 'LOW',
        price: bar.low,
        timestampMs: bar.timestamp,
        timeframe,
        index,
      });
    }
  }

  swings.sort((left, right) => left.timestampMs - right.timestampMs);

  const lastConfirmedHH = [...swings].reverse().find((swing) => swing.label === 'HH') ?? null;
  const lastConfirmedHL = [...swings].reverse().find((swing) => swing.label === 'HL') ?? null;
  const lastConfirmedLH = [...swings].reverse().find((swing) => swing.label === 'LH') ?? null;
  const lastConfirmedLL = [...swings].reverse().find((swing) => swing.label === 'LL') ?? null;
  const lastSwing = swings.length > 0 ? swings[swings.length - 1] : null;

  return {
    swings,
    lastSwingLabel: lastSwing?.label ?? null,
    lastSwingTimestampMs: lastSwing?.timestampMs ?? null,
    lastConfirmedHH,
    lastConfirmedHL,
    lastConfirmedLH,
    lastConfirmedLL,
  };
}
