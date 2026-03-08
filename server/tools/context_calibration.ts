import * as fs from 'fs';
import * as path from 'path';
import { replayDecisionLogFile } from '../replay/DecisionReplayHarness';
import {
  CHOPPY_SCENARIO,
  FLASH_CRASH_SCENARIO,
  LOW_LIQUIDITY_SCENARIO,
  RANGE_BOUND_SCENARIO,
  ScenarioDefinition,
  ScenarioLoader,
  TREND_UP_SCENARIO,
} from './ScenarioLoader';
import {
  BacktestConfig,
  StrategyConfig,
  StrategyResearchHarness,
  defaultBacktestConfig,
  defaultStrategyConfig,
} from './strategy_research_harness';

interface CandidateConfig {
  name: string;
  overrides: StrategyConfig;
}

interface CandidateSummary {
  name: string;
  overrides: StrategyConfig;
  averageScore: number;
  passRate: number;
  avgNetProfit: number;
  avgMaxDrawdownPct: number;
  scenarios: Array<{
    name: string;
    score: number;
    passed: boolean;
    netProfit: number;
    maxDrawdownPct: number;
  }>;
}

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

function shortenScenario(scenario: ScenarioDefinition, durationHours: number): ScenarioDefinition {
  return {
    ...scenario,
    durationMs: Math.max(60 * 60 * 1000, Math.trunc(durationHours * 60 * 60 * 1000)),
  };
}

async function runCandidate(
  candidate: CandidateConfig,
  scenarios: ScenarioDefinition[],
  backtestConfig: Partial<BacktestConfig>,
): Promise<CandidateSummary> {
  const harness = new StrategyResearchHarness(backtestConfig, candidate.overrides);
  const loader = new ScenarioLoader(harness);
  const results = [];
  for (const scenario of scenarios) {
    const result = await loader.runScenarioTest(scenario);
    results.push({
      name: scenario.name,
      score: result.score,
      passed: result.passed,
      netProfit: result.backtestResult.metrics.netProfit,
      maxDrawdownPct: result.backtestResult.metrics.maxDrawdownPct,
    });
  }

  const averageScore = results.reduce((sum, item) => sum + item.score, 0) / Math.max(1, results.length);
  const passRate = results.filter((item) => item.passed).length / Math.max(1, results.length);
  const avgNetProfit = results.reduce((sum, item) => sum + item.netProfit, 0) / Math.max(1, results.length);
  const avgMaxDrawdownPct = results.reduce((sum, item) => sum + item.maxDrawdownPct, 0) / Math.max(1, results.length);

  return {
    name: candidate.name,
    overrides: candidate.overrides,
    averageScore,
    passRate,
    avgNetProfit,
    avgMaxDrawdownPct,
    scenarios: results,
  };
}

async function main(): Promise<void> {
  const replayFile = readArg('--replay-file') ?? path.join(process.cwd(), 'logs', 'decision_log.jsonl');
  const replayLimit = Number(readArg('--replay-limit') ?? 1500);
  const durationHours = Number(readArg('--duration-hours') ?? 4);
  const outputPath = readArg('--out');

  const compactScenarios = [
    shortenScenario(TREND_UP_SCENARIO, durationHours),
    shortenScenario(RANGE_BOUND_SCENARIO, durationHours),
    shortenScenario(LOW_LIQUIDITY_SCENARIO, durationHours),
    shortenScenario(CHOPPY_SCENARIO, durationHours),
    shortenScenario(FLASH_CRASH_SCENARIO, Math.max(1, durationHours / 2)),
  ];

  const candidates: CandidateConfig[] = [
    {
      name: 'baseline',
      overrides: { ...defaultStrategyConfig },
    },
    {
      name: 'balanced_context',
      overrides: {
        ...defaultStrategyConfig,
        maxSpoofScoreForEntry: 2.25,
        maxExpectedSlippageBpsForEntry: 8,
        maxVpinForEntry: 0.68,
        edgeSizeFloorMultiplier: 0.75,
        edgeSizeCeilMultiplier: 1.1,
      },
    },
    {
      name: 'conservative_context',
      overrides: {
        ...defaultStrategyConfig,
        maxSpoofScoreForEntry: 2.0,
        maxExpectedSlippageBpsForEntry: 7,
        maxVpinForEntry: 0.64,
        edgeSizeFloorMultiplier: 0.7,
        edgeSizeCeilMultiplier: 1.05,
      },
    },
    {
      name: 'adaptive_context',
      overrides: {
        ...defaultStrategyConfig,
        maxSpoofScoreForEntry: 2.4,
        maxExpectedSlippageBpsForEntry: 9,
        maxVpinForEntry: 0.69,
        edgeSizeFloorMultiplier: 0.75,
        edgeSizeCeilMultiplier: 1.12,
      },
    },
  ];

  const replaySummary = fs.existsSync(replayFile)
    ? await replayDecisionLogFile(replayFile, { limit: replayLimit })
    : null;

  const backtestConfig: Partial<BacktestConfig> = {
    ...defaultBacktestConfig,
    symbol: 'BTCUSDT',
    recordDecisionLogs: false,
    recordMissedOpportunities: false,
  };

  const candidateSummaries: CandidateSummary[] = [];
  for (const candidate of candidates) {
    candidateSummaries.push(await runCandidate(candidate, compactScenarios, backtestConfig));
  }

  candidateSummaries.sort((a, b) => {
    const left = (a.averageScore * 0.7) + (a.passRate * 30) - (a.avgMaxDrawdownPct * 0.2);
    const right = (b.averageScore * 0.7) + (b.passRate * 30) - (b.avgMaxDrawdownPct * 0.2);
    return right - left;
  });

  const report = {
    replaySummary,
    bestCandidate: candidateSummaries[0] ?? null,
    candidates: candidateSummaries,
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), serialized, 'utf8');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
