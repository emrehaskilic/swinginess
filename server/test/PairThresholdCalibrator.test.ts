function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

import { PairThresholdCalibrator } from '../runtime/PairThresholdCalibrator';

export function runTests() {
  const calibrator = new PairThresholdCalibrator('BTCUSDT');
  const startMs = 1_000_000;

  let snapshot = calibrator.getSnapshot(startMs);
  assert(snapshot.ready === false, 'calibrator should start unready');

  for (let index = 0; index < 120; index += 1) {
    snapshot = calibrator.observe({
      nowMs: startMs + (index * 1000),
      spoofScore: 10 + (index % 8),
      vpinApprox: 0.66 + ((index % 10) * 0.01),
      expectedSlippageBps: 1.5 + ((index % 6) * 0.25),
    });
  }

  assert(snapshot.ready === true, 'calibrator should become ready after enough samples');
  assert(snapshot.sampleCount >= 90, 'calibrator should retain active samples');
  assert(snapshot.spoofScoreThreshold > 2.25, 'adaptive spoof threshold should move above the global fallback');
  assert(snapshot.vpinThreshold >= 0.68, 'adaptive vpin threshold should reflect observed flow');
  assert(snapshot.expectedSlippageBpsThreshold >= 1.5, 'adaptive slippage threshold should reflect observed execution');
  assert(snapshot.spoofScorePercentile != null, 'current spoof percentile should be populated');
}
