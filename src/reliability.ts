import { dirname } from 'node:path';
import { artifactGroups, GROUPING, type Sharded } from './artifactGroups.js';
import { passupRisk } from './passupRisk.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Statistics = {
  observations: number; distinctDates: number; coverageStart: string; coverageEnd: string;
  medianSeconds: number; p10Seconds: number; p90Seconds: number;
  earlyShare: number; withinShare: number; lateShare: number; beforeScheduleShare: number;
  shareIntervals: number[][]; nearbyFullBusReports: number;
};
export type Artifact = Sharded<Statistics> & { grouping?: string; sources?: { departures?: { sha256?: string } }; schemaVersion: number; coverageEnd: string; groups: Record<string, Statistics>; routes: string[] };
export type Ride = { type?: string; from?: { stop?: { key?: string | number } }; to?: { stop?: { key?: string | number } }; route?: { key?: string | number; name?: string }; variant?: { name?: string }; times?: { start?: string } };
// Fixed two-hour bins keyed by their even start hour: 16 covers 16:00-17:59.
export const binStartHour = (hour: number) => hour - hour % 2;
const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason });
const DAY = 86400000;
export function loadArtifact(path: string): Artifact | undefined {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (![1, 2].includes(data.schemaVersion) || !Array.isArray(data.routes) || !data.groups || !Number.isFinite(Date.parse(data.coverageEnd))) return undefined;
    if (data.schemaVersion === 2 && (!data.routeFiles || typeof data.routeFiles !== 'object')) return undefined;
    return { ...data, rootDirectory: dirname(path) };
  } catch { return undefined; }
}
// The same data directory is included in both the local checkout and runtime image.
const artifact = loadArtifact(process.env.RELIABILITY_DATA_PATH ?? fileURLToPath(new URL('../data/reliability.json', import.meta.url)));
export function winnipegTime(value: string) {
  let local = value;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return undefined;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const p = (type: string) => parts.find(x => x.type === type)?.value;
    local = `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(local);
  if (!match || +match[2] > 23 || +match[3] > 59 || +(match[4] ?? 0) > 59) return undefined;
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return undefined;
  return { date: match[1], month: date.getUTCMonth() + 1, weekend: date.getUTCDay() % 6 === 0, hour: +match[2] };
}
function validStats(s: Statistics) {
  return s.observations >= 30 && s.distinctDates >= 5 && Number.isFinite(Date.parse(s.coverageStart)) && Number.isFinite(Date.parse(s.coverageEnd)) &&
    [s.medianSeconds, s.p10Seconds, s.p90Seconds].every(Number.isFinite) && s.p10Seconds <= s.medianSeconds && s.medianSeconds <= s.p90Seconds &&
    [s.earlyShare, s.withinShare, s.lateShare, s.beforeScheduleShare].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    Math.abs(s.earlyShare + s.withinShare + s.lateShare - 1) < .00001 && Number.isInteger(s.nearbyFullBusReports) && s.nearbyFullBusReports >= 0 &&
    Array.isArray(s.shareIntervals) && s.shareIntervals.length === 3 && s.shareIntervals.every(v => Array.isArray(v) && v.length === 2 && v[0] >= 0 && v[0] <= v[1] && v[1] <= 1);
}
export function reliabilityForRide(ride: Ride, previous?: Ride, data = artifact, now = new Date()) {
  if (!data || data.grouping !== GROUPING) return unavailable('data_unavailable');
  const route = String(ride.route?.key ?? '');
  if (!data.routes.includes(route)) return unavailable('route_without_history');
  const time = winnipegTime(ride.times?.start ?? '');
  const stop = ride.from?.stop?.key ?? (previous?.type !== 'ride' ? previous?.to?.stop?.key : undefined);
  // Transit variants include the route's display name before 'to'. Only remove
  // that exact prefix; do not fuzzy-match destinations or merge branches.
  const variant = ride.variant?.name?.trim().toLowerCase();
  const routeName = ride.route?.name?.trim().toLowerCase().replace(/^route\s+/, '').replace(new RegExp(`^${route.toLowerCase()}\\s+`), '');
  const prefix = routeName ? `${routeName} to ` : undefined;
  const destination = prefix && variant?.startsWith(prefix) ? variant.slice(prefix.length) : variant?.replace(/^to\s+/, '');
  if (!time || stop == null || !destination) return unavailable('boarding_context_missing');
  const age = (now.getTime() - Date.parse(data.coverageEnd)) / DAY;
  const horizon = (Date.parse(time.date) - Date.parse(data.coverageEnd)) / DAY;
  if (age > 30 || age < 0 || horizon > 30) return unavailable('data_outdated');
  if (horizon <= 0) return unavailable('historical_date_unsupported');
  // Conservative exclusion for the pilot's 2026 calendar. Refresh calendar with each new release.
  if (!time.date.startsWith('2026-') || ['01-01','02-16','04-03','05-18','07-01','08-03','09-07','09-30','10-12','11-11','12-25','12-26'].includes(time.date.slice(5))) return unavailable('holiday_calendar_unsupported');
  const dayType = time.weekend ? 'weekend' : 'weekday';
  const hour = binStartHour(time.hour);
  const groupKey = JSON.stringify([route, String(stop), destination, dayType, hour]);
  const stats = artifactGroups(data, route)[groupKey];
  if (!stats) return unavailable('insufficient_comparable_history');
  if (!validStats(stats) || stats.coverageEnd >= time.date) return unavailable('data_unavailable');
  return { status: 'available' as const, ...stats, passupRisk: passupRisk(groupKey, data.coverageEnd, data.sources?.departures?.sha256), hour, windowMinutes: 120, dayType, boardingStop: String(stop), destination };
}
export function enrichPlans(plans: unknown[], data = artifact, now = new Date()) {
  return plans.map(plan => {
    if (!plan || typeof plan !== 'object' || !Array.isArray((plan as { segments?: unknown }).segments)) return plan;
    const value = plan as { segments: Ride[] };
    return { ...value, segments: value.segments.map((ride, i) => {
      if (ride?.type !== 'ride') return ride;
      // Enrichment must never prevent a valid itinerary from reaching the client.
      try { return { ...ride, reliability: reliabilityForRide(ride, value.segments[i - 1], data, now) }; }
      catch { return { ...ride, reliability: unavailable('data_unavailable') }; }
    }) };
  });
}
