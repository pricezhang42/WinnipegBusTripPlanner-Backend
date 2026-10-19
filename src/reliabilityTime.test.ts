import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateUnavailableReason, winnipegTime } from './reliabilityTime.js';

test('Winnipeg conversion respects midnight, daylight-saving offsets and repeated local hours', () => {
  assert.equal(winnipegTime('2026-01-10T05:59:00Z')?.date, '2026-01-09');
  assert.equal(winnipegTime('2026-01-10T06:00:00Z')?.date, '2026-01-10');
  assert.equal(winnipegTime('2026-03-08T07:59:00Z')?.hour, 1);
  assert.equal(winnipegTime('2026-03-08T08:00:00Z')?.hour, 3);
  assert.deepEqual(winnipegTime('2026-11-01T01:30:00-05:00'), winnipegTime('2026-11-01T01:30:00-06:00'));
  assert.equal(winnipegTime('2026-09-25T24:00:00'), undefined);
});

test('cutoff and 30-day limits are explicit and inclusive at the boundary', () => {
  const cutoff = '2026-09-24';
  const now = new Date('2026-09-25T00:00:00Z');
  assert.equal(dateUnavailableReason(cutoff, cutoff, now), 'historical_date_unsupported');
  assert.equal(dateUnavailableReason(cutoff, '2026-10-24', now), undefined);
  assert.equal(dateUnavailableReason(cutoff, '2026-10-25', now), 'data_outdated');
  assert.equal(dateUnavailableReason(cutoff, '2026-10-24', new Date('2026-10-24T00:00:00Z')), undefined);
  assert.equal(dateUnavailableReason(cutoff, '2026-10-24', new Date('2026-10-24T00:00:00.001Z')), 'data_outdated');
  assert.equal(dateUnavailableReason(cutoff, '2026-09-25', new Date('invalid')), 'data_unavailable');
});
