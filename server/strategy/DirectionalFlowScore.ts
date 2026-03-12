import { NormalizationStore, DualNormalizationStore } from './Normalization';

const EPS = 1e-12;

type BurstSide = 'buy' | 'sell' | null;

export interface DirectionalFlowInput {
  deltaZ: number;
  cvdSlope: number;
  obiWeighted: number;
  obiDeep: number;
  sweepStrength: number;
  burstCount: number;
  burstSide: BurstSide;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  oiChangePct: number;
  price: number;
  prevPrice: number | null;
  prevCvd: number | null;
  nowMs: number;
  // V12: OI Dynamic Weight — regime hint + OI data freshness
  regime?: 'TR' | 'MR' | 'EV';
  oiLastUpdatedMs?: number;
  oiDynamicWeightMR?: number;  // target w8 in MR regime (default 0.20)
  oiStalenessMaxMs?: number;   // max age for OI data to be considered fresh (default 10_000)
}

export interface DirectionalFlowOutput {
  dfs: number;
  dfsPercentile: number;
  components: Record<string, number>;
}

export interface DirectionalFlowWeights {
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  w6: number;
  w7: number;
  w8: number;
}

const DEFAULT_WEIGHTS: DirectionalFlowWeights = {
  w1: 0.22,
  w2: 0.18,
  w3: 0.12,
  w4: 0.14,
  w5: 0.12,
  w6: 0.08,
  w7: 0.08,
  w8: 0.06,
};

// ---------------------------------------------------------------------------
// Adaptive weight update state
// ---------------------------------------------------------------------------

/** Tracks how predictive each DFS component was over recent closed trades */
interface ComponentPerformanceRecord {
  /** signed component value at entry (positive = bullish, negative = bearish) */
  entrySignedValue: number;
  /** realized PnL as signed fraction (positive = profit, negative = loss) */
  pnlFraction: number;
}

export class DirectionalFlowScore {
  private readonly norm: NormalizationStore;
  private readonly dualNorm: DualNormalizationStore | null;
  private readonly weights: DirectionalFlowWeights;

  // Adaptive weight learning rate (EMA alpha)
  private readonly EMA_ALPHA = 0.08;
  // Minimum/maximum weight bounds
  private readonly W_MIN = 0.02;
  private readonly W_MAX = 0.40;

  // Recent component-to-pnl records for EMA update
  private readonly perfHistory: Record<keyof DirectionalFlowWeights, ComponentPerformanceRecord[]> = {
    w1: [], w2: [], w3: [], w4: [], w5: [], w6: [], w7: [], w8: [],
  };
  private readonly PERF_WINDOW = 30; // last 30 trades

  // Last computed components (preserved for post-trade feedback)
  private lastComponents: Record<string, number> = {};

  constructor(norm: NormalizationStore, weights?: Partial<DirectionalFlowWeights>, dualNorm?: DualNormalizationStore) {
    this.norm = norm;
    this.dualNorm = dualNorm ?? null;
    this.weights = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  }

  /**
   * Call this after a position is closed to update component weights via EMA.
   *
   * @param side        - position side ('LONG' | 'SHORT')
   * @param pnlFraction - realized PnL as fraction (e.g. 0.015 = +1.5%, -0.008 = -0.8%)
   *
   * Logic:
   *  - For each component, compare its signed value at entry to the trade outcome.
   *  - If component was aligned with profitable direction → weight++
   *  - If component was misaligned or trade was losing → weight--
   *  - Weights are re-normalized to sum to 1 after each update.
   */
  updateWeightsFromTrade(side: 'LONG' | 'SHORT', pnlFraction: number): void {
    const keys: (keyof DirectionalFlowWeights)[] = ['w1','w2','w3','w4','w5','w6','w7','w8'];
    const componentKeys: Record<keyof DirectionalFlowWeights, string> = {
      w1: 'zDelta', w2: 'zCvd', w3: 'zLogP', w4: 'zObiW',
      w5: 'zObiD', w6: 'sweepSigned', w7: 'burstSigned', w8: 'oiImpulse',
    };
    const dirMult = side === 'LONG' ? 1 : -1;

    for (const wk of keys) {
      const compName = componentKeys[wk];
      const rawVal = this.lastComponents[compName] ?? 0;
      const signedVal = dirMult * rawVal; // positive = aligned with position direction

      const record: ComponentPerformanceRecord = {
        entrySignedValue: signedVal,
        pnlFraction,
      };
      this.perfHistory[wk].push(record);
      if (this.perfHistory[wk].length > this.PERF_WINDOW) {
        this.perfHistory[wk].shift();
      }
    }

    // Compute predictive quality per component: avg(sign(entry) * sign(pnl))
    const predictiveScores: Record<keyof DirectionalFlowWeights, number> = {} as any;
    for (const wk of keys) {
      const records = this.perfHistory[wk];
      if (records.length === 0) {
        predictiveScores[wk] = 0;
        continue;
      }
      const score = records.reduce((sum, r) => {
        const align = Math.sign(r.entrySignedValue) * Math.sign(r.pnlFraction);
        return sum + align;
      }, 0) / records.length; // range [-1, 1]
      predictiveScores[wk] = score;
    }

    // EMA update: if component was predictive (score > 0) → slightly increase weight
    for (const wk of keys) {
      const delta = this.EMA_ALPHA * predictiveScores[wk] * DEFAULT_WEIGHTS[wk];
      const newWeight = Math.max(this.W_MIN, Math.min(this.W_MAX, this.weights[wk] + delta));
      this.weights[wk] = newWeight;
    }

    // Re-normalize so weights sum to 1
    const total = keys.reduce((s, k) => s + this.weights[k], 0);
    if (total > EPS) {
      for (const wk of keys) {
        this.weights[wk] = this.weights[wk] / total;
      }
    }
  }

  /** Returns a snapshot of current adaptive weights (for logging/monitoring) */
  getCurrentWeights(): DirectionalFlowWeights {
    return { ...this.weights };
  }

  compute(input: DirectionalFlowInput): DirectionalFlowOutput {
    const pressure = input.aggressiveBuyVolume / (input.aggressiveSellVolume + EPS);
    const logP = Math.log(Math.max(EPS, pressure));

    // Always feed the legacy single-window store (backward compat + RegimeSelector uses it)
    this.norm.update('deltaZ', input.deltaZ, input.nowMs);
    this.norm.update('cvdSlope', input.cvdSlope, input.nowMs);
    this.norm.update('logP', logP, input.nowMs);
    this.norm.update('obiWeighted', input.obiWeighted, input.nowMs);
    this.norm.update('obiDeep', input.obiDeep, input.nowMs);
    this.norm.update('sweepStrength', Math.abs(input.sweepStrength), input.nowMs);
    this.norm.update('burstCount', input.burstCount, input.nowMs);
    this.norm.update('oiChangePct', input.oiChangePct, input.nowMs);

    // V12: Feed dual normalization store (micro + macro) when available
    if (this.dualNorm) {
      this.dualNorm.update('deltaZ', input.deltaZ, input.nowMs);
      this.dualNorm.update('cvdSlope', input.cvdSlope, input.nowMs);
      this.dualNorm.update('logP', logP, input.nowMs);
      this.dualNorm.update('obiWeighted', input.obiWeighted, input.nowMs);
      this.dualNorm.update('obiDeep', input.obiDeep, input.nowMs);
      this.dualNorm.update('sweepStrength', Math.abs(input.sweepStrength), input.nowMs);
      this.dualNorm.update('burstCount', input.burstCount, input.nowMs);
      this.dualNorm.update('oiChangePct', input.oiChangePct, input.nowMs);
    }

    // V12: Use micro z-scores for entry-signal components (responsive, 5min window)
    // Fall back to legacy single-window store when dual is not available
    const microNorm = this.dualNorm?.micro ?? this.norm;
    const macroNorm = this.dualNorm?.macro ?? this.norm;

    const zDelta = input.deltaZ;
    const zCvd = microNorm.zScore('cvdSlope', input.cvdSlope);
    const zLogP = microNorm.zScore('logP', logP);
    const zObiW = microNorm.zScore('obiWeighted', input.obiWeighted);
    const zObiD = microNorm.zScore('obiDeep', input.obiDeep);

    const sweepP = microNorm.percentile('sweepStrength', Math.abs(input.sweepStrength));
    const sweepSigned = Math.sign(input.sweepStrength || 0) * sweepP;

    const burstP = microNorm.percentile('burstCount', input.burstCount);
    const burstSigned = (input.burstSide === 'buy' ? 1 : input.burstSide === 'sell' ? -1 : 0) * burstP;

    const priceChange = input.prevPrice !== null ? input.price - input.prevPrice : 0;
    const cvdChange = input.prevCvd !== null ? input.cvdSlope - input.prevCvd : 0;
    const oiZ = microNorm.zScore('oiChangePct', input.oiChangePct);
    const oiImpulse = Math.sign(priceChange || 0) * Math.sign(cvdChange || 0) * oiZ;

    // V12: OI Dynamic Weight — boost w8 in MR regime when OI data is fresh
    let effectiveW8 = this.weights.w8;
    if (input.regime === 'MR' && input.oiLastUpdatedMs != null) {
      const oiAge = input.nowMs - input.oiLastUpdatedMs;
      const maxStale = input.oiStalenessMaxMs ?? 10_000;
      if (oiAge < maxStale && Math.abs(input.oiChangePct) > 0) {
        effectiveW8 = input.oiDynamicWeightMR ?? 0.20;
      }
    }

    // Re-normalize weights on the fly when w8 is boosted
    const w8Delta = effectiveW8 - this.weights.w8;
    const scale = w8Delta !== 0 ? (1 - effectiveW8) / (1 - this.weights.w8 + EPS) : 1;

    const dfs =
      (this.weights.w1 * scale * zDelta) +
      (this.weights.w2 * scale * zCvd) +
      (this.weights.w3 * scale * zLogP) +
      (this.weights.w4 * scale * zObiW) +
      (this.weights.w5 * scale * zObiD) +
      (this.weights.w6 * scale * sweepSigned) +
      (this.weights.w7 * scale * burstSigned) +
      (effectiveW8 * oiImpulse);

    // V12: DFS percentile uses macro window (stable, 60min) for trend detection
    this.norm.update('dfs', dfs, input.nowMs);
    if (this.dualNorm) {
      this.dualNorm.update('dfs', dfs, input.nowMs);
    }
    const dfsPercentile = macroNorm.percentile('dfs', dfs);

    const components = {
      zDelta,
      zCvd,
      zLogP,
      zObiW,
      zObiD,
      sweepSigned,
      burstSigned,
      oiImpulse,
    };

    // Preserve for adaptive weight feedback after trade close
    this.lastComponents = components;

    return { dfs, dfsPercentile, components };
  }
}
