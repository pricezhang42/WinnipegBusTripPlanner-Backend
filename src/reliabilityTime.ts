/** Historical grouping uses Winnipeg wall-clock dates, including offset-free API times. */
export const WINNIPEG_TIME_ZONE = 'America/Winnipeg';
export const GROUP_WINDOW_HOURS = 2;
export const GROUP_WINDOW_MINUTES = GROUP_WINDOW_HOURS * 60;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_AGE_DAYS = 30;

// Keep the current supported calendar explicit; extending it is tracked separately.
const SUPPORTED_YEAR = '2026';
const HOLIDAYS = new Set([
  '01-01', '02-16', '04-03', '05-18', '07-01', '08-03',
  '09-07', '09-30', '10-12', '11-11', '12-25', '12-26',
]);

export type DateUnavailableReason =
  | 'data_unavailable'
  | 'data_outdated'
  | 'historical_date_unsupported'
  | 'holiday_calendar_unsupported';

/** Round 13:59 down to the 12:00–13:59 group. */
export function binStartHour(hour: number): number {
  return hour - hour % GROUP_WINDOW_HOURS;
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function winnipegTime(value: string) {
  let localTime = value;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (hasOffset) {
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return undefined;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: WINNIPEG_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const part = (name: string) => parts.find(item => item.type === name)?.value;
    localTime = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  }

  const parsed = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(localTime);
  if (!parsed) return undefined;
  const [, date, hourText, minuteText, secondText = '0'] = parsed;
  const hour = Number(hourText);
  if (!isCalendarDate(date) || hour > 23 || Number(minuteText) > 59 || Number(secondText) > 59) {
    return undefined;
  }

  const calendarDate = new Date(`${date}T00:00:00Z`);
  const weekday = calendarDate.getUTCDay();
  return { date, month: calendarDate.getUTCMonth() + 1, weekend: weekday === 0 || weekday === 6, hour };
}

/** Reject stale/future-leaking history before attempting a group lookup. */
export function dateUnavailableReason(coverageEnd: string, tripDate: string, now: Date): DateUnavailableReason | undefined {
  if (!isCalendarDate(coverageEnd) || !isCalendarDate(tripDate) || !Number.isFinite(now.getTime())) {
    return 'data_unavailable';
  }
  const cutoff = Date.parse(coverageEnd);
  const ageDays = (now.getTime() - cutoff) / DAY_MILLISECONDS;
  const tripHorizonDays = (Date.parse(tripDate) - cutoff) / DAY_MILLISECONDS;
  if (ageDays > MAX_HISTORY_AGE_DAYS || ageDays < 0 || tripHorizonDays > MAX_HISTORY_AGE_DAYS) {
    return 'data_outdated';
  }
  if (tripHorizonDays <= 0) return 'historical_date_unsupported';
  if (!tripDate.startsWith(`${SUPPORTED_YEAR}-`) || HOLIDAYS.has(tripDate.slice(5))) {
    return 'holiday_calendar_unsupported';
  }
  return undefined;
}
