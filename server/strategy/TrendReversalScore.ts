/**
 * TrendReversalScore (TRS) — V13.2 Direct Metrics Approach
 *
 * Detects trend reversals by reading the bot's own orderflow metrics
 * DIRECTLY — no EMA smoothing, no crossovers, no double-processing.
 *
 * The bot already computes institutional-grade signals:
 *   - DFS Percentile: 8-component dual-normalized composite (0-1)
 *   - CVD Slope: cumulative volume delta rate of change
 *   - DeltaZ: delta z-score (normalized buying/selling pressure)
 *   - OBI Weighted: orderbook imbalance
 *
 * These ARE the trend. A reversal = sustained flip of these metrics
 * to the opposite zone for N consecutive ticks.
 *
 * Logic:
 *   1. DFS Percentile in bullish zone (>= 0.60) or bearish zone (<= 0.40)
 *   2. Cross-check: CVD slope sign + DeltaZ sign agree with DFS direction
 *   3. N consecutive ticks in the same zone = confirmed direction
 *   4. Direction change from confirmed LONG to confirmed SHORT (or vice versa) = reversal
 */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export interface TrendReversalInput {
  cvdSlope: number;
  deltaZ: number;
  obiWeighted: number;
  dfsPercentile: number;
  price: number;
  vwap: number;
  nowMs: number;
}

export interface TrendReversalOutput {
  /** Whether a confirmed trend reversal has occurred */
  reversal: boolean;
  /** New trend direction if reversal detected */
  direction: 'LONG' | 'SHORT' | null;
  /** Confidence score 0-1 based on how many signals agree */
  confidence: number;
  /** Raw component scores for logging */
  components: {
    cvdFlip: number;       // -1 to 1: negative = bearish, positive = bullish
    deltaZFlip: number;    // -1 to 1
    obiFlip: number;       // -1 to 1
    dfsDirection: number;  // -1 to 1
    trendScore: number;    // Composite -1 to 1
  };
  /** Current detected trend direction (even without reversal) */
  currentTrend: 'LONG' | 'SHORT' | 'NEUTRAL';
  /** How many consecutive ticks confirm the current direction */
  confirmTicks: number;
}

export interface TrendReversalConfig {
  /** DFS percentile threshold for bullish zone (default 0.60) */
  dfsBullishZone: number;
  /** DFS percentile threshold for bearish zone (default 0.40) */
  dfsBearishZone: number;
  /** Min ticks for reversal confirmation (default 60) */
  confirmTicks: number;
  /** Min agreement score to consider direction valid (default 0.35) */
  agreementThreshold: number;
}

const DEFAULT_TRS_CONFIG: TrendReversalConfig = {
  dfsBullishZone: 0.60,
  dfsBearishZone: 0.40,
  confirmTicks: 60,
  agreementThreshold: 0.35,
};

export class TrendReversalScore {
  private readonly config: TrendReversalConfig;

  // Current trend tracking
  private currentDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  private directionConfirmCount = 0;
  private lastConfirmedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';

  // Warmup tracking
  private tickCount = 0;
  private readonly WARMUP_TICKS = 60;

  constructor(config?: Partial<TrendReversalConfig>) {
    this.config = { ...DEFAULT_TRS_CONFIG, ...(config || {}) };
  }

  /** Returns the last confirmed trend direction */
  getConfirmedDirection(): 'LONG' | 'SHORT' | 'NEUTRAL' {
    return this.lastConfirmedDirection;
  }

  compute(input: TrendReversalInput): TrendReversalOutput {
    this.tickCount++;

    // During warmup, return neutral — let metrics stabilize
    if (this.tickCount < this.WARMUP_TICKS) {
      return {
        reversal: false,
        direction: null,
        confidence: 0,
        components: { cvdFlip: 0, deltaZFlip: 0, obiFlip: 0, dfsDirection: 0, trendScore: 0 },
        currentTrend: 'NEUTRAL',
        confirmTicks: 0,
      };
    }

    // ─── Read Metrics Directly ───
    // No EMA, no smoothing — the bot's pipeline already did that work

    // 1. DFS Percentile: the primary directional signal (already 0-1 normalized)
    //    Map to [-1, +1]: 0.5 = neutral, 1.0 = max bullish, 0.0 = max bearish
    const dfsDirection = clamp((input.dfsPercentile - 0.5) / 0.5, -1, 1);

    // 2. CVD Slope: buying vs selling momentum
    //    Positive = net buying pressure, negative = net selling
    //    Clamp to [-1, 1] using reasonable range
    const cvdFlip = clamp(input.cvdSlope / 500, -1, 1);

    // 3. DeltaZ: normalized delta (z-score of buy-sell imbalance)
    //    Already z-scored by the pipeline, typical range [-3, +3]
    const deltaZFlip = clamp(input.deltaZ / 2.5, -1, 1);

    // 4. OBI Weighted: orderbook imbalance
    //    Typical range [-1, +1], already normalized
    const obiFlip = clamp(input.obiWeighted / 0.5, -1, 1);

    // ─── Composite Score ───
    // DFS has highest weight — it's already a multi-signal composite
    // CVD and DeltaZ confirm actual trade flow direction
    // OBI adds orderbook-side confirmation
    const trendScore = 0.40 * dfsDirection
                     + 0.25 * cvdFlip
                     + 0.20 * deltaZFlip
                     + 0.15 * obiFlip;

    // ─── Zone Detection ───
    // Use DFS zones as primary trigger, composite score as confirmation
    const bullZone = this.config.dfsBullishZone;
    const bearZone = this.config.dfsBearishZone;
    const threshold = this.config.agreementThreshold;

    let detectedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';

    if (input.dfsPercentile >= bullZone && trendScore > threshold) {
      detectedDirection = 'LONG';
    } else if (input.dfsPercentile <= bearZone && trendScore < -threshold) {
      detectedDirection = 'SHORT';
    }

    // ─── Confirmation Counter ───
    if (detectedDirection === this.currentDirection && detectedDirection !== 'NEUTRAL') {
      this.directionConfirmCount++;
    } else if (detectedDirection !== 'NEUTRAL') {
      // New direction — start fresh counter
      this.currentDirection = detectedDirection;
      this.directionConfirmCount = 1;
    } else {
      // NEUTRAL tick — don't reset, just don't increment
      // This allows brief neutral moments without breaking a valid build-up
    }

    // ─── Reversal Detection ───
    const isConfirmed = this.directionConfirmCount >= this.config.confirmTicks;
    const isReversal = isConfirmed && this.currentDirection !== this.lastConfirmedDirection;

    if (isConfirmed) {
      this.lastConfirmedDirection = this.currentDirection;
    }

    // ─── Confidence ───
    // Count how many raw metrics agree with the detected direction
    const dirSign = detectedDirection === 'LONG' ? 1 : detectedDirection === 'SHORT' ? -1 : 0;
    const components = [dfsDirection, cvdFlip, deltaZFlip, obiFlip];
    const agreeing = components.filter(v => Math.sign(v) === dirSign && Math.abs(v) > 0.15).length;
    const confidence = isConfirmed ? clamp(agreeing / 4, 0, 1) : 0;

    return {
      reversal: isReversal,
      direction: isReversal ? this.currentDirection as 'LONG' | 'SHORT' : null,
      confidence,
      components: {
        cvdFlip,
        deltaZFlip,
        obiFlip,
        dfsDirection,
        trendScore,
      },
      currentTrend: this.lastConfirmedDirection,
      confirmTicks: this.directionConfirmCount,
    };
  }
}
