import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportRisk } from './passupReportRisk.js';

function classify(reports: number, reportDates: number, visits = 200, departureDates = 10) {
  return reportRisk({ reportCount: reports, reportDates, recordedDepartures: visits, departureDates });
}

test('ratio boundaries use raw recorded visits without a +50 penalty', () => {
  assert.equal(classify(1, 1).level, 'low');
  assert.equal(classify(2, 2).level, 'medium'); // Exactly 1%.
  assert.equal(classify(4, 2).level, 'medium');
  assert.equal(classify(5, 3).level, 'high'); // Exactly 2.5%.
  assert.equal(classify(6, 3).level, 'high');
  assert.equal(classify(2, 2, 60).level, 'unknown');
  assert.equal(classify(3, 3, 60).level, 'high');
});

test('reference minimums, zero-report evidence and reporting persistence are explicit', () => {
  assert.equal(classify(1, 1, 59).level, 'unknown');
  assert.equal(classify(1, 1, 200, 9).level, 'unknown');
  assert.equal(classify(0, 0, 119).level, 'unknown');
  assert.equal(classify(0, 0, 120).level, 'low');
  assert.equal(classify(2, 1).basis, 'insufficient_reporting_dates');
  assert.equal(classify(5, 2).basis, 'insufficient_reporting_dates');
  assert.equal(classify(6, 1).level, 'unknown');
  assert.equal(classify(1, 1, 0).level, 'unknown');
  assert.equal(classify(201, 10).basis, 'reports_exceed_recorded_visits');
});
