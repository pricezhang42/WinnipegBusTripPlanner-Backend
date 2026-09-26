import { dirname } from 'node:path';
import { artifactGroups, type Sharded } from './artifactGroups.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
type Evidence = { level: RiskLevel; recordedVisits: number; distinctDates: number; coverageEnd: string; profiles: Record<string, { reportedVisits: number; reportDates: number }> };
export type RiskArtifact = Sharded<Evidence> & { schemaVersion: number; coverageEnd: string; policy: { version: string }; sources: { departures: { sha256: string } }; groups: Record<string, Evidence> };
export function loadRisk(path: string): RiskArtifact | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return [1, 2].includes(value?.schemaVersion) && (value.schemaVersion !== 2 || (value.routeFiles && typeof value.routeFiles === 'object')) && value?.policy?.version === 'reported-pattern-v1' && value.groups && typeof value?.sources?.departures?.sha256 === 'string' ? { ...value, rootDirectory: dirname(path) } : undefined;
  } catch { return undefined; }
}
const artifact = loadRisk(process.env.PASSUP_RISK_DATA_PATH ?? fileURLToPath(new URL('../data/passup-risk.json', import.meta.url)));
export function passupRisk(key: string, cutoff: string, departureHash?: string, data = artifact): { level: RiskLevel; basis: string } {
  const unknown = { level: 'unknown' as const, basis: 'insufficient_or_unstable_history' };
  if (!data || data.coverageEnd !== cutoff || !departureHash || data.sources?.departures?.sha256 !== departureHash) return unknown;
  let route: string;
  try { route = String(JSON.parse(key)[0]); } catch { route = ''; }
  const evidence = artifactGroups(data, route)[key];
  if (!evidence || !['low', 'medium', 'high'].includes(evidence.level) || evidence.coverageEnd > cutoff || !Number.isFinite(Date.parse(evidence.coverageEnd)) || !Number.isInteger(evidence.recordedVisits) || !Number.isInteger(evidence.distinctDates) || evidence.recordedVisits < 60 || evidence.distinctDates < 10 || evidence.distinctDates > evidence.recordedVisits) return unknown;
  // Validate exported evidence as well as its label, including zero-report coverage.
  for (const name of ['60m_120s', '100m_180s', '150m_300s']) {
    const p = evidence.profiles?.[name];
    if (!p || !Number.isInteger(p.reportedVisits) || p.reportedVisits < 0 || p.reportedVisits > evidence.recordedVisits || !Number.isInteger(p.reportDates) || p.reportDates < 0 || p.reportDates > Math.min(p.reportedVisits, evidence.distinctDates)) return unknown;
    const score = p.reportedVisits / (evidence.recordedVisits + 50);
    const level = p.reportedVisits === 0 ? (evidence.recordedVisits >= 120 ? 'low' : 'unknown') : score >= .025 ? (p.reportDates >= 3 ? 'high' : 'unknown') : score >= .01 ? (p.reportDates >= 2 ? 'medium' : 'unknown') : 'low';
    if (level !== evidence.level) return unknown;
  }
  return { level: evidence.level, basis: 'relative_historical_reports' };
}
