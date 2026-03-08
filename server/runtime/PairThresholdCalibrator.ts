const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export interface PairThresholdObservation {
  nowMs: number;
  spoofScore: number;
  vpinApprox: number;
  expectedSlippageBps: number;
}

export interface PairAdaptiveThresholdSnapshot {
  updatedAtMs: number;
  ready: boolean;
  sampleCount: number;
  spoofScoreThreshold: number;
  vpinThreshold: number;
  expectedSlippageBpsThreshold: number;
  spoofScorePercentile: number | null;
  vpinPercentile: number | null;
  expectedSlippageBpsPercentile: number | null;
}

interface PairThresholdCalibratorConfig {
  windowMs: number;
  minSamples: number;
  maxSamples: number;
  spoofQuantile: number;
  vpinQuantile: number;
  slippageQuantile: number;
  fallbackSpoofThreshold: number;
  fallbackVpinThreshold: number;
  fallbackSlippageBpsThreshold: number;
}

const DEFAULT_CONFIG: PairThresholdCalibratorConfig = {
  windowMs: Math.max(60_000, Number(process.env.PAIR_THRESHOLD_WINDOW_MS || (30 * 60_000))),
  minSamples: Math.max(20, Math.trunc(Number(process.env.PAIR_THRESHOLD_MIN_SAMPLES || 90))),
  maxSamples: Math.max(128, Math.trunc(Number(process.env.PAIR_THRESHOLD_MAX_SAMPLES || 1800))),
  spoofQuantile: clamp(Number(process.env.PAIR_THRESHOLD_SPOOF_QUANTILE || 0.92), 0.5, 0.995),
  vpinQuantile: clamp(Number(process.env.PAIR_THRESHOLD_VPIN_QUANTILE || 0.85), 0.5, 0.995),
  slippageQuantile: clamp(Number(process.env.PAIR_THRESHOLD_SLIPPAGE_QUANTILE || 0.9), 0.5, 0.995),
  fallbackSpoofThreshold: Math.max(0.5, Number(process.env.CONTEXT_MAX_SPOOF_SCORE || 2.25)),
  fallbackVpinThreshold: clamp(Number(process.env.CONTEXT_MAX_VPIN || 0.68), 0.2, 0.99),
  fallbackSlippageBpsThreshold: Math.max(0.25, Number(process.env.CONTEXT_MAX_EXPECTED_SLIPPAGE_BPS || 8)),
};

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = clamp(q, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * weight);
}

function percentileRank(values: number[], value: number): number | null {
  if (values.length === 0 || !Number.isFinite(value)) return null;
  let lessThanOrEqual = 0;
  for (const candidate of values) {
    if (candidate <= value) lessThanOrEqual += 1;
  }
  return clamp(lessThanOrEqual / values.length, 0, 1);
}

export class PairThresholdCalibrator {
  private readonly config: PairThresholdCalibratorConfig;
  private readonly samples: Array<{ ts: number; spoofScore: number; vpinApprox: number; expectedSlippageBps: number }> = [];
  private head = 0;

  constructor(private readonly symbol: string, config?: Partial<PairThresholdCalibratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
  }

  observe(input: PairThresholdObservation): PairAdaptiveThresholdSnapshot {
    const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
    this.samples.push({
      ts: nowMs,
      spoofScore: Math.max(0, Number(input.spoofScore || 0)),
      vpinApprox: clamp(Number(input.vpinApprox || 0), 0, 1),
      expectedSlippageBps: Math.max(0, Number(input.expectedSlippageBps || 0)),
    });
    this.prune(nowMs);
    this.compact();
    return this.getSnapshot(nowMs, input);
  }

  getSnapshot(nowMs: number = Date.now(), current?: Partial<PairThresholdObservation>): PairAdaptiveThresholdSnapshot {
    this.prune(nowMs);
    const active = this.samples.slice(this.head);
    const spoofValues = active.map((sample) => sample.spoofScore);
    const vpinValues = active.map((sample) => sample.vpinApprox);
    const slippageValues = active.map((sample) => sample.expectedSlippageBps);
    const sampleCount = active.length;
    const ready = sampleCount >= this.config.minSamples;

    const spoofThreshold = ready
      ? Math.max(0.75, quantile(spoofValues, this.config.spoofQuantile))
      : this.config.fallbackSpoofThreshold;
    const vpinThreshold = ready
      ? clamp(quantile(vpinValues, this.config.vpinQuantile), 0.45, 0.98)
      : this.config.fallbackVpinThreshold;
    const slippageThreshold = ready
      ? clamp(Math.max(0.25, quantile(slippageValues, this.config.slippageQuantile)), 0.25, 50)
      : this.config.fallbackSlippageBpsThreshold;

    return {
      updatedAtMs: nowMs,
      ready,
      sampleCount,
      spoofScoreThreshold: spoofThreshold,
      vpinThreshold,
      expectedSlippageBpsThreshold: slippageThreshold,
      spoofScorePercentile: Number.isFinite(Number(current?.spoofScore))
        ? percentileRank(spoofValues, Number(current?.spoofScore))
        : null,
      vpinPercentile: Number.isFinite(Number(current?.vpinApprox))
        ? percentileRank(vpinValues, Number(current?.vpinApprox))
        : null,
      expectedSlippageBpsPercentile: Number.isFinite(Number(current?.expectedSlippageBps))
        ? percentileRank(slippageValues, Number(current?.expectedSlippageBps))
        : null,
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.head = 0;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.config.windowMs;
    while (this.head < this.samples.length && this.samples[this.head].ts < cutoff) {
      this.head += 1;
    }
  }

  private compact(): void {
    const active = this.samples.length - this.head;
    if (active > this.config.maxSamples) {
      this.head += Math.max(1, active - this.config.maxSamples);
    }
    if (this.head > 0 && (this.head >= 1024 || this.head > (this.samples.length >> 1))) {
      this.samples.splice(0, this.head);
      this.head = 0;
    }
  }
}

export default PairThresholdCalibrator;
