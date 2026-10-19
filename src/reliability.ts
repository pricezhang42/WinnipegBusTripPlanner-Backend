import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { artifactGroups, GROUPING, type Sharded } from './artifactGroups.js';
import { passupRisk } from './passupRisk.js';
import { reportCountsForGroup, type ReportArtifact } from './passupReports.js';
import {
  binStartHour, dateUnavailableReason, GROUP_WINDOW_MINUTES, isCalendarDate, winnipegTime,
} from './reliabilityTime.js';

// Existing imports can keep using these helpers from the orchestration module.
export { binStartHour, winnipegTime } from './reliabilityTime.js';

const MIN_OBSERVATIONS = 30;
const MIN_DATES = 5;
const SHARE_SUM_TOLERANCE = 0.00001;

export type Statistics = {
  observations: number;
  distinctDates: number;
  coverageStart: string;
  coverageEnd: string;
  medianSeconds: number;
  p10Seconds: number;
  p90Seconds: number;
  earlyShare: number;
  withinShare: number;
  lateShare: number;
  beforeScheduleShare: number;
  shareIntervals: number[][];
  nearbyFullBusReports: number;
};

export type Artifact = Sharded<Statistics> & {
  grouping?: string;
  sources?: { departures?: { sha256?: string } };
  schemaVersion: number;
  coverageEnd: string;
  routes: string[];
};

export type Ride = {
  type?: string;
  from?: { stop?: { key?: string | number } };
  to?: { stop?: { key?: string | number } };
  route?: { key?: string | number; name?: string };
  variant?: { name?: string };
  times?: { start?: string };
};

export type BoardingContext = {
  route: string;
  boardingStop: string;
  destination: string;
  date: string;
  dayType: 'weekday' | 'weekend';
  hour: number;
  groupKey: string;
};

export type TimingUnavailableReason =
  | 'data_unavailable' | 'route_without_history' | 'boarding_context_missing'
  | 'data_outdated' | 'historical_date_unsupported' | 'holiday_calendar_unsupported'
  | 'insufficient_comparable_history';

function unavailable(reason: TimingUnavailableReason) {
  return { status: 'unavailable' as const, reason };
}

export function loadArtifact(path: string): Artifact | undefined {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || ![1, 2].includes(data.schemaVersion) || !Array.isArray(data.routes)) return undefined;
    if (!data.routes.every((route: unknown) => typeof route === 'string')) return undefined;
    if (!data.groups || typeof data.groups !== 'object' || Array.isArray(data.groups)) return undefined;
    if (!isCalendarDate(data.coverageEnd)) return undefined;
    if (data.schemaVersion === 2 && (!data.routeFiles || typeof data.routeFiles !== 'object' || Array.isArray(data.routeFiles))) {
      return undefined;
    }
    return { ...data, rootDirectory: dirname(path) };
  } catch {
    return undefined;
  }
}

const defaultArtifactPath = fileURLToPath(new URL('../data/reliability.json', import.meta.url));
// Manifests are loaded at startup; deployments must replace a complete artifact set and restart.
const artifact = loadArtifact(process.env.RELIABILITY_DATA_PATH ?? defaultArtifactPath);

function variantDestination(ride: Ride): string | undefined {
  const variant = ride.variant?.name?.trim().toLowerCase();
  if (!variant) return undefined;

  let routeName = ride.route?.name?.trim().toLowerCase().replace(/^route\s+/, '');
  const routeKey = String(ride.route?.key ?? '').toLowerCase();
  const namedPrefix = routeName?.match(/^(\S+)\s+(.*)$/s);
  if (namedPrefix?.[1] === routeKey) routeName = namedPrefix[2];
  const destinationPrefix = routeName ? `${routeName} to ` : undefined;
  // Remove only the exact route display prefix; never merge different branches fuzzily.
  if (destinationPrefix && variant.startsWith(destinationPrefix)) return variant.slice(destinationPrefix.length);
  return variant.replace(/^to\s+/, '');
}

export function boardingContext(ride: Ride, previous?: Ride): BoardingContext | undefined {
  const route = String(ride.route?.key ?? '');
  const stop = ride.from?.stop?.key ?? (previous?.type !== 'ride' ? previous?.to?.stop?.key : undefined);
  const destination = variantDestination(ride);
  const time = winnipegTime(ride.times?.start ?? '');
  if (!route || stop == null || !destination || !time) return undefined;

  const boardingStop = String(stop);
  const dayType = time.weekend ? 'weekend' : 'weekday';
  const hour = binStartHour(time.hour);
  const groupKey = JSON.stringify([route, boardingStop, destination, dayType, hour]);
  return { route, boardingStop, destination, date: time.date, dayType, hour, groupKey };
}

function isShare(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validStatistics(stats: Statistics | undefined): stats is Statistics {
  if (!stats || !Number.isInteger(stats.observations) || stats.observations < MIN_OBSERVATIONS) return false;
  if (!Number.isInteger(stats.distinctDates) || stats.distinctDates < MIN_DATES || stats.distinctDates > stats.observations) return false;
  if (!isCalendarDate(stats.coverageStart) || !isCalendarDate(stats.coverageEnd) || stats.coverageStart > stats.coverageEnd) return false;

  const offsets = [stats.p10Seconds, stats.medianSeconds, stats.p90Seconds];
  if (!offsets.every(Number.isFinite) || stats.p10Seconds > stats.medianSeconds || stats.medianSeconds > stats.p90Seconds) return false;

  const shares = [stats.earlyShare, stats.withinShare, stats.lateShare];
  if (!shares.every(isShare) || !isShare(stats.beforeScheduleShare)) return false;
  if (Math.abs(shares.reduce((total, share) => total + share, 0) - 1) >= SHARE_SUM_TOLERANCE) return false;
  if (!Number.isInteger(stats.nearbyFullBusReports) || stats.nearbyFullBusReports < 0) return false;

  return Array.isArray(stats.shareIntervals) && stats.shareIntervals.length === 3 && stats.shareIntervals.every(interval =>
    Array.isArray(interval) && interval.length === 2 && isShare(interval[0]) && isShare(interval[1]) && interval[0] <= interval[1],
  );
}

export function reliabilityForRide(ride: Ride, previous?: Ride, data = artifact, now = new Date()) {
  if (!data || data.grouping !== GROUPING) return unavailable('data_unavailable');
  if (!data.routes.includes(String(ride.route?.key ?? ''))) return unavailable('route_without_history');

  const context = boardingContext(ride, previous);
  if (!context) return unavailable('boarding_context_missing');
  const dateReason = dateUnavailableReason(data.coverageEnd, context.date, now);
  if (dateReason) return unavailable(dateReason);

  const stats = artifactGroups(data, context.route)[context.groupKey];
  if (!stats) return unavailable('insufficient_comparable_history');
  if (!validStatistics(stats) || stats.coverageEnd >= context.date) return unavailable('data_unavailable');

  // Keep the deployed visit-based category isolated from new report-count evidence.
  const risk = passupRisk(context.groupKey, data.coverageEnd, data.sources?.departures?.sha256);
  return {
    status: 'available' as const,
    ...stats,
    passupRisk: risk,
    hour: context.hour,
    windowMinutes: GROUP_WINDOW_MINUTES,
    dayType: context.dayType,
    boardingStop: context.boardingStop,
    destination: context.destination,
  };
}

function enrichRide(ride: Ride, previous: Ride | undefined, data: Artifact | undefined, now: Date, reportData?: ReportArtifact) {
  let reliability: ReturnType<typeof reliabilityForRide>;
  try {
    reliability = reliabilityForRide(ride, previous, data, now);
  } catch {
    reliability = unavailable('data_unavailable');
  }

  // Report evidence remains available even if this timing group misses timing sample minimums.
  let passupReports: ReturnType<typeof reportCountsForGroup>;
  try {
    const context = boardingContext(ride, previous);
    passupReports = context
      ? reportCountsForGroup(context.groupKey, context.date, data?.sources?.departures?.sha256, now, reportData)
      : { status: 'unavailable', reason: 'boarding_context_missing' };
  } catch {
    passupReports = { status: 'unavailable', reason: 'data_unavailable' };
  }
  return { ...ride, reliability, passupReports };
}

export function enrichPlans(plans: unknown[], data = artifact, now = new Date(), reportData?: ReportArtifact) {
  return plans.map(plan => {
    if (!plan || typeof plan !== 'object' || !Array.isArray((plan as { segments?: unknown }).segments)) return plan;
    const value = plan as { segments: Ride[] };
    const segments = value.segments.map((ride, index) =>
      ride?.type === 'ride' ? enrichRide(ride, value.segments[index - 1], data, now, reportData) : ride,
    );
    return { ...value, segments };
  });
}
