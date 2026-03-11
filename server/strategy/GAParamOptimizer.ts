/**
 * GAParamOptimizer
 *
 * Evolutionary parameter search for strategy configuration using a
 * simple Genetic Algorithm.  Targeted parameters:
 *
 *   - dfsEntryLong        DFS percentile threshold for long entries
 *   - dfsEntryShort       DFS percentile threshold for short entries
 *   - atrStopMultiplier   Multiplier on microATR for dynamic stop-loss
 *   - atrStopMin          Minimum ATR stop fraction
 *   - atrStopMax          Maximum ATR stop fraction
 *   - targetVolPct        Vol-normalisation target per 15m bar
 *
 * GA mechanics:
 *   - Population of POPULATION_SIZE chromosomes (default 16)
 *   - Tournament selection (k = 3)
 *   - Uniform crossover (prob = 0.5 per gene)
 *   - Gaussian mutation (std = 0.12 × gene range)
 *   - One generation evolves after every EVOLVE_EVERY_N trades (default 20)
 *   - Fitness = CompositeRewardFunction composite score (EMA-smoothed)
 */

export interface GAParamGene {
  dfsEntryLong: number;        // range [0.75, 0.99]
  dfsEntryShort: number;       // range [0.01, 0.25]
  atrStopMultiplier: number;   // range [1.0, 3.0]
  atrStopMin: number;          // range [0.005, 0.015]
  atrStopMax: number;          // range [0.015, 0.035]
  targetVolPct: number;        // range [0.15, 0.60]
}

export interface GAParamBounds {
  min: number;
  max: number;
}

export type GAParamBoundsMap = { [K in keyof GAParamGene]: GAParamBounds };

export interface GAChromosome {
  id: number;
  genes: GAParamGene;
  fitness: number;          // EMA-smoothed composite reward
  tradeCount: number;       // number of trades evaluated under this chromosome
  generationBorn: number;
}

export interface GAConfig {
  populationSize: number;
  evolveEveryNTrades: number;
  crossoverProb: number;
  mutationStd: number;       // as fraction of gene range
  eliteCount: number;        // top-N kept unchanged each generation
  fitnessSmoothAlpha: number; // EMA alpha for fitness update (0.1-0.5)
}

const DEFAULT_BOUNDS: GAParamBoundsMap = {
  dfsEntryLong:      { min: 0.75, max: 0.99 },
  dfsEntryShort:     { min: 0.01, max: 0.25 },
  atrStopMultiplier: { min: 1.0,  max: 3.0  },
  atrStopMin:        { min: 0.005, max: 0.015 },
  atrStopMax:        { min: 0.015, max: 0.035 },
  targetVolPct:      { min: 0.15, max: 0.60  },
};

const DEFAULT_GENE: GAParamGene = {
  dfsEntryLong:      0.90,
  dfsEntryShort:     0.10,
  atrStopMultiplier: 1.5,
  atrStopMin:        0.008,
  atrStopMax:        0.020,
  targetVolPct:      0.30,
};

const DEFAULT_GA_CONFIG: GAConfig = {
  populationSize: 16,
  evolveEveryNTrades: 20,
  crossoverProb: 0.5,
  mutationStd: 0.12,
  eliteCount: 2,
  fitnessSmoothAlpha: 0.2,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Box-Muller Gaussian sample
function gaussianSample(mean: number, std: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class GAParamOptimizer {
  private readonly cfg: GAConfig;
  private readonly bounds: GAParamBoundsMap;
  private population: GAChromosome[];
  private activeIndex = 0;           // which chromosome is currently being evaluated
  private generation = 0;
  private totalTradeCount = 0;
  private nextId = 0;

  constructor(gaConfig?: Partial<GAConfig>, bounds?: Partial<GAParamBoundsMap>) {
    this.cfg = { ...DEFAULT_GA_CONFIG, ...(gaConfig ?? {}) };
    this.bounds = { ...DEFAULT_BOUNDS, ...(bounds ?? {}) };
    this.population = this._initPopulation();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Returns the gene set currently under evaluation */
  getActiveGenes(): GAParamGene {
    return { ...this.population[this.activeIndex].genes };
  }

  /** Returns the chromosome with the highest fitness */
  getBestChromosome(): GAChromosome {
    return { ...this.population.reduce((best, c) => c.fitness > best.fitness ? c : best) };
  }

  /** Returns all chromosomes (sorted by fitness desc) */
  getPopulation(): GAChromosome[] {
    return [...this.population].sort((a, b) => b.fitness - a.fitness);
  }

  /**
   * Record a trade outcome for the currently active chromosome.
   * @param rewardScore  CompositeRewardFunction.composite output in [-1, 1]
   */
  recordTrade(rewardScore: number): boolean {
    const active = this.population[this.activeIndex];
    const alpha = this.cfg.fitnessSmoothAlpha;

    if (active.tradeCount === 0) {
      active.fitness = rewardScore;
    } else {
      // EMA smoothing: new fitness = alpha * reward + (1-alpha) * old_fitness
      active.fitness = alpha * rewardScore + (1 - alpha) * active.fitness;
    }
    active.tradeCount += 1;
    this.totalTradeCount += 1;

    // Rotate to next chromosome after EVOLVE_EVERY_N trades per chromosome
    if (active.tradeCount >= this.cfg.evolveEveryNTrades) {
      const prevGen = this.generation;
      this._rotateActive();
      return this.generation > prevGen;
    }
    return false;
  }

  /** Current generation number */
  getGeneration(): number { return this.generation; }

  /** Total trades recorded across all chromosomes */
  getTotalTradeCount(): number { return this.totalTradeCount; }

  // ---------------------------------------------------------------------------
  // GA internals
  // ---------------------------------------------------------------------------

  private _rotateActive(): void {
    this.activeIndex = (this.activeIndex + 1) % this.population.length;
    // Once we've completed a full round-robin → evolve
    if (this.activeIndex === 0) {
      this._evolve();
    }
  }

  private _evolve(): void {
    this.generation += 1;
    const sorted = [...this.population].sort((a, b) => b.fitness - a.fitness);
    const newPop: GAChromosome[] = [];

    // Elitism: keep top-N unchanged
    for (let i = 0; i < this.cfg.eliteCount; i++) {
      newPop.push({ ...sorted[i], tradeCount: 0 });
    }

    // Fill rest with tournament selection + crossover + mutation
    while (newPop.length < this.cfg.populationSize) {
      const parent1 = this._tournamentSelect(sorted);
      const parent2 = this._tournamentSelect(sorted);
      const child = this._crossover(parent1, parent2);
      this._mutate(child);
      newPop.push({
        id: this.nextId++,
        genes: child,
        fitness: 0,
        tradeCount: 0,
        generationBorn: this.generation,
      });
    }

    this.population = newPop;
    this.activeIndex = this.cfg.eliteCount; // start with non-elite next round
  }

  private _tournamentSelect(sorted: GAChromosome[], k = 3): GAChromosome {
    let best: GAChromosome | null = null;
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(Math.random() * sorted.length);
      const candidate = sorted[idx];
      if (best === null || candidate.fitness > best.fitness) {
        best = candidate;
      }
    }
    return best!;
  }

  private _crossover(a: GAChromosome, b: GAChromosome): GAParamGene {
    const keys = Object.keys(a.genes) as (keyof GAParamGene)[];
    const child = { ...a.genes };
    for (const key of keys) {
      if (Math.random() < this.cfg.crossoverProb) {
        child[key] = b.genes[key];
      }
    }
    return child;
  }

  private _mutate(genes: GAParamGene): void {
    const keys = Object.keys(genes) as (keyof GAParamGene)[];
    for (const key of keys) {
      if (Math.random() < 0.3) { // 30% chance to mutate each gene
        const b = this.bounds[key];
        const range = b.max - b.min;
        const std = range * this.cfg.mutationStd;
        genes[key] = clamp(gaussianSample(genes[key], std), b.min, b.max);
      }
    }
    // Enforce constraint: dfsEntryShort < dfsEntryLong
    if (genes.dfsEntryShort >= genes.dfsEntryLong) {
      genes.dfsEntryShort = clamp(genes.dfsEntryLong - 0.1, this.bounds.dfsEntryShort.min, this.bounds.dfsEntryShort.max);
    }
    // Enforce atrStopMin < atrStopMax
    if (genes.atrStopMin >= genes.atrStopMax) {
      genes.atrStopMin = genes.atrStopMax * 0.5;
    }
  }

  private _initPopulation(): GAChromosome[] {
    const pop: GAChromosome[] = [];
    // First chromosome = defaults (known-good starting point)
    pop.push({
      id: this.nextId++,
      genes: { ...DEFAULT_GENE },
      fitness: 0,
      tradeCount: 0,
      generationBorn: 0,
    });
    // Rest = random initialisation within bounds
    for (let i = 1; i < this.cfg.populationSize; i++) {
      const genes: GAParamGene = {} as GAParamGene;
      for (const key of Object.keys(DEFAULT_BOUNDS) as (keyof GAParamGene)[]) {
        const b = this.bounds[key];
        genes[key] = b.min + Math.random() * (b.max - b.min);
      }
      // Fix constraint
      if (genes.dfsEntryShort >= genes.dfsEntryLong) {
        genes.dfsEntryShort = genes.dfsEntryLong * 0.5;
      }
      if (genes.atrStopMin >= genes.atrStopMax) {
        genes.atrStopMin = genes.atrStopMax * 0.5;
      }
      pop.push({
        id: this.nextId++,
        genes,
        fitness: 0,
        tradeCount: 0,
        generationBorn: 0,
      });
    }
    return pop;
  }
}
