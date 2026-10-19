import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactGroups, GROUPING, type Sharded } from './artifactGroups.js';
import { dateUnavailableReason, isCalendarDate } from './reliabilityTime.js';

const EVIDENCE_VERSION = 'stop-report-counts-v1';
const MATCHING_METHOD = 'nearest-stop-report-time-v1';
const SPATIAL_PROFILES = ['60m', '100m', '150m'] as const;

type Profile = { reports: number; reportDates: number };
export type ReportEvidence = {
  reportCount: number;
  reportDates: number;
  coverageStart: string | null;
  coverageEnd: string | null;
  recordedDepartures: number;
  departureDates: number;
  referenceCoverageStart: string | null;
  referenceCoverageEnd: string | null;
  profiles: Record<typeof SPATIAL_PROFILES[number], Profile>;
};

export type ReportArtifact = Sharded<ReportEvidence> & {
  schemaVersion: 3;
  grouping: string;
  groupWindowMinutes: number;
  evidenceVersion: string;
  evidenceUnit: string;
  groupTimeBasis: string;
  referenceTimeBasis: string;
  labelStatus: string;
  passupMatchingMethod: string;
  coverageStart: string;
  coverageEnd: string;
  routes: string[];
  sources: { departures: { sha256: string } };
};

export function loadReportArtifact(path: string): ReportArtifact | undefined {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data?.schemaVersion !== 3 || data.grouping !== GROUPING || data.groupWindowMinutes !== 120) return undefined;
    if (data.evidenceVersion !== EVIDENCE_VERSION || data.passupMatchingMethod !== MATCHING_METHOD) return undefined;
    if (data.evidenceUnit !== 'unique-report-id' || data.groupTimeBasis !== 'reported-local-time') return undefined;
    if (data.referenceTimeBasis !== 'scheduled-local-time' || data.labelStatus !== 'pending_policy_review') return undefined;
    if (!isCalendarDate(data.coverageStart) || !isCalendarDate(data.coverageEnd) || data.coverageStart > data.coverageEnd) return undefined;
    if (!Array.isArray(data.routes) || !data.routes.every((route: unknown) => typeof route === 'string')) return undefined;
    if (!data.groups || typeof data.groups !== 'object' || Array.isArray(data.groups)) return undefined;
    if (!data.routeFiles || typeof data.routeFiles !== 'object' || Array.isArray(data.routeFiles)) return undefined;
    if (typeof data.sources?.departures?.sha256 !== 'string' || !data.sources.departures.sha256) return undefined;
    return { ...data, rootDirectory: dirname(path) };
  } catch {
    return undefined;
  }
}

const defaultPath = fileURLToPath(new URL('../data/passup-report-counts.json', import.meta.url));
const artifact = loadReportArtifact(process.env.PASSUP_REPORT_DATA_PATH ?? defaultPath);

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function validCoverage(count: number, dates: number, start: unknown, end: unknown, cutoff: string): boolean {
  if (!isCount(count) || !isCount(dates) || dates > count) return false;
  if (count === 0) return dates === 0 && start === null && end === null;
  return dates > 0 && isCalendarDate(start) && isCalendarDate(end) && start <= end && end <= cutoff;
}

function validEvidence(evidence: ReportEvidence | undefined, cutoff: string): evidence is ReportEvidence {
  if (!evidence) return false;
  if (!validCoverage(evidence.reportCount, evidence.reportDates, evidence.coverageStart, evidence.coverageEnd, cutoff)) return false;
  if (!validCoverage(evidence.recordedDepartures, evidence.departureDates, evidence.referenceCoverageStart, evidence.referenceCoverageEnd, cutoff)) return false;

  let previousReports = 0;
  let previousDates = 0;
  for (const name of SPATIAL_PROFILES) {
    const profile = evidence.profiles?.[name];
    if (!profile || !isCount(profile.reports) || !isCount(profile.reportDates)) return false;
    if (profile.reportDates > profile.reports || (profile.reports > 0 && profile.reportDates === 0)) return false;
    if (profile.reports < previousReports || profile.reportDates < previousDates) return false;
    previousReports = profile.reports;
    previousDates = profile.reportDates;
  }
  return previousReports === evidence.reportCount && previousDates === evidence.reportDates;
}

function unavailable(reason: string) {
  return { status: 'unavailable' as const, reason };
}

/** Serve report evidence only. Category selection remains pending; counts are never probabilities. */
export function reportCountsForGroup(
  groupKey: string,
  tripDate: string,
  expectedDepartureHash?: string,
  now = new Date(),
  data = artifact,
) {
  if (!data) return unavailable('data_unavailable');
  // Also check identity when tests or internal callers supply an artifact directly.
  if (data.schemaVersion !== 3 || data.grouping !== GROUPING || data.evidenceVersion !== EVIDENCE_VERSION ||
      data.passupMatchingMethod !== MATCHING_METHOD || data.evidenceUnit !== 'unique-report-id' ||
      data.groupTimeBasis !== 'reported-local-time' || data.referenceTimeBasis !== 'scheduled-local-time' ||
      data.groupWindowMinutes !== 120 || data.labelStatus !== 'pending_policy_review') {
    return unavailable('incompatible_report_evidence');
  }
  if (expectedDepartureHash && data.sources?.departures?.sha256 !== expectedDepartureHash) {
    return unavailable('source_mismatch');
  }
  const dateReason = dateUnavailableReason(data.coverageEnd, tripDate, now);
  if (dateReason) return unavailable(dateReason);

  let route: string;
  try {
    const context = JSON.parse(groupKey);
    if (!Array.isArray(context) || context.length !== 5 || typeof context[0] !== 'string') return unavailable('boarding_context_missing');
    route = context[0];
  } catch {
    return unavailable('boarding_context_missing');
  }
  if (!data.routes.includes(route)) return unavailable('route_without_history');
  const evidence = artifactGroups(data, route)[groupKey];
  if (!evidence) return unavailable('report_group_without_history');
  if (!validEvidence(evidence, data.coverageEnd)) return unavailable('data_unavailable');

  return {
    status: 'available' as const,
    evidenceUnit: 'unique-report-id' as const,
    groupTimeBasis: 'reported-local-time' as const,
    referenceTimeBasis: 'scheduled-local-time' as const,
    labelStatus: 'pending_policy_review' as const,
    reportCount: evidence.reportCount,
    reportDates: evidence.reportDates,
    coverageStart: evidence.coverageStart,
    coverageEnd: evidence.coverageEnd,
    recordedDepartures: evidence.recordedDepartures,
    departureDates: evidence.departureDates,
    referenceCoverageStart: evidence.referenceCoverageStart,
    referenceCoverageEnd: evidence.referenceCoverageEnd,
    profiles: evidence.profiles,
  };
}
