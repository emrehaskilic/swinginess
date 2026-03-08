import type { KlineData } from '../backfill/KlineBackfill';

export type StructureBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type SwingLabel = 'HH' | 'HL' | 'LH' | 'LL';
export type SwingKind = 'HIGH' | 'LOW';
export type StructureTimeframe = '1m' | '3m' | '5m';

export interface StructureBar extends KlineData {}

export interface SwingPoint {
  label: SwingLabel;
  kind: SwingKind;
  price: number;
  timestampMs: number;
  timeframe: StructureTimeframe;
  index: number;
}

export interface StructureZone {
  high: number;
  low: number;
  mid: number;
  range: number;
  timeframe: StructureTimeframe;
  formedAtMs: number;
}

export interface StructureAnchors {
  longStopAnchor: number | null;
  shortStopAnchor: number | null;
  longTargetBand: number | null;
  shortTargetBand: number | null;
}

export interface StructureSnapshot {
  enabled: boolean;
  updatedAtMs: number | null;
  freshnessMs: number | null;
  isFresh: boolean;
  bias: StructureBias;
  primaryTimeframe: StructureTimeframe;
  recentClose: number | null;
  recentAtr: number | null;
  sourceBarCount: number;
  zone: StructureZone | null;
  anchors: StructureAnchors;
  bosUp: boolean;
  bosDn: boolean;
  reclaimUp: boolean;
  reclaimDn: boolean;
  continuationLong: boolean;
  continuationShort: boolean;
  lastSwingLabel: SwingLabel | null;
  lastSwingTimestampMs: number | null;
  lastConfirmedHH: SwingPoint | null;
  lastConfirmedHL: SwingPoint | null;
  lastConfirmedLH: SwingPoint | null;
  lastConfirmedLL: SwingPoint | null;
}

export interface CryptoStructureConfig {
  enabled: boolean;
  structureStaleMs: number;
  swingLookback: number;
  zoneLookback: number;
  bosMinAtr: number;
  reclaimTolerancePct: number;
  maxBars: number;
  continuationMaxAgeMs: number;
}

export const DEFAULT_CRYPTO_STRUCTURE_CONFIG: CryptoStructureConfig = {
  enabled: true,
  structureStaleMs: 10 * 60_000,
  swingLookback: 2,
  zoneLookback: 20,
  bosMinAtr: 0.15,
  reclaimTolerancePct: 0.0015,
  maxBars: 720,
  continuationMaxAgeMs: 12 * 60_000,
};

export const EMPTY_STRUCTURE_SNAPSHOT: StructureSnapshot = {
  enabled: false,
  updatedAtMs: null,
  freshnessMs: null,
  isFresh: false,
  bias: 'NEUTRAL',
  primaryTimeframe: '3m',
  recentClose: null,
  recentAtr: null,
  sourceBarCount: 0,
  zone: null,
  anchors: {
    longStopAnchor: null,
    shortStopAnchor: null,
    longTargetBand: null,
    shortTargetBand: null,
  },
  bosUp: false,
  bosDn: false,
  reclaimUp: false,
  reclaimDn: false,
  continuationLong: false,
  continuationShort: false,
  lastSwingLabel: null,
  lastSwingTimestampMs: null,
  lastConfirmedHH: null,
  lastConfirmedHL: null,
  lastConfirmedLH: null,
  lastConfirmedLL: null,
};
