import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPING } from './artifactGroups.js';
import { enrichPlans, loadArtifact, reliabilityForRide, winnipegTime, type Artifact, type Ride } from './reliability.js';
const now = new Date('2026-09-25T18:00:00Z');
const ride: Ride = { type: 'ride', route: { key: 'BLUE' }, variant: { name: 'To Downtown' }, times: { start: '2026-09-25T13:00:00' } };
const previous = { type: 'walk', to: { stop: { key: 1 } } };
const stats = { observations: 60, distinctDates: 6, coverageStart: '2026-09-01', coverageEnd: '2026-09-24', medianSeconds: 90, p10Seconds: -120, p90Seconds: 600, earlyShare: .2, withinShare: .6, lateShare: .2, beforeScheduleShare: .3, shareIntervals: [[.1,.3],[.5,.7],[.1,.3]], nearbyFullBusReports: 2 };
const key = '["BLUE","1","downtown","weekday",12]';
const data: Artifact = { grouping: GROUPING, schemaVersion: 1, routes: ['BLUE'], coverageEnd: '2026-09-24', groups: { [key]: stats } };
test('exact match, Winnipeg conversion and adjacent boarding', () => {
  assert.equal(reliabilityForRide(ride, previous, data, now).status, 'available');
  assert.deepEqual(winnipegTime('2026-09-26T02:00:00Z'), { date: '2026-09-25', month: 9, weekend: false, hour: 21 });
  assert.equal(winnipegTime('2026-02-30T13:00:00'), undefined);
  assert.equal(reliabilityForRide(ride, { ...previous, type: 'ride' }, data, now).status, 'unavailable');
});
test('no direction, weekend, holiday, stale or future leakage fallback', () => {
  for (const changed of [ { variant: { name: 'St. Norbert' } }, { times: { start: '2026-09-26T13:00:00' } }, { times: { start: '2026-09-30T13:00:00' } }, { times: { start: '2026-09-24T13:00:00' } }, { times: { start: '2026-12-01T13:00:00' } } ]) {
    assert.equal(reliabilityForRide({ ...ride, ...changed }, previous, data, now).status, 'unavailable');
  }
  assert.equal(reliabilityForRide(ride, previous, data, new Date('2026-11-01')).status, 'unavailable');
});
test('real API variant prefix maps only the matching route name', () => {
  const actual = { ...ride, route: { key: 'BLUE', name: 'Route BLUE' }, variant: { name: 'BLUE to Downtown' } };
  assert.equal(reliabilityForRide(actual, previous, data, now).status, 'available');
  assert.equal(reliabilityForRide({ ...actual, variant: { name: 'Other route to Downtown' } }, previous, data, now).status, 'unavailable');
});
test('bad samples and missing artifacts fail open', () => {
  assert.equal(loadArtifact('/does/not/exist'), undefined);
  for (const invalid of [{ observations: 29 }, { distinctDates: 4 }, { earlyShare: NaN }, { shareIntervals: [] }]) {
    assert.equal(reliabilityForRide(ride, previous, { ...data, groups: { [key]: { ...stats, ...invalid } } }, now).status, 'unavailable');
  }
  const input = [{ segments: [previous, ride] }];
  const enriched = enrichPlans(input, data, now) as any[];
  assert.equal(enriched[0].segments[1].reliability.status, 'available');
  assert.equal('reliability' in ride, false);
  assert.equal(enriched[0].segments[0], previous);
});

test('any source route can match, including routes outside the original pilot', () => {
  for (const route of ['F6', '22', 'D10']) {
    const expanded = { ...data, routes: [route], groups: { [JSON.stringify([route, '1', 'downtown', 'weekday', 12])]: stats } };
    const actual = { ...ride, route: { key: route, name: `Route ${route} Example` }, variant: { name: 'Example to Downtown' } };
    assert.equal(reliabilityForRide(actual, previous, expanded, now).status, 'available');
    assert.equal(reliabilityForRide({ ...actual, variant: { name: 'Example to Other place' } }, previous, expanded, now).status, 'unavailable');
  }
});

test('two-hour bins: every time from 12:00 to 13:59 shares one group, neighbours do not', () => {
  for (const start of ['2026-09-25T12:00:00', '2026-09-25T12:59:00', '2026-09-25T13:40:00', '2026-09-25T13:59:59']) {
    const result = reliabilityForRide({ ...ride, times: { start } }, previous, data, now);
    assert.equal(result.status, 'available', start);
    assert.equal((result as { hour: number }).hour, 12);
  }
  for (const start of ['2026-09-25T11:59:00', '2026-09-25T14:00:00']) assert.equal(reliabilityForRide({ ...ride, times: { start } }, previous, data, now).status, 'unavailable');
});
test('artifacts built with a different grouping are never read', () => {
  for (const grouping of [undefined, 'route-stop-destination-daytype-hour-v1']) assert.equal(reliabilityForRide(ride, previous, { ...data, grouping }, now).status, 'unavailable');
});
