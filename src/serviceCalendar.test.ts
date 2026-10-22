import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calendarProblems, SERVICE_CALENDAR, serviceDayStatus, type ServiceCalendar } from './serviceCalendar.js';
import { dateUnavailableReason, winnipegTime } from './reliabilityTime.js';
import { GROUPING } from './artifactGroups.js';
import { reliabilityForRide, type Artifact, type Ride } from './reliability.js';

const HOLIDAY_NAMES = [
  "New Year's Day", 'Louis Riel Day', 'Good Friday', 'Victoria Day', 'Canada Day', 'Terry Fox Day',
  'Labour Day', 'National Day for Truth and Reconciliation', 'Thanksgiving', 'Remembrance Day',
  'Christmas Day', 'Boxing Day',
];
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

test('shipped calendar is valid and lists every holiday in each covered year', () => {
  assert.deepEqual(calendarProblems(SERVICE_CALENDAR), []);
  const first = Number(SERVICE_CALENDAR.validFrom.slice(0, 4));
  const last = Number(SERVICE_CALENDAR.validThrough.slice(0, 4));
  for (let year = first; year <= last; year++) {
    const names = SERVICE_CALENDAR.exclusions
      .filter(item => item.kind === 'holiday' && item.date.startsWith(`${year}-`))
      .map(item => item.name);
    assert.deepEqual(names.sort(), [...HOLIDAY_NAMES].sort(), String(year));
  }
  // Observed days only substitute for weekend holidays, on a weekday.
  for (const item of SERVICE_CALENDAR.exclusions.filter(entry => entry.kind === 'observed')) {
    assert.ok(![0, 6].includes(new Date(`${item.date}T00:00:00Z`).getUTCDay()), item.date);
  }
});

test('holidays are excluded; ordinary weekdays and weekends are not', () => {
  for (const date of ['2026-02-16', '2026-09-30', '2026-12-26', '2026-12-28', '2027-03-26', '2027-10-11', '2027-12-27']) {
    assert.equal(serviceDayStatus(date), 'excluded', date);
  }
  // Thursday, Saturday, Sunday and the day after a holiday.
  for (const date of ['2026-10-22', '2026-10-24', '2026-10-25', '2026-10-13', '2027-04-05', '2027-06-12']) {
    assert.equal(serviceDayStatus(date), 'ordinary', date);
  }
});

test('year rollover stays inside coverage and fails closed past it', () => {
  assert.equal(serviceDayStatus('2026-12-31'), 'ordinary');
  assert.equal(serviceDayStatus('2027-01-01'), 'excluded');
  assert.equal(serviceDayStatus('2027-01-02'), 'ordinary');
  assert.equal(serviceDayStatus('2027-12-31'), 'ordinary');
  assert.equal(serviceDayStatus('2028-01-03'), 'unsupported');
  assert.equal(serviceDayStatus('2025-12-31'), 'unsupported');

  const now = new Date('2026-12-21T18:00:00Z');
  assert.equal(dateUnavailableReason('2026-12-20', '2027-01-04', now), undefined);
  assert.equal(dateUnavailableReason('2026-12-20', '2027-01-01', now), 'holiday_calendar_unsupported');
  const ends2026 = { ...SERVICE_CALENDAR, validThrough: '2026-12-31',
    exclusions: SERVICE_CALENDAR.exclusions.filter(item => item.date <= '2026-12-31') };
  assert.equal(dateUnavailableReason('2026-12-20', '2026-12-31', now, ends2026), undefined);
  assert.equal(dateUnavailableReason('2026-12-20', '2027-01-04', now, ends2026), 'holiday_calendar_unsupported');
});

test('an invalid calendar supports no dates', () => {
  const broken: ServiceCalendar[] = [
    { ...SERVICE_CALENDAR, version: '' },
    { ...SERVICE_CALENDAR, validThrough: '2025-12-31' },
    { ...SERVICE_CALENDAR, exclusions: [...SERVICE_CALENDAR.exclusions].reverse() },
    { ...SERVICE_CALENDAR, exclusions: [{ date: '2026-02-30', name: 'Bad', kind: 'holiday' }] },
    { ...SERVICE_CALENDAR, exclusions: [{ date: '2029-01-01', name: 'Outside', kind: 'holiday' }] },
  ];
  for (const calendar of broken) {
    assert.notDeepEqual(calendarProblems(calendar), []);
    assert.equal(serviceDayStatus('2026-10-22', calendar), 'unsupported');
  }
});

test('Winnipeg local date, not UTC, decides the service day', () => {
  // 05:59 UTC on January 1 is still December 31 in Winnipeg (UTC-6).
  assert.equal(winnipegTime('2027-01-01T05:59:00Z')?.date, '2026-12-31');
  assert.equal(winnipegTime('2027-01-01T06:00:00Z')?.date, '2027-01-01');
  // Late evening of Canada Day in Winnipeg (UTC-5) is already July 2 in UTC.
  assert.equal(winnipegTime('2027-07-02T04:30:00Z')?.date, '2027-07-01');

  const key = '["BLUE","1","downtown","weekday",22]';
  const stats = { observations: 60, distinctDates: 6, coverageStart: '2026-12-01', coverageEnd: '2026-12-20', medianSeconds: 90, p10Seconds: -120, p90Seconds: 600, earlyShare: .2, withinShare: .6, lateShare: .2, beforeScheduleShare: .3, shareIntervals: [[.1, .3], [.5, .7], [.1, .3]], nearbyFullBusReports: 0 };
  const data: Artifact = { grouping: GROUPING, schemaVersion: 1, routes: ['BLUE'], coverageEnd: '2026-12-20', groups: { [key]: stats } };
  const ride: Ride = { type: 'ride', route: { key: 'BLUE' }, variant: { name: 'To Downtown' }, from: { stop: { key: 1 } } };
  const now = new Date('2026-12-21T18:00:00Z');
  const at = (start: string) => reliabilityForRide({ ...ride, times: { start } }, undefined, data, now);
  // Thursday December 31, 23:30 local: ordinary weekday service.
  assert.equal(at('2027-01-01T05:30:00Z').status, 'available');
  assert.equal(at('2026-12-31T23:30:00-06:00').status, 'available');
  // Wednesday December 30, 22:30 local, but the UTC date is December 31: still ordinary.
  assert.equal(at('2026-12-31T04:30:00Z').status, 'available');
  // A Monday that is an observed holiday in local time.
  assert.deepEqual(at('2026-12-29T04:30:00Z'), { status: 'unavailable', reason: 'holiday_calendar_unsupported' });
});

test('calendar covers the full trip horizon of every shipped artifact', () => {
  for (const name of ['reliability.json', 'passup-report-counts.json']) {
    const { coverageEnd } = JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
    assert.ok(SERVICE_CALENDAR.validFrom <= addDays(coverageEnd, 1), name);
    // Trips may be up to 30 days past the cutoff (see dateUnavailableReason).
    assert.ok(addDays(coverageEnd, 30) <= SERVICE_CALENDAR.validThrough,
      `${name}: extend SERVICE_CALENDAR before releasing data through ${coverageEnd}`);
  }
});
