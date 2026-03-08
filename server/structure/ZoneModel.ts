import type { StructureAnchors, StructureBar, StructureBias, StructureTimeframe, StructureZone, SwingPoint } from './types';

export interface BosState {
  bosUp: boolean;
  bosDn: boolean;
  reclaimUp: boolean;
  reclaimDn: boolean;
}

function clampLookback(lookback: number): number {
  if (!Number.isFinite(lookback)) return 20;
  return Math.max(4, Math.min(200, Math.trunc(lookback)));
}

export function computeAtr(bars: StructureBar[], period = 14): number | null {
  if (bars.length < 2) return null;
  const trSeries: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const prevClose = bars[index - 1].close;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    );
    if (Number.isFinite(tr)) trSeries.push(tr);
  }
  const window = trSeries.slice(-Math.max(2, Math.min(200, Math.trunc(period))));
  if (window.length === 0) return null;
  const sum = window.reduce((acc, value) => acc + value, 0);
  return sum / window.length;
}

export function buildZone(
  bars: StructureBar[],
  timeframe: StructureTimeframe,
  lookbackRaw: number,
): StructureZone | null {
  const lookback = clampLookback(lookbackRaw);
  const window = bars.slice(-lookback);
  if (window.length < 2) return null;

  let high = -Infinity;
  let low = Infinity;
  for (const bar of window) {
    high = Math.max(high, Number(bar.high || 0));
    low = Math.min(low, Number(bar.low || 0));
  }
  if (!(high > low)) return null;
  const range = high - low;
  return {
    high,
    low,
    mid: low + (range / 2),
    range,
    timeframe,
    formedAtMs: window[window.length - 1].timestamp,
  };
}

export function detectBosState(input: {
  bars: StructureBar[];
  atr: number | null;
  zone: StructureZone | null;
  lastConfirmedHH: SwingPoint | null;
  lastConfirmedHL: SwingPoint | null;
  lastConfirmedLH: SwingPoint | null;
  lastConfirmedLL: SwingPoint | null;
  bosMinAtr: number;
  reclaimTolerancePct: number;
  referencePrice?: number | null;
}): BosState {
  const bars = input.bars;
  if (bars.length < 2) {
    return { bosUp: false, bosDn: false, reclaimUp: false, reclaimDn: false };
  }
  const latest = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const latestClose = Number(input.referencePrice || latest.close || 0);
  const previousClose = Number(previous.close || 0);
  const atr = Math.max(0, Number(input.atr || 0));
  const bosPadding = atr > 0 ? atr * Math.max(0, Number(input.bosMinAtr || 0)) : 0;

  const upperBreakLevel = input.lastConfirmedLH?.price
    ?? input.lastConfirmedHH?.price
    ?? input.zone?.high
    ?? null;
  const lowerBreakLevel = input.lastConfirmedHL?.price
    ?? input.lastConfirmedLL?.price
    ?? input.zone?.low
    ?? null;

  const bosUp = upperBreakLevel != null && latestClose > (upperBreakLevel + bosPadding);
  const bosDn = lowerBreakLevel != null && latestClose < (lowerBreakLevel - bosPadding);

  let reclaimUp = false;
  let reclaimDn = false;
  const zone = input.zone;
  if (zone && zone.mid > 0) {
    const tolerance = zone.mid * Math.max(0, Number(input.reclaimTolerancePct || 0));
    reclaimUp = previousClose < (zone.mid - tolerance) && latestClose >= (zone.mid - (tolerance * 0.25));
    reclaimDn = previousClose > (zone.mid + tolerance) && latestClose <= (zone.mid + (tolerance * 0.25));
  }

  return { bosUp, bosDn, reclaimUp, reclaimDn };
}

export function computeAnchors(input: {
  zone: StructureZone | null;
  lastConfirmedHH: SwingPoint | null;
  lastConfirmedHL: SwingPoint | null;
  lastConfirmedLH: SwingPoint | null;
  lastConfirmedLL: SwingPoint | null;
}): StructureAnchors {
  const zone = input.zone;
  const longStopAnchor = input.lastConfirmedHL?.price ?? zone?.low ?? null;
  const shortStopAnchor = input.lastConfirmedLH?.price ?? zone?.high ?? null;

  const longTargetBand = input.lastConfirmedHH?.price
    ?? (zone ? zone.high + (zone.range * 0.5) : null);
  const shortTargetBand = input.lastConfirmedLL?.price
    ?? (zone ? zone.low - (zone.range * 0.5) : null);

  return {
    longStopAnchor,
    shortStopAnchor,
    longTargetBand,
    shortTargetBand,
  };
}

export function determineBias(input: {
  price: number | null;
  zone: StructureZone | null;
  bosUp: boolean;
  bosDn: boolean;
  reclaimUp: boolean;
  reclaimDn: boolean;
  lastConfirmedHH: SwingPoint | null;
  lastConfirmedHL: SwingPoint | null;
  lastConfirmedLH: SwingPoint | null;
  lastConfirmedLL: SwingPoint | null;
  lastSwingLabel: SwingPoint['label'] | null;
}): StructureBias {
  if (input.bosUp || input.reclaimUp) return 'BULLISH';
  if (input.bosDn || input.reclaimDn) return 'BEARISH';

  const price = Number(input.price || 0);
  const zone = input.zone;
  if (zone && price > 0) {
    if (price >= zone.mid && (input.lastSwingLabel === 'HL' || input.lastSwingLabel === 'HH')) {
      return 'BULLISH';
    }
    if (price <= zone.mid && (input.lastSwingLabel === 'LH' || input.lastSwingLabel === 'LL')) {
      return 'BEARISH';
    }
  }

  if (input.lastConfirmedHL && input.lastConfirmedHH && (!input.lastConfirmedLH || input.lastConfirmedHL.timestampMs >= input.lastConfirmedLH.timestampMs)) {
    return 'BULLISH';
  }
  if (input.lastConfirmedLH && input.lastConfirmedLL && (!input.lastConfirmedHL || input.lastConfirmedLH.timestampMs >= input.lastConfirmedHL.timestampMs)) {
    return 'BEARISH';
  }
  return 'NEUTRAL';
}
