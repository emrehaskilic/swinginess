import { NormalizationStore } from './Normalization';

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

  constructor(norm: NormalizationStore, weights?: Partial<DirectionalFlowWeights>) {
    this.norm = norm;
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

    this.norm.update('deltaZ', input.deltaZ, input.nowMs);
    this.norm.update('cvdSlope', input.cvdSlope, input.nowMs);
    this.norm.update('logP', logP, input.nowMs);
    this.norm.update('obiWeighted', input.obiWeighted, input.nowMs);
    this.norm.update('obiDeep', input.obiDeep, input.nowMs);
    this.norm.update('sweepStrength', Math.abs(input.sweepStrength), input.nowMs);
    this.norm.update('burstCount', input.burstCount, input.nowMs);
    this.norm.update('oiChangePct', input.oiChangePct, input.nowMs);

    const zDelta = input.deltaZ;
    const zCvd = this.norm.zScore('cvdSlope', input.cvdSlope);
    const zLogP = this.norm.zScore('logP', logP);
    const zObiW = this.norm.zScore('obiWeighted', input.obiWeighted);
    const zObiD = this.norm.zScore('obiDeep', input.obiDeep);

    const sweepP = this.norm.percentile('sweepStrength', Math.abs(input.sweepStrength));
    const sweepSigned = Math.sign(input.sweepStrength || 0) * sweepP;

    const burstP = this.norm.percentile('burstCount', input.burstCount);
    const burstSigned = (input.burstSide === 'buy' ? 1 : input.burstSide === 'sell' ? -1 : 0) * burstP;

    const priceChange = input.prevPrice !== null ? input.price - input.prevPrice : 0;
    const cvdChange = input.prevCvd !== null ? input.cvdSlope - input.prevCvd : 0;
    const oiZ = this.norm.zScore('oiChangePct', input.oiChangePct);
    const oiImpulse = Math.sign(priceChange || 0) * Math.sign(cvdChange || 0) * oiZ;

    const dfs =
      (this.weights.w1 * zDelta) +
      (this.weights.w2 * zCvd) +
      (this.weights.w3 * zLogP) +
      (this.weights.w4 * zObiW) +
      (this.weights.w5 * zObiD) +
      (this.weights.w6 * sweepSigned) +
      (this.weights.w7 * burstSigned) +
      (this.weights.w8 * oiImpulse);

    this.norm.update('dfs', dfs, input.nowMs);
    const dfsPercentile = this.norm.percentile('dfs', dfs);

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
