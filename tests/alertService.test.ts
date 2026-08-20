import assert from 'node:assert/strict';
import test from 'node:test';
import { hasReachedAlertTarget } from '../src/services/alertService.js';

test('an alert only triggers at or below its configured target', () => {
  const alert = { initialPrice: 10_000_000, targetPrice: 9_000_000 };
  assert.equal(hasReachedAlertTarget(alert, 9_500_000), false);
  assert.equal(hasReachedAlertTarget(alert, 9_000_000), true);
  assert.equal(hasReachedAlertTarget(alert, 8_500_000), true);
});

test('legacy alerts without a target fall back to their initial price', () => {
  assert.equal(hasReachedAlertTarget({ initialPrice: 10_000_000 }, 9_900_000), true);
});
