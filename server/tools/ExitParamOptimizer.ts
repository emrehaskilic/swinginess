/**
 * Exit Parameter Optimizer
 *
 * Bayesian optimization of exit-layer hyperparameters:
 *   - ATR stop multiplier (1.0–2.5)
 *   - ATR stop min/max bounds
 *   - Partial stop reduction ratios (stop1 / stop2)
 *   - Trend-carry giveback thresholds (soft + hard)
 *   - Flat-exit timeout
 *
 * Uses the existing ParameterSweeper infrastructure.
 * Run offline against walk-forward backtests, then inject best params into config.
 *
 * Usage:
 *   npx ts-node server/tools/ExitParamOptimizer.ts --ticks ./data/ticks.jsonl
 */

import { ParameterSweeper, ParameterSpace, SweepConfig, ParameterSetResult } from './ParameterSweeper';
import { defaultStrategyConfig } from './strategy_research_harness';

// ---------------------------------------------------------------------------
// Exit-layer parameter space
// ---------------------------------------------------------------------------

export const EXIT_PARAM_SPACE: ParameterSpace = {
  parameters: [
    // ATR-based stop
    {
      name: 'atrStopMultiplier',
      type: 'float',
      min: 0.8,
      max: 3.0,
      step: 0.1,
      distribution: 'uniform',
      defaultValue: 1.5,
    },
    {
      name: 'atrStopMin',
      type: 'float',
      min: 0.003,
      max: 0.015,
      step: 0.001,
      distribution: 'uniform',
      defaultValue: 0.008,
    },
    {
      name: 'atrStopMax',
      type: 'float',
      min: 0.012,
      max: 0.035,
      step: 0.001,
      distribution: 'uniform',
      defaultValue: 0.020,
    },
    // Trend-carry soft-reduce giveback
    {
      name: 'trendCarryReduceGivebackPct',
      type: 'float',
      min: 0.001,
      max: 0.008,
      step: 0.0005,
      distribution: 'uniform',
      defaultValue: 0.003,
    },
    // Trend-carry hard-exit giveback
    {
      name: 'trendCarryHardExitGivebackPct',
      type: 'float',
      min: 0.002,
      max: 0.012,
      step: 0.0005,
      distribution: 'uniform',
      defaultValue: 0.0045,
    },
    // Alpha decay threshold: how much DFS must fall before exit
    {
      name: 'alphaDfsBias15mDecayThreshold',
      type: 'float',
      min: 0.15,
      max: 0.55,
      step: 0.05,
      distribution: 'uniform',
      defaultValue: 0.35,
    },
    // Alpha decay minimum age before decay logic activates (minutes)
    {
      name: 'alphaDfsDecayMinAgeSec',
      type: 'int',
      min: 300,
      max: 1200,
      step: 60,
      distribution: 'uniform',
      defaultValue: 600,
    },
    // Flat-exit timeout (seconds)
    {
      name: 'flatExitTimeoutSec',
      type: 'int',
      min: 600,
      max: 3600,
      step: 120,
      distribution: 'uniform',
      defaultValue: 1800,
    },
  ],
};

// ---------------------------------------------------------------------------
// Sweep configuration
// ---------------------------------------------------------------------------

export const EXIT_SWEEP_CONFIG: SweepConfig = {
  method: 'bayesian',
  maxIterations: 120,
  maxParallel: 4,
  objectiveMetric: 'composite',
  objectiveDirection: 'maximize',
  compositeWeights: {
    sharpeRatio: 0.45,
    maxDrawdownPct: -0.30,  // negative weight = minimize drawdown
    winRate: 0.15,
    profitFactor: 0.10,
  },
  constraints: [
    { metric: 'totalTrades', operator: '>=', value: 20 },
    { metric: 'maxDrawdownPct', operator: '<=', value: 15 },
  ],
  earlyStopping: {
    enabled: true,
    patience: 25,
    minImprovement: 0.005,
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runExitParamOptimizer(
  tickDataPath: string,
  outputPath?: string,
): Promise<ParameterSetResult | null> {
  const sweeper = new ParameterSweeper();

  console.log('[ExitParamOptimizer] Starting Bayesian optimization of exit parameters...');
  console.log(`  Tick data : ${tickDataPath}`);
  console.log(`  Max iters : ${EXIT_SWEEP_CONFIG.maxIterations}`);
  console.log(`  Parallel  : ${EXIT_SWEEP_CONFIG.maxParallel}`);

  const result = await sweeper.run({
    tickDataPath,
    parameterSpace: EXIT_PARAM_SPACE,
    sweepConfig: EXIT_SWEEP_CONFIG,
    baseConfig: defaultStrategyConfig,
    onProgress: (p) => {
      const pct = Math.round((p.currentIteration / p.totalIterations) * 100);
      const etaSec = Math.round(p.estimatedRemainingMs / 1000);
      process.stdout.write(
        `\r  [${pct}%] iter=${p.currentIteration}/${p.totalIterations} best=${p.bestScore.toFixed(4)} eta=${etaSec}s  `
      );
    },
  });

  console.log('\n\n[ExitParamOptimizer] === RESULTS ===');

  if (!result.bestResult) {
    console.log('No valid results found.');
    return null;
  }

  const best = result.bestResult;
  console.log(`Best score   : ${best.score.toFixed(4)}`);
  console.log(`Sharpe ratio : ${best.metrics.sharpeRatio?.toFixed(3) ?? 'N/A'}`);
  console.log(`Win rate     : ${(best.metrics.winRate * 100).toFixed(1)}%`);
  console.log(`Max drawdown : ${best.metrics.maxDrawdownPct?.toFixed(2)}%`);
  console.log(`Total trades : ${best.metrics.totalTrades}`);
  console.log('\nOptimal exit parameters:');
  const exitKeys = [
    'atrStopMultiplier',
    'atrStopMin',
    'atrStopMax',
    'trendCarryReduceGivebackPct',
    'trendCarryHardExitGivebackPct',
    'alphaDfsBias15mDecayThreshold',
    'alphaDfsDecayMinAgeSec',
    'flatExitTimeoutSec',
  ] as const;
  for (const k of exitKeys) {
    const v = (best.parameters as Record<string, unknown>)[k];
    if (v !== undefined) {
      console.log(`  ${k.padEnd(38)} = ${v}`);
    }
  }

  if (outputPath) {
    const fs = await import('fs');
    const out = {
      generatedAt: new Date().toISOString(),
      score: best.score,
      metrics: best.metrics,
      params: exitKeys.reduce((acc, k) => {
        acc[k] = (best.parameters as Record<string, unknown>)[k];
        return acc;
      }, {} as Record<string, unknown>),
      top5: result.topResults.slice(0, 5).map((r) => ({
        score: r.score,
        params: exitKeys.reduce((acc, k) => {
          acc[k] = (r.parameters as Record<string, unknown>)[k];
          return acc;
        }, {} as Record<string, unknown>),
      })),
    };
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
    console.log(`\nResults written to: ${outputPath}`);
  }

  console.log('\n[ExitParamOptimizer] Done.');
  return best;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const tickIdx = args.indexOf('--ticks');
  const outIdx = args.indexOf('--out');
  const tickPath = tickIdx >= 0 ? args[tickIdx + 1] : '';
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (!tickPath) {
    console.error('Usage: ts-node ExitParamOptimizer.ts --ticks <path> [--out <result.json>]');
    process.exit(1);
  }

  runExitParamOptimizer(tickPath, outPath).catch((err) => {
    console.error('[ExitParamOptimizer] Fatal error:', err);
    process.exit(1);
  });
}
