import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { artifactGroups, GROUPING, type Sharded } from './artifactGroups.js';

/** Deployed visit-based categories. Report-count schema 3 is handled separately. */
export const POLICY_VERSION = 'reported-pattern-v2';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
type ProfileEvidence = { reportedVisits: number; reportDates: number };
type Evidence = {
  level: RiskLevel;
  recordedVisits: number;
  distinctDates: number;
  coverageEnd: string;
  profiles: Record<string, ProfileEvidence>;
};
export type RiskArtifact = Sharded<Evidence> & {
  grouping?: string;
  schemaVersion: number;
  coverageEnd: string;
  policy: { version: string };
  sources: { departures: { sha256: string } };
};

const MIN_VISITS = 60;
const MIN_DATES = 10;
const ZERO_REPORT_MIN_VISITS = 120;
const SCORE_PENALTY_VISITS = 50;
const MEDIUM_SCORE = 0.01;
const HIGH_SCORE = 0.025;
const MIN_MEDIUM_REPORT_DATES = 2;
const MIN_HIGH_REPORT_DATES = 3;
const MATCHING_PROFILES = ['60m_120s', '100m_180s', '150m_300s'];

export function loadRisk(path: string): RiskArtifact | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (![1, 2].includes(value?.schemaVersion) || value.policy?.version !== POLICY_VERSION) return undefined;
    if (value.schemaVersion === 2 && (!value.routeFiles || typeof value.routeFiles !== 'object')) return undefined;
    if (!value.groups || typeof value.sources?.departures?.sha256 !== 'string') return undefined;
    return { ...value, rootDirectory: dirname(path) };
  } catch {
    return undefined;
  }
}

const defaultPath = fileURLToPath(new URL('../data/passup-risk.json', import.meta.url));
const artifact = loadRisk(process.env.PASSUP_RISK_DATA_PATH ?? defaultPath);

function validEvidence(evidence: Evidence | undefined, cutoff: string): evidence is Evidence {
  if (!evidence || !['low', 'medium', 'high'].includes(evidence.level)) return false;
  if (!Number.isFinite(Date.parse(evidence.coverageEnd)) || evidence.coverageEnd > cutoff) return false;
  if (!Number.isInteger(evidence.recordedVisits) || evidence.recordedVisits < MIN_VISITS) return false;
  if (!Number.isInteger(evidence.distinctDates) || evidence.distinctDates < MIN_DATES) return false;
  return evidence.distinctDates <= evidence.recordedVisits;
}

function validProfile(profile: ProfileEvidence | undefined, evidence: Evidence): profile is ProfileEvidence {
  if (!profile || !Number.isInteger(profile.reportedVisits) || profile.reportedVisits < 0) return false;
  if (profile.reportedVisits > evidence.recordedVisits) return false;
  if (!Number.isInteger(profile.reportDates) || profile.reportDates < 0) return false;
  return profile.reportDates <= Math.min(profile.reportedVisits, evidence.distinctDates);
}

function profileLevel(recordedVisits: number, profile: ProfileEvidence): RiskLevel {
  if (profile.reportedVisits === 0) return recordedVisits >= ZERO_REPORT_MIN_VISITS ? 'low' : 'unknown';
  const score = profile.reportedVisits / (recordedVisits + SCORE_PENALTY_VISITS);
  if (score >= HIGH_SCORE) return profile.reportDates >= MIN_HIGH_REPORT_DATES ? 'high' : 'unknown';
  if (score >= MEDIUM_SCORE) return profile.reportDates >= MIN_MEDIUM_REPORT_DATES ? 'medium' : 'unknown';
  return 'low';
}

export function passupRisk(key: string, cutoff: string, departureHash?: string, data = artifact): { level: RiskLevel; basis: string } {
  const unknown = { level: 'unknown' as const, basis: 'insufficient_or_unstable_history' };
  if (!data || data.policy?.version !== POLICY_VERSION || data.grouping !== GROUPING) return unknown;
  if (data.coverageEnd !== cutoff || !departureHash || data.sources?.departures?.sha256 !== departureHash) return unknown;

  let route: string;
  try {
    route = String(JSON.parse(key)[0]);
  } catch {
    route = ''; // Inline artifacts do not need a route shard to resolve the key.
  }
  const evidence = artifactGroups(data, route)[key];
  if (!validEvidence(evidence, cutoff)) return unknown;
  for (const name of MATCHING_PROFILES) {
    const profile = evidence.profiles?.[name];
    if (!validProfile(profile, evidence) || profileLevel(evidence.recordedVisits, profile) !== evidence.level) return unknown;
  }
  return { level: evidence.level, basis: 'relative_historical_reports' };
}
