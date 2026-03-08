function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

import { SessionProfileTracker } from '../metrics/SessionProfileTracker';

export function runTests() {
  const tracker = new SessionProfileTracker();
  const baseTs = Date.UTC(2026, 2, 8, 9, 0, 0, 0);
  const profileTs = baseTs - 200_000;

  for (let index = 0; index < 10; index += 1) {
    tracker.update(profileTs + index, 100, 1);
  }
  for (let index = 0; index < 6; index += 1) {
    tracker.update(profileTs + 100 + index, 101, 1);
    tracker.update(profileTs + 200 + index, 99.5, 1);
  }

  tracker.update(baseTs + 80_000, 103, 1.5);
  tracker.update(baseTs + 85_000, 103.2, 1.2);

  const snapshot = tracker.snapshot(baseTs + 89_000, 103.1);
  assert(snapshot.sessionName === 'london', 'profile session should follow the london window');
  assert(snapshot.poc != null, 'profile poc should exist after trades');
  assert(snapshot.vah != null && snapshot.val != null, 'profile value area should exist after trades');
  assert(snapshot.location === 'ABOVE_VAH', 'reference price should sit above value when recent trades hold above VAH');
  assert(snapshot.acceptance === 'ACCEPTING_ABOVE', 'recent sustained volume above value should count as acceptance');
  assert(snapshot.distanceToPocBps != null && snapshot.distanceToPocBps > 0, 'distance to poc should be positive above the profile');
}
