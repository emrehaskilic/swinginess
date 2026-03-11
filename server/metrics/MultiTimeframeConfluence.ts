/**
 * MultiTimeframeConfluence
 *
 * Aggregates directional bias signals from multiple timeframes into a single
 * confluence score, reducing false breakout signals from noisy lower TFs.
 *
 * Timeframes and weights (configurable, defaults):
 *   4h  → 0.50  (macro regime / dominant trend)
 *   1h  → 0.30  (intermediate swing structure)
 *   15m → 0.20  (entry timing precision)
 *
 * Usage:
 *   1. Call `update('4h' | '1h' | '15m', bias)` whenever a new candle closes
 *      or when HTF bias is re-derived.
 *   2. Call `getConfluence()` in the entry decision to get scores.
 *   3. Block entries where confluenceScore < minConfluenceThreshold.
 *
 * Confluence score range: -1 (full bear alignment) to +1 (full bull alignment)
 * Long entry recommended: longScore > threshold (e.g. 0.50 = 2+ TFs agree)
 * Short entry recommended: shortScore > threshold
 */

export type MtfBias = 'UP' | 'DOWN' | 'NEUTRAL';
export type MtfTimeframe = '15m' | '1h' | '4h';

export interface MtfSignal {
  timeframe: MtfTimeframe;
  bias: MtfBias;
  updatedAtMs: number;
}

export interface MtfConfluenceResult {
  /** Weighted sum in [-1, +1]: +1 = all TFs bullish */
  score: number;
  /** 0-1: how strongly biased toward LONG */
  longScore: number;
  /** 0-1: how strongly biased toward SHORT */
  shortScore: number;
  /** Overall alignment confidence (0 = no signal, 1 = all TFs agree) */
  confidence: number;
  /** Dominant direction based on score */
  dominant: 'LONG' | 'SHORT' | 'NEUTRAL';
  /** Per-timeframe snapshot */
  signals: MtfSignal[];
  /** True if any signal is stale beyond staleness threshold */
  hasStaleSignal: boolean;
  timestampMs: number;
}

export interface MtfConfluenceConfig {
  /** Weight per timeframe (must sum to 1.0) */
  weights: Record<MtfTimeframe, number>;
  /** Ms after which a signal is considered stale (default: 4h for 4h TF, 1h for 1h, 15m for 15m) */
  staleMs: Record<MtfTimeframe, number>;
  /** Minimum score magnitude to emit a non-NEUTRAL dominant (default 0.30) */
  neutralDeadband: number;
}

const DEFAULT_CONFIG: MtfConfluenceConfig = {
  weights: {
    '4h':  0.50,
    '1h':  0.30,
    '15m': 0.20,
  },
  staleMs: {
    '4h':  4 * 60 * 60 * 1000,      // 4 hours
    '1h':  90 * 60 * 1000,           // 90 minutes
    '15m': 30 * 60 * 1000,           // 30 minutes
  },
  neutralDeadband: 0.30,
};

function biasToScore(bias: MtfBias): number {
  if (bias === 'UP')   return 1;
  if (bias === 'DOWN') return -1;
  return 0;
}

export class MultiTimeframeConfluence {
  private readonly cfg: MtfConfluenceConfig;
  private readonly signals = new Map<MtfTimeframe, MtfSignal>();

  constructor(config?: Partial<MtfConfluenceConfig>) {
    this.cfg = {
      ...DEFAULT_CONFIG,
      ...(config ?? {}),
      weights: { ...DEFAULT_CONFIG.weights, ...(config?.weights ?? {}) },
      staleMs: { ...DEFAULT_CONFIG.staleMs, ...(config?.staleMs ?? {}) },
    };
  }

  // ---------------------------------------------------------------------------
  // Ingest a new bias reading for a timeframe
  // ---------------------------------------------------------------------------

  update(timeframe: MtfTimeframe, bias: MtfBias, nowMs?: number): void {
    this.signals.set(timeframe, {
      timeframe,
      bias,
      updatedAtMs: nowMs ?? Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Compute confluence at the current moment
  // ---------------------------------------------------------------------------

  getConfluence(nowMs?: number): MtfConfluenceResult {
    const ts = nowMs ?? Date.now();
    const tfs: MtfTimeframe[] = ['4h', '1h', '15m'];

    let weightedScore = 0;
    let totalWeight = 0;
    let hasStaleSignal = false;
    const signals: MtfSignal[] = [];

    for (const tf of tfs) {
      const sig = this.signals.get(tf);
      const weight = this.cfg.weights[tf];

      if (!sig) {
        // No data yet — treat as NEUTRAL, partial staleness
        hasStaleSignal = true;
        signals.push({ timeframe: tf, bias: 'NEUTRAL', updatedAtMs: 0 });
        totalWeight += weight;
        continue;
      }

      const age = ts - sig.updatedAtMs;
      const isStale = age > this.cfg.staleMs[tf];
      if (isStale) hasStaleSignal = true;

      // Stale signals decay toward NEUTRAL linearly over 2× staleMs
      let effectiveScore = biasToScore(sig.bias);
      if (isStale) {
        const decay = Math.max(0, 1 - (age - this.cfg.staleMs[tf]) / this.cfg.staleMs[tf]);
        effectiveScore *= decay;
      }

      weightedScore += weight * effectiveScore;
      totalWeight += weight;
      signals.push({ ...sig });
    }

    const normalised = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const score = Math.max(-1, Math.min(1, normalised));

    // longScore / shortScore: one-sided 0-1 values
    const longScore  = Math.max(0, score);
    const shortScore = Math.max(0, -score);

    // Confidence: how much all TFs agree (0 = mixed, 1 = perfectly aligned)
    const absScore = Math.abs(score);
    const confidence = absScore;

    let dominant: 'LONG' | 'SHORT' | 'NEUTRAL';
    if (score >= this.cfg.neutralDeadband) {
      dominant = 'LONG';
    } else if (score <= -this.cfg.neutralDeadband) {
      dominant = 'SHORT';
    } else {
      dominant = 'NEUTRAL';
    }

    return {
      score,
      longScore,
      shortScore,
      confidence,
      dominant,
      signals,
      hasStaleSignal,
      timestampMs: ts,
    };
  }

  // ---------------------------------------------------------------------------
  // Convenience entry filter
  // ---------------------------------------------------------------------------

  /** Returns true if the desired side is supported by MTF confluence */
  allowEntry(side: 'LONG' | 'SHORT', minLongScore = 0.30, minShortScore = 0.30, nowMs?: number): boolean {
    const r = this.getConfluence(nowMs);
    if (side === 'LONG')  return r.longScore  >= minLongScore;
    if (side === 'SHORT') return r.shortScore >= minShortScore;
    return false;
  }

  /** True if any timeframe has been updated */
  hasAnySignal(): boolean {
    return this.signals.size > 0;
  }

  /** Reset all signals */
  reset(): void {
    this.signals.clear();
  }
}
