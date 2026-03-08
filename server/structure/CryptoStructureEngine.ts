import type { KlineData } from '../backfill/KlineBackfill';
import { detectSwingState } from './SwingDetector';
import {
  buildZone,
  computeAnchors,
  computeAtr,
  detectBosState,
  determineBias,
} from './ZoneModel';
import {
  CryptoStructureConfig,
  DEFAULT_CRYPTO_STRUCTURE_CONFIG,
  EMPTY_STRUCTURE_SNAPSHOT,
  StructureBar,
  StructureSnapshot,
} from './types';

const ONE_MINUTE_MS = 60_000;
const THREE_MINUTE_MS = 3 * ONE_MINUTE_MS;
const FIVE_MINUTE_MS = 5 * ONE_MINUTE_MS;

function toBucket(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function normalizeBars(rows: KlineData[]): StructureBar[] {
  return rows
    .filter((row) => Number.isFinite(row.timestamp) && row.timestamp > 0)
    .map((row) => ({
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0),
      timestamp: Number(row.timestamp),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function aggregateBars(bars: StructureBar[], bucketMs: number): StructureBar[] {
  if (bars.length === 0) return [];
  const out: StructureBar[] = [];
  let current: StructureBar | null = null;

  for (const bar of bars) {
    const bucket = toBucket(bar.timestamp, bucketMs);
    if (!current || current.timestamp !== bucket) {
      if (current) out.push(current);
      current = {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        timestamp: bucket,
      };
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume += bar.volume;
  }

  if (current) out.push(current);
  return out;
}

export class CryptoStructureEngine {
  private readonly cfg: CryptoStructureConfig;
  private bars1m: StructureBar[] = [];
  private seeded = false;

  constructor(config?: Partial<CryptoStructureConfig>) {
    this.cfg = { ...DEFAULT_CRYPTO_STRUCTURE_CONFIG, ...(config || {}) };
  }

  seedFromKlines(klines: KlineData[]): void {
    const bars = normalizeBars(klines);
    if (bars.length === 0) return;
    this.bars1m = bars.slice(-this.cfg.maxBars);
    this.seeded = true;
  }

  hasSeed(): boolean {
    return this.seeded || this.bars1m.length > 0;
  }

  ingestTrade(input: { timestampMs: number; price: number; quantity?: number }): void {
    const timestampMs = Number(input.timestampMs);
    const price = Number(input.price);
    const quantity = Math.max(0, Number(input.quantity || 0));
    if (!(timestampMs > 0) || !(price > 0)) return;

    const bucket = toBucket(timestampMs, ONE_MINUTE_MS);
    const last = this.bars1m.length > 0 ? this.bars1m[this.bars1m.length - 1] : null;
    if (!last || bucket > last.timestamp) {
      this.bars1m.push({
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        timestamp: bucket,
      });
    } else if (bucket === last.timestamp) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += quantity;
    } else if (last.timestamp > bucket) {
      return;
    }

    if (this.bars1m.length > this.cfg.maxBars) {
      this.bars1m = this.bars1m.slice(this.bars1m.length - this.cfg.maxBars);
    }
  }

  getBars1m(): StructureBar[] {
    return this.bars1m.slice();
  }

  getSnapshot(nowMs?: number, referencePrice?: number | null): StructureSnapshot {
    if (this.bars1m.length === 0) {
      return { ...EMPTY_STRUCTURE_SNAPSHOT };
    }

    const bars3m = aggregateBars(this.bars1m, THREE_MINUTE_MS);
    const bars5m = aggregateBars(this.bars1m, FIVE_MINUTE_MS);
    const primaryBars = bars3m.length >= Math.max(6, this.cfg.swingLookback * 4) ? bars3m : this.bars1m;
    const primaryTimeframe = primaryBars === bars3m ? '3m' : '1m';
    const zoneBars = bars5m.length >= Math.max(4, this.cfg.zoneLookback / 4) ? bars5m : primaryBars;
    const zoneTimeframe = zoneBars === bars5m ? '5m' : primaryTimeframe;
    const lastBar = this.bars1m[this.bars1m.length - 1];
    const evalNowMs = Number.isFinite(nowMs as number) ? Number(nowMs) : lastBar.timestamp;
    const recentClose = Number(referencePrice || primaryBars[primaryBars.length - 1]?.close || 0);
    const recentAtr = computeAtr(primaryBars, 14);
    const swingState = detectSwingState(primaryBars, primaryTimeframe, this.cfg.swingLookback);
    const zone = buildZone(zoneBars, zoneTimeframe, this.cfg.zoneLookback);
    const bosState = detectBosState({
      bars: primaryBars,
      atr: recentAtr,
      zone,
      lastConfirmedHH: swingState.lastConfirmedHH,
      lastConfirmedHL: swingState.lastConfirmedHL,
      lastConfirmedLH: swingState.lastConfirmedLH,
      lastConfirmedLL: swingState.lastConfirmedLL,
      bosMinAtr: this.cfg.bosMinAtr,
      reclaimTolerancePct: this.cfg.reclaimTolerancePct,
      referencePrice: recentClose,
    });
    const anchors = computeAnchors({
      zone,
      lastConfirmedHH: swingState.lastConfirmedHH,
      lastConfirmedHL: swingState.lastConfirmedHL,
      lastConfirmedLH: swingState.lastConfirmedLH,
      lastConfirmedLL: swingState.lastConfirmedLL,
    });
    const bias = determineBias({
      price: recentClose,
      zone,
      bosUp: bosState.bosUp,
      bosDn: bosState.bosDn,
      reclaimUp: bosState.reclaimUp,
      reclaimDn: bosState.reclaimDn,
      lastConfirmedHH: swingState.lastConfirmedHH,
      lastConfirmedHL: swingState.lastConfirmedHL,
      lastConfirmedLH: swingState.lastConfirmedLH,
      lastConfirmedLL: swingState.lastConfirmedLL,
      lastSwingLabel: swingState.lastSwingLabel,
    });
    const updatedAtMs = lastBar.timestamp + ONE_MINUTE_MS;
    const freshnessMs = Math.max(0, evalNowMs - updatedAtMs);
    const lastSwingTimestampMs = swingState.lastSwingTimestampMs;
    const continuationLong = swingState.lastSwingLabel === 'HL'
      && lastSwingTimestampMs != null
      && (evalNowMs - lastSwingTimestampMs) <= this.cfg.continuationMaxAgeMs;
    const continuationShort = swingState.lastSwingLabel === 'LH'
      && lastSwingTimestampMs != null
      && (evalNowMs - lastSwingTimestampMs) <= this.cfg.continuationMaxAgeMs;

    return {
      enabled: this.cfg.enabled || this.seeded,
      updatedAtMs,
      freshnessMs,
      isFresh: freshnessMs <= this.cfg.structureStaleMs,
      bias,
      primaryTimeframe,
      recentClose: recentClose > 0 ? recentClose : null,
      recentAtr,
      sourceBarCount: this.bars1m.length,
      zone,
      anchors,
      bosUp: bosState.bosUp,
      bosDn: bosState.bosDn,
      reclaimUp: bosState.reclaimUp,
      reclaimDn: bosState.reclaimDn,
      continuationLong,
      continuationShort,
      lastSwingLabel: swingState.lastSwingLabel,
      lastSwingTimestampMs: swingState.lastSwingTimestampMs,
      lastConfirmedHH: swingState.lastConfirmedHH,
      lastConfirmedHL: swingState.lastConfirmedHL,
      lastConfirmedLH: swingState.lastConfirmedLH,
      lastConfirmedLL: swingState.lastConfirmedLL,
    };
  }
}
