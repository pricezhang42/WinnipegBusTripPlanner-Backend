/**
 * Winnipeg Transit service-day calendar for historical comparisons.
 *
 * Historical groups only pool ordinary weekday/weekend service, so any date that
 * may run holiday or special service is listed here and excluded. Dates outside
 * `validFrom`–`validThrough` are unsupported rather than assumed ordinary. Bump
 * `version` whenever the list or coverage changes (see README "Service calendar").
 */
export type ServiceExclusion = {
  date: string;
  name: string;
  /** `observed` marks a weekday substitute for a weekend holiday, kept as a conservative exclusion. */
  kind: 'holiday' | 'observed';
};

export type ServiceCalendar = {
  version: string;
  validFrom: string;
  validThrough: string;
  exclusions: ServiceExclusion[];
};

export const SERVICE_CALENDAR: ServiceCalendar = {
  version: 'winnipeg-service-2026-2027-v1',
  validFrom: '2026-01-01',
  validThrough: '2027-12-31',
  exclusions: [
    { date: '2026-01-01', name: "New Year's Day", kind: 'holiday' },
    { date: '2026-02-16', name: 'Louis Riel Day', kind: 'holiday' },
    { date: '2026-04-03', name: 'Good Friday', kind: 'holiday' },
    { date: '2026-05-18', name: 'Victoria Day', kind: 'holiday' },
    { date: '2026-07-01', name: 'Canada Day', kind: 'holiday' },
    { date: '2026-08-03', name: 'Terry Fox Day', kind: 'holiday' },
    { date: '2026-09-07', name: 'Labour Day', kind: 'holiday' },
    { date: '2026-09-30', name: 'National Day for Truth and Reconciliation', kind: 'holiday' },
    { date: '2026-10-12', name: 'Thanksgiving', kind: 'holiday' },
    { date: '2026-11-11', name: 'Remembrance Day', kind: 'holiday' },
    { date: '2026-12-25', name: 'Christmas Day', kind: 'holiday' },
    { date: '2026-12-26', name: 'Boxing Day', kind: 'holiday' },
    { date: '2026-12-28', name: 'Boxing Day (observed)', kind: 'observed' },
    { date: '2027-01-01', name: "New Year's Day", kind: 'holiday' },
    { date: '2027-02-15', name: 'Louis Riel Day', kind: 'holiday' },
    { date: '2027-03-26', name: 'Good Friday', kind: 'holiday' },
    { date: '2027-05-24', name: 'Victoria Day', kind: 'holiday' },
    { date: '2027-07-01', name: 'Canada Day', kind: 'holiday' },
    { date: '2027-08-02', name: 'Terry Fox Day', kind: 'holiday' },
    { date: '2027-09-06', name: 'Labour Day', kind: 'holiday' },
    { date: '2027-09-30', name: 'National Day for Truth and Reconciliation', kind: 'holiday' },
    { date: '2027-10-11', name: 'Thanksgiving', kind: 'holiday' },
    { date: '2027-11-11', name: 'Remembrance Day', kind: 'holiday' },
    { date: '2027-12-25', name: 'Christmas Day', kind: 'holiday' },
    { date: '2027-12-26', name: 'Boxing Day', kind: 'holiday' },
    { date: '2027-12-27', name: 'Christmas Day (observed)', kind: 'observed' },
    { date: '2027-12-28', name: 'Boxing Day (observed)', kind: 'observed' },
  ],
};

export type ServiceDayStatus = 'ordinary' | 'excluded' | 'unsupported';

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** List every problem; an invalid calendar supports no dates. */
export function calendarProblems(calendar: ServiceCalendar): string[] {
  const problems: string[] = [];
  if (typeof calendar.version !== 'string' || !calendar.version) problems.push('missing version');
  if (!isCalendarDate(calendar.validFrom) || !isCalendarDate(calendar.validThrough) || calendar.validFrom > calendar.validThrough) {
    problems.push('invalid coverage range');
  }
  let previous = '';
  for (const exclusion of calendar.exclusions ?? []) {
    if (!isCalendarDate(exclusion.date)) problems.push(`invalid date ${String(exclusion.date)}`);
    else if (exclusion.date < calendar.validFrom || exclusion.date > calendar.validThrough) problems.push(`${exclusion.date} outside coverage`);
    else if (exclusion.date <= previous) problems.push(`${exclusion.date} duplicated or out of order`);
    if (!exclusion.name) problems.push(`${exclusion.date} has no name`);
    if (exclusion.kind !== 'holiday' && exclusion.kind !== 'observed') problems.push(`${exclusion.date} has unknown kind`);
    previous = exclusion.date;
  }
  return problems;
}

const checked = new WeakMap<ServiceCalendar, Set<string> | undefined>();

function excludedDates(calendar: ServiceCalendar) {
  if (!checked.has(calendar)) {
    checked.set(calendar, calendarProblems(calendar).length ? undefined : new Set(calendar.exclusions.map(item => item.date)));
  }
  return checked.get(calendar);
}

/** Classify a Winnipeg local calendar date (YYYY-MM-DD). */
export function serviceDayStatus(date: string, calendar = SERVICE_CALENDAR): ServiceDayStatus {
  const excluded = excludedDates(calendar);
  if (!excluded || !isCalendarDate(date) || date < calendar.validFrom || date > calendar.validThrough) return 'unsupported';
  return excluded.has(date) ? 'excluded' : 'ordinary';
}
