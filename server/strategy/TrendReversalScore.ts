/**
 * TrendReversalScore (TRS) — V13 Swing Trading Module
 *
 * Detects trend reversals by tracking sustained direction changes across
 * multiple microstructure indicators. Designed for 5-minute candle swing
 * trading where trends last 1-4 hours.
 *
 * Core signals:
 *   1. CVD Slope direction flip (EMA-smoothed)
 *   2. DeltaZ sustained sign change
 *   3. OBI Weighted sign flip
 *   4. DFS Percentile crossing midpoint (0.5)
 *
 * A reversal requires persistence: indicators must stay flipped for
 * N consecutive ticks (configurable, default 3) to confirm.
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
  /** EMA alpha for fast smoothing (default 0.15) */
  emaFastAlpha: number;
  /** EMA alpha for slow smoothing (default 0.05) */
  emaSlowAlpha: number;
  /** Min ticks for reversal confirmation (default 3) */
  confirmTicks: number;
  /** Threshold for composite score to trigger reversal (default 0.35) */
  reversalThreshold: number;
}

const DEFAULT_TRS_CONFIG: TrendReversalConfig = {
  emaFastAlpha: 0.15,
  emaSlowAlpha: 0.05,
  confirmTicks: 3,
  reversalThreshold: 0.35,
};

export class TrendReversalScore {
  private readonly config: TrendReversalConfig;

  // EMA-smoothed indicators
  private cvdFastEma = 0;
  private cvdSlowEma = 0;
  private deltaZFastEma = 0;
  private deltaZSlowEma = 0;
  private obiFastEma = 0;
  private obiSlowEma = 0;
  private dfsFastEma = 0.5;
  private dfsSlowEma = 0.5;

  // Current trend tracking
  private currentDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  private directionConfirmCount = 0;
  private lastConfirmedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';

  // Warmup tracking
  private tickCount = 0;
  private readonly WARMUP_TICKS = 20; // Need at least 20 ticks before EMAs are meaningful

  constructor(config?: Partial<TrendReversalConfig>) {
    this.config = { ...DEFAULT_TRS_CONFIG, ...(config || {}) };
  }

  /** Returns the last confirmed trend direction */
  getConfirmedDirection(): 'LONG' | 'SHORT' | 'NEUTRAL' {
    return this.lastConfirmedDirection;
  }

  compute(input: TrendReversalInput): TrendReversalOutput {
    this.tickCount++;
    const alpha = this.config.emaFastAlpha;
    const slowAlpha = this.config.emaSlowAlpha;

    // Update EMAs
    if (this.tickCount === 1) {
      // Initialize EMAs with first values
      this.cvdFastEma = input.cvdSlope;
      this.cvdSlowEma = input.cvdSlope;
      this.deltaZFastEma = input.deltaZ;
      this.deltaZSlowEma = input.deltaZ;
      this.obiFastEma = input.obiWeighted;
      this.obiSlowEma = input.obiWeighted;
      this.dfsFastEma = input.dfsPercentile;
      this.dfsSlowEma = input.dfsPercentile;
    } else {
      this.cvdFastEma = alpha * input.cvdSlope + (1 - alpha) * this.cvdFastEma;
      this.cvdSlowEma = slowAlpha * input.cvdSlope + (1 - slowAlpha) * this.cvdSlowEma;
      this.deltaZFastEma = alpha * input.deltaZ + (1 - alpha) * this.deltaZFastEma;
      this.deltaZSlowEma = slowAlpha * input.deltaZ + (1 - slowAlpha) * this.deltaZSlowEma;
      this.obiFastEma = alpha * input.obiWeighted + (1 - alpha) * this.obiFastEma;
      this.obiSlowEma = slowAlpha * input.obiWeighted + (1 - slowAlpha) * this.obiSlowEma;
      this.dfsFastEma = alpha * input.dfsPercentile + (1 - alpha) * this.dfsFastEma;
      this.dfsSlowEma = slowAlpha * input.dfsPercentile + (1 - slowAlpha) * this.dfsSlowEma;
    }

    // During warmup, return neutral
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

    // ─── Component Signals ───
    // Each component outputs a value from -1 (strongly bearish) to +1 (strongly bullish)

    // 1. CVD Slope flip: fast EMA vs slow EMA crossover
    //    When fast > slow → buying momentum increasing → bullish
    const cvdDiff = this.cvdFastEma - this.cvdSlowEma;
    const cvdFlip = clamp(cvdDiff / 0.3, -1, 1);

    // 2. DeltaZ direction: sustained delta in one direction
    const deltaZDiff = this.deltaZFastEma - this.deltaZSlowEma;
    const deltaZFlip = clamp(deltaZDiff / 1.5, -1, 1);

    // 3. OBI Weighted flip: orderbook pressure direction
    const obiDiff = this.obiFastEma - this.obiSlowEma;
    const obiFlip = clamp(obiDiff / 0.15, -1, 1);

    // 4. DFS Percentile direction: above/below 0.5 midpoint
    //    Use deviation from 0.5 as directional signal
    const dfsDeviation = this.dfsFastEma - 0.5;
    const dfsDirection = clamp(dfsDeviation / 0.25, -1, 1);

    // ─── Composite Trend Score ───
    // Weighted combination: CVD and DeltaZ are most important for reversal detection
    const trendScore = 0.30 * cvdFlip
                     + 0.30 * deltaZFlip
                     + 0.20 * obiFlip
                     + 0.20 * dfsDirection;

    // ─── Direction Detection ───
    const threshold = this.config.reversalThreshold;
    let detectedDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    if (trendScore > threshold) {
      detectedDirection = 'LONG';
    } else if (trendScore < -threshold) {
      detectedDirection = 'SHORT';
    }

    // ─── Confirmation Counter ───
    if (detectedDirection === this.currentDirection && detectedDirection !== 'NEUTRAL') {
      this.directionConfirmCount++;
    } else if (detectedDirection !== 'NEUTRAL') {
      // Direction changed — start counting for new direction
      this.currentDirection = detectedDirection;
      this.directionConfirmCount = 1;
    } else {
      // NEUTRAL — don't reset counter, just don't increment
      // This prevents noise from resetting a valid reversal detection
    }

    // ─── Reversal Detection ───
    const isConfirmed = this.directionConfirmCount >= this.config.confirmTicks;
    const isReversal = isConfirmed && this.currentDirection !== this.lastConfirmedDirection;

    if (isConfirmed) {
      this.lastConfirmedDirection = this.currentDirection;
    }

    // Confidence: based on how many components agree with the direction
    const dirSign = detectedDirection === 'LONG' ? 1 : detectedDirection === 'SHORT' ? -1 : 0;
    const agreementCount = [cvdFlip, deltaZFlip, obiFlip, dfsDirection]
      .filter(v => Math.sign(v) === dirSign && Math.abs(v) > 0.2)
      .length;
    const confidence = isConfirmed ? clamp(agreementCount / 4, 0, 1) : 0;

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
