/**
 * ProbabilisticRegimeScorer
 *
 * Lightweight HMM-inspired regime classifier. Instead of a full Baum-Welch
 * trained HMM (which requires off-line training), this uses a simplified
 * online Gaussian Mixture Model with Bayesian posterior updates.
 *
 * Advantages over the current linear RegimeSelector:
 *   - Returns P(regime | observations) — a probability distribution, not a binary flag
 *   - No fixed "20-tick wait" — updates every tick with a decaying memory
 *   - Handles regime uncertainty explicitly (e.g. 60% TR / 30% MR / 10% EV)
 *   - Can be used alongside RegimeSelector: inject posterior as additional signal
 *
 * Architecture (simplified discrete-time HMM):
 *   - 3 hidden states: TR (Trend), MR (Mean-Reversion), EV (Extreme Volatility)
 *   - Observation: [volLevel, trendStrength, meanRevScore, eventScore] (all in [0,1])
 *   - Emission: Gaussian per state (μ, σ fitted from defaults, updated online)
 *   - Transition: soft transitions via EMA decay
 *   - Posterior: P(state_t | obs_1:t) via forward algorithm (recursive)
 *
 * Integration:
 *   - Instantiate once per symbol alongside RegimeSelector
 *   - Call `update()` every metrics tick
 *   - Read `getRegimePosterior()` to get probabilities
 *   - The dominant state replaces or supplements RegimeSelector's output
 */

export type ProbRegime = 'TR' | 'MR' | 'EV';

export interface RegimePosterior {
  TR: number;  // [0,1]
  MR: number;  // [0,1]
  EV: number;  // [0,1]
  dominant: ProbRegime;
  confidence: number;  // max probability (how certain the model is)
  entropy: number;     // 0 = certain, log(3) = fully uncertain
}

export interface RegimeObservation {
  volLevel: number;       // [0,1] normalized volatility percentile
  trendStrength: number;  // [0,1] |DFS - 0.5| * 2
  meanRevScore: number;   // [0,1] VWAP deviation percentile weighted
  eventScore: number;     // [0,1] burst / extreme activity score
  nowMs: number;
}

// ---------------------------------------------------------------------------
// Gaussian emission model per state
// Each state has a mean vector μ and diagonal covariance σ²
// for observations [volLevel, trendStrength, meanRevScore, eventScore]
// ---------------------------------------------------------------------------

interface GaussianState {
  mu: [number, number, number, number];
  sigma: [number, number, number, number];
}

// Prior means fitted to typical market behavior (can be calibrated offline)
const STATE_PRIORS: Record<ProbRegime, GaussianState> = {
  TR: {
    mu:    [0.35, 0.75, 0.20, 0.30],  // moderate vol, high trend, low meanrev
    sigma: [0.15, 0.15, 0.12, 0.15],
  },
  MR: {
    mu:    [0.25, 0.20, 0.70, 0.20],  // low vol, low trend, high meanrev
    sigma: [0.12, 0.12, 0.15, 0.12],
  },
  EV: {
    mu:    [0.85, 0.40, 0.45, 0.85],  // extreme vol, mixed trend, high event
    sigma: [0.12, 0.20, 0.20, 0.12],
  },
};

// Transition matrix: P(next_state | current_state) — rows = current, cols = next
// Captures "stickiness" — regimes tend to persist
const TRANSITION_MATRIX: Record<ProbRegime, Record<ProbRegime, number>> = {
  TR: { TR: 0.88, MR: 0.09, EV: 0.03 },
  MR: { MR: 0.85, TR: 0.12, EV: 0.03 },
  EV: { EV: 0.75, TR: 0.15, MR: 0.10 },
};

const STATES: ProbRegime[] = ['TR', 'MR', 'EV'];
const LOG2 = Math.log(2);

export class ProbabilisticRegimeScorer {
  // Current posterior (prior = uniform at start)
  private posterior: Record<ProbRegime, number> = { TR: 0.5, MR: 0.4, EV: 0.1 };

  // Online learning: update emission Gaussian params with each observation (EMA)
  private readonly learnedStates: Record<ProbRegime, GaussianState>;
  private readonly LEARN_ALPHA = 0.02; // slow adaptation
  private readonly MIN_CONFIDENCE_FOR_LEARN = 0.7;

  // Smoothed posterior (EMA to reduce noise)
  private smoothedPosterior: Record<ProbRegime, number> = { TR: 0.5, MR: 0.4, EV: 0.1 };
  private readonly SMOOTH_ALPHA = 0.25;

  // History for entropy tracking
  private entropyHistory: number[] = [];
  private readonly ENTROPY_HISTORY = 20;

  constructor() {
    // Deep clone priors into learned state
    this.learnedStates = {
      TR: { mu: [...STATE_PRIORS.TR.mu], sigma: [...STATE_PRIORS.TR.sigma] },
      MR: { mu: [...STATE_PRIORS.MR.mu], sigma: [...STATE_PRIORS.MR.sigma] },
      EV: { mu: [...STATE_PRIORS.EV.mu], sigma: [...STATE_PRIORS.EV.sigma] },
    };
  }

  // ---------------------------------------------------------------------------
  // Main update — call every tick
  // ---------------------------------------------------------------------------

  update(obs: RegimeObservation): RegimePosterior {
    const obsVec: [number, number, number, number] = [
      obs.volLevel,
      obs.trendStrength,
      obs.meanRevScore,
      obs.eventScore,
    ];

    // 1. Predict: forward through transition matrix
    const predicted: Record<ProbRegime, number> = { TR: 0, MR: 0, EV: 0 };
    for (const next of STATES) {
      for (const cur of STATES) {
        predicted[next] += TRANSITION_MATRIX[cur][next] * this.posterior[cur];
      }
    }

    // 2. Update: multiply by emission likelihood
    const rawPosterior: Record<ProbRegime, number> = { TR: 0, MR: 0, EV: 0 };
    for (const state of STATES) {
      rawPosterior[state] = predicted[state] * this.gaussianLikelihood(obsVec, this.learnedStates[state]);
    }

    // 3. Normalize
    const total = STATES.reduce((s, st) => s + rawPosterior[st], 0);
    if (total > 1e-30) {
      for (const state of STATES) {
        this.posterior[state] = rawPosterior[state] / total;
      }
    }

    // 4. EMA smoothing
    for (const state of STATES) {
      this.smoothedPosterior[state] =
        this.SMOOTH_ALPHA * this.posterior[state] +
        (1 - this.SMOOTH_ALPHA) * this.smoothedPosterior[state];
    }

    // 5. Online learning: update emission params toward current obs, weighted by posterior
    const dominant = this.getDominant(this.posterior);
    if (this.posterior[dominant] >= this.MIN_CONFIDENCE_FOR_LEARN) {
      const st = this.learnedStates[dominant];
      for (let i = 0; i < 4; i++) {
        const diff = obsVec[i] - st.mu[i];
        st.mu[i] += this.LEARN_ALPHA * diff;
        // Update variance (Welford-like online update)
        const newVar = Math.max(0.005, st.sigma[i] ** 2 + this.LEARN_ALPHA * (diff ** 2 - st.sigma[i] ** 2));
        st.sigma[i] = Math.sqrt(newVar);
      }
    }

    // 6. Entropy of smoothed posterior
    const entropy = this.calcEntropy(this.smoothedPosterior);
    this.entropyHistory.push(entropy);
    if (this.entropyHistory.length > this.ENTROPY_HISTORY) this.entropyHistory.shift();

    const smoothedDominant = this.getDominant(this.smoothedPosterior);
    const confidence = this.smoothedPosterior[smoothedDominant];

    return {
      TR: this.smoothedPosterior.TR,
      MR: this.smoothedPosterior.MR,
      EV: this.smoothedPosterior.EV,
      dominant: smoothedDominant,
      confidence,
      entropy,
    };
  }

  getRegimePosterior(): RegimePosterior {
    const dominant = this.getDominant(this.smoothedPosterior);
    return {
      TR: this.smoothedPosterior.TR,
      MR: this.smoothedPosterior.MR,
      EV: this.smoothedPosterior.EV,
      dominant,
      confidence: this.smoothedPosterior[dominant],
      entropy: this.entropyHistory[this.entropyHistory.length - 1] ?? Math.log(3),
    };
  }

  /** Average entropy over last N observations (higher = more uncertain) */
  getAverageEntropy(): number {
    if (this.entropyHistory.length === 0) return Math.log(3);
    return this.entropyHistory.reduce((a, b) => a + b, 0) / this.entropyHistory.length;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private gaussianLikelihood(obs: [number, number, number, number], state: GaussianState): number {
    let logLikelihood = 0;
    for (let i = 0; i < 4; i++) {
      const mu = state.mu[i];
      const sigma = Math.max(0.001, state.sigma[i]);
      const diff = obs[i] - mu;
      logLikelihood -= (diff * diff) / (2 * sigma * sigma) + Math.log(sigma);
    }
    // Return exp(logL) clamped to prevent underflow
    return Math.exp(Math.max(-50, logLikelihood));
  }

  private getDominant(posterior: Record<ProbRegime, number>): ProbRegime {
    return STATES.reduce((best, s) => posterior[s] > posterior[best] ? s : best, 'TR' as ProbRegime);
  }

  private calcEntropy(posterior: Record<ProbRegime, number>): number {
    let entropy = 0;
    for (const s of STATES) {
      const p = posterior[s];
      if (p > 1e-12) entropy -= p * Math.log(p);
    }
    return entropy; // max = ln(3) ≈ 1.099
  }
}
