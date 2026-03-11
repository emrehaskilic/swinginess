/**
 * CompositeRewardFunction
 *
 * Multi-objective reward signal designed for DRL agents (PPO/A2C).
 * Instead of raw PnL, combines four orthogonal performance dimensions:
 *
 *   1. Daily Return Score  — rolling 24h return vs. target (0.5%/day)
 *   2. Sharpe Score        — rolling Sharpe on recent per-trade returns
 *   3. Drawdown Penalty    — current drawdown vs. acceptable threshold
 *   4. Win-Rate Consistency — rolling win rate deviation from baseline (50%)
 *
 * Output: composite reward in [-1, +1].
 * Positive = good behaviour (keep doing this); negative = penalise.
 */

export interface RewardWeights {
  /** Weight for daily return component (default 0.30) */
  returnWeight: number;
  /** Weight for Sharpe ratio component (default 0.35) */
  sharpeWeight: number;
  /** Penalty weight for drawdown (default 0.20) */
  drawdownWeight: number;
  /** Weight for win-rate consistency (default 0.15) */
  winRateWeight: number;
}

export interface RewardConfig {
  /** Target daily return fraction (default 0.005 = 0.5%/day) */
  targetDailyReturnFraction: number;
  /** Acceptable max drawdown fraction before full penalty (default 0.10 = 10%) */
  maxAcceptableDrawdownFraction: number;
  /** Baseline win rate for win-rate scoring (default 0.50) */
  baselineWinRate: number;
  /** Rolling window for win-rate and Sharpe computation (trade count) */
  rollingWindow: number;
  /** Daily return window in ms (default 24h) */
  dailyWindowMs: number;
  weights: RewardWeights;
}

export interface RewardBreakdown {
  returnScore: number;
  sharpeScore: number;
  drawdownPenalty: number;
  winRateScore: number;
  composite: number;
}

export interface TradeRecord {
  timestampMs: number;
  pnlFraction: number;  // realizedPnl / entryNotional (signed)
  won: boolean;
}

const DEFAULT_CONFIG: RewardConfig = {
  targetDailyReturnFraction: 0.005,
  maxAcceptableDrawdownFraction: 0.10,
  baselineWinRate: 0.50,
  rollingWindow: 30,
  dailyWindowMs: 24 * 60 * 60 * 1000,
  weights: {
    returnWeight: 0.30,
    sharpeWeight: 0.35,
    drawdownWeight: 0.20,
    winRateWeight: 0.15,
  },
};

function tanh(x: number): number {
  if (x >= 20) return 1;
  if (x <= -20) return -1;
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class CompositeRewardFunction {
  private readonly cfg: RewardConfig;
  private readonly trades: TradeRecord[] = [];
  private peakEquityFraction = 1.0;   // relative to start (1.0 = no gain/loss)
  private cumulativeReturn = 0;         // running sum of pnlFractions

  constructor(config?: Partial<RewardConfig>) {
    this.cfg = {
      ...DEFAULT_CONFIG,
      ...(config ?? {}),
      weights: {
        ...DEFAULT_CONFIG.weights,
        ...(config?.weights ?? {}),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Record a completed trade
  // ---------------------------------------------------------------------------

  record(pnlFraction: number, nowMs?: number): RewardBreakdown {
    const ts = nowMs ?? Date.now();
    this.cumulativeReturn += pnlFraction;
    const currentEquityFraction = 1 + this.cumulativeReturn;
    this.peakEquityFraction = Math.max(this.peakEquityFraction, currentEquityFraction);

    this.trades.push({ timestampMs: ts, pnlFraction, won: pnlFraction > 0 });

    // Trim to rolling window + daily window (keep enough for both calcs)
    const cutoffMs = ts - this.cfg.dailyWindowMs * 2;
    while (this.trades.length > this.cfg.rollingWindow * 3 && this.trades[0].timestampMs < cutoffMs) {
      this.trades.shift();
    }

    return this.compute(ts);
  }

  // ---------------------------------------------------------------------------
  // Compute reward snapshot without recording a trade
  // ---------------------------------------------------------------------------

  compute(nowMs?: number): RewardBreakdown {
    const ts = nowMs ?? Date.now();
    const w = this.cfg.weights;

    const returnScore  = this._computeReturnScore(ts);
    const sharpeScore  = this._computeSharpeScore();
    const ddPenalty    = this._computeDrawdownPenalty();
    const winRateScore = this._computeWinRateScore();

    const composite = clamp(
      w.returnWeight   * returnScore
      + w.sharpeWeight   * sharpeScore
      - w.drawdownWeight * ddPenalty
      + w.winRateWeight  * winRateScore,
      -1, 1,
    );

    return { returnScore, sharpeScore, drawdownPenalty: ddPenalty, winRateScore, composite };
  }

  // ---------------------------------------------------------------------------
  // Component computations
  // ---------------------------------------------------------------------------

  private _computeReturnScore(nowMs: number): number {
    const windowStart = nowMs - this.cfg.dailyWindowMs;
    const dailyTrades = this.trades.filter(t => t.timestampMs >= windowStart);
    const dailyReturn = dailyTrades.reduce((sum, t) => sum + t.pnlFraction, 0);
    // tanh normalised: target = 1.0 at targetDailyReturnFraction, penalty below 0
    return tanh(dailyReturn / this.cfg.targetDailyReturnFraction);
  }

  private _computeSharpeScore(): number {
    const window = this.trades.slice(-this.cfg.rollingWindow);
    if (window.length < 4) return 0;
    const returns = window.map(t => t.pnlFraction);
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std <= 0) return mean > 0 ? 1 : 0;
    // Annualised approximation: assume ~5 trades/day
    const sharpe = (mean / std) * Math.sqrt(252 * 5);
    // tanh normalised: Sharpe of 2 maps to ~0.96
    return tanh(sharpe / 2);
  }

  private _computeDrawdownPenalty(): number {
    const currentEquity = 1 + this.cumulativeReturn;
    const drawdown = Math.max(0, this.peakEquityFraction - currentEquity) / Math.max(1e-9, this.peakEquityFraction);
    // Linear penalty: 0 at 0% DD, 1.0 at maxAcceptableDD, >1 if worse (clamped for composite)
    return clamp(drawdown / this.cfg.maxAcceptableDrawdownFraction, 0, 2);
  }

  private _computeWinRateScore(): number {
    const window = this.trades.slice(-this.cfg.rollingWindow);
    if (window.length < 5) return 0;
    const winRate = window.filter(t => t.won).length / window.length;
    // Deviation from baseline: 4x scale so ±25% win-rate difference maps to ±tanh(1) ≈ ±0.76
    return tanh((winRate - this.cfg.baselineWinRate) * 4);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getTradeCount(): number { return this.trades.length; }

  getCurrentDrawdownFraction(): number {
    const currentEquity = 1 + this.cumulativeReturn;
    return Math.max(0, this.peakEquityFraction - currentEquity) / Math.max(1e-9, this.peakEquityFraction);
  }

  getRollingWinRate(window?: number): number {
    const slice = this.trades.slice(-(window ?? this.cfg.rollingWindow));
    if (slice.length === 0) return 0;
    return slice.filter(t => t.won).length / slice.length;
  }

  reset(): void {
    this.trades.length = 0;
    this.peakEquityFraction = 1.0;
    this.cumulativeReturn = 0;
  }
}
