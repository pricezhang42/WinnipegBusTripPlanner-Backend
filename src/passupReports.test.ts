import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORT_POLICY } from './passupReportRisk.js';
import { GROUPING } from './artifactGroups.js';
import { enrichPlans, reliabilityForRide, type Artifact } from './reliability.js';
import { loadReportArtifact, reportCountsForGroup, type ReportArtifact, type ReportEvidence } from './passupReports.js';

const now = new Date('2026-09-25T18:00:00Z');
const key = JSON.stringify(['BLUE', '1', 'downtown', 'weekday', 12]);
const evidence: ReportEvidence = {
  reportCount: 5, reportDates: 3,
  coverageStart: '2026-09-01', coverageEnd: '2026-09-24',
  recordedDepartures: 2, departureDates: 2,
  referenceCoverageStart: '2026-09-01', referenceCoverageEnd: '2026-09-24',
  profiles: {
    '60m': { reports: 2, reportDates: 2 },
    '100m': { reports: 4, reportDates: 3 },
    '150m': { reports: 5, reportDates: 3 },
  },
};
function fixture(changes: Partial<ReportEvidence> = {}): ReportArtifact {
  return {
    schemaVersion: 3, grouping: GROUPING, groupWindowMinutes: 120,
    evidenceVersion: 'stop-report-counts-v1', evidenceUnit: 'unique-report-id',
    groupTimeBasis: 'reported-local-time', referenceTimeBasis: 'scheduled-local-time',
    labelStatus: 'approved', policy: REPORT_POLICY, passupMatchingMethod: 'nearest-stop-report-time-v1',
    coverageStart: '2025-07-01', coverageEnd: '2026-09-24', routes: ['BLUE'],
    sources: { departures: { sha256: 'same-file' } },
    groups: { [key]: { ...evidence, ...changes } },
  };
}
function read(data = fixture(), tripDate = '2026-09-25') {
  return reportCountsForGroup(key, tripDate, 'same-file', now, data);
}

test('report counts can exceed recorded departures and never assign labels', () => {
  const result = read();
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  assert.equal(result.reportCount, 5);
  assert.equal(result.recordedDepartures, 2);
  assert.equal(result.labelStatus, 'approved');
  assert.equal('level' in result, false);
  assert.equal('percentage' in result, false);
});

test('reports without reference departures and known zero-report groups stay distinct from missing groups', () => {
  assert.equal(read(fixture({ recordedDepartures: 0, departureDates: 0,
    referenceCoverageStart: null, referenceCoverageEnd: null })).status, 'available');
  assert.equal(read(fixture({ reportCount: 0, reportDates: 0, coverageStart: null, coverageEnd: null,
    profiles: Object.fromEntries(['60m', '100m', '150m'].map(name => [name, { reports: 0, reportDates: 0 }])) as ReportEvidence['profiles'],
  })).status, 'available');
  assert.deepEqual(read({ ...fixture(), groups: {} }), { status: 'unavailable', reason: 'report_group_without_history' });
});

test('rejects incompatible identity, source mismatch, malformed evidence and unsupported dates', () => {
  assert.equal(read({ ...fixture(), evidenceVersion: 'visit-counts' }).status, 'unavailable');
  assert.equal(read({ ...fixture(), labelStatus: 'pending_policy_review' }).status, 'unavailable');
  assert.equal(read({ ...fixture(), policy: { ...REPORT_POLICY, highRatio: .05 } as any }).status, 'unavailable');
  assert.equal(read({ ...fixture(), groupWindowMinutes: 60 }).status, 'unavailable');
  assert.deepEqual(read({ ...fixture(), sources: { departures: { sha256: 'other-file' } } }),
    { status: 'unavailable', reason: 'source_mismatch' });
  for (const changes of [
    { reportCount: -1 }, { reportDates: 0 }, { reportDates: 6 },
    { coverageEnd: '2026-09-25' }, { coverageStart: '2026-02-30' },
    { departureDates: 3 }, { recordedDepartures: 0 },
    { profiles: { ...evidence.profiles, '60m': { reports: 6, reportDates: 3 } } },
    { profiles: { ...evidence.profiles, '150m': { reports: 4, reportDates: 3 } } },
  ]) assert.equal(read(fixture(changes)).status, 'unavailable', JSON.stringify(changes));
  assert.deepEqual(read(fixture(), '2026-09-24'), { status: 'unavailable', reason: 'historical_date_unsupported' });
  assert.deepEqual(read(fixture(), '2026-09-30'), { status: 'unavailable', reason: 'holiday_calendar_unsupported' });
  assert.deepEqual(read(fixture(), '2026-10-25'), { status: 'unavailable', reason: 'data_outdated' });
});

test('validates versioned manifests; ignores undeclared top-level response fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'passup-reports-'));
  try {
    const manifest = join(directory, 'manifest.json');
    // Manifests still declare route files; the store build reads them, the runtime does not.
    const data = { ...fixture(), routeFiles: { BLUE: 'BLUE.json' }, groups: {
      [key]: { ...evidence, level: 'high', percentage: 99, status: 'broken' },
    } };
    writeFileSync(manifest, JSON.stringify(data));
    const loaded = loadReportArtifact(manifest);
    assert.ok(loaded);
    const result = read(loaded);
    assert.equal(result.status, 'available');
    assert.equal('level' in result, false);
    assert.equal('percentage' in result, false);
    writeFileSync(manifest, JSON.stringify({ ...data, schemaVersion: 2 }));
    assert.equal(loadReportArtifact(manifest), undefined);
    assert.equal(loadReportArtifact(join(directory, 'missing')), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('enrichment serves reports independently of timing minimums and does not mutate input', () => {
  const timing: Artifact = {
    schemaVersion: 1, grouping: GROUPING, routes: ['BLUE'], coverageEnd: '2026-09-24',
    sources: { departures: { sha256: 'same-file' } }, groups: {},
  };
  const walk = { type: 'walk', to: { stop: { key: 1 } } };
  const ride = { type: 'ride', route: { key: 'BLUE' }, variant: { name: 'To Downtown' },
    times: { start: '2026-09-25T13:00:00' } };
  const input = [{ segments: [walk, ride] }];
  const output = enrichPlans(input, timing, now, fixture()) as Array<{
    segments: Array<{ reliability?: { status: string; reason?: string }; passupReports?: { status: string }; passupRisk?: { level: string; basis: string } }>;
  }>;
  assert.deepEqual(output[0].segments[1].reliability,
    { status: 'unavailable', reason: 'insufficient_comparable_history' });
  assert.equal(output[0].segments[1].passupReports?.status, 'available');
  assert.equal(output[0].segments[1].passupRisk?.level, 'unknown');
  // Narrow profiles disagree with the broad category but must not veto it.
  const supported = fixture({ recordedDepartures: 200, departureDates: 10 });
  const independent = enrichPlans(input, timing, now, supported) as typeof output;
  assert.equal(independent[0].segments[1].passupRisk?.level, 'high');
  assert.equal(output[0].segments[0], walk);
  assert.equal('reliability' in ride, false);
  assert.equal('passupReports' in ride, false);
  assert.deepEqual(enrichPlans([null, {}, { segments: [ride] }], timing, now, fixture()).slice(0, 2), [null, {}]);
});


test('corrupt timing cannot suppress report evidence, and compatibility stays at the API boundary', () => {
  const walk = { type: 'walk', to: { stop: { key: 1 } } };
  const ride = { type: 'ride', route: { key: 'BLUE' }, variant: { name: 'To Downtown' },
    times: { start: '2026-09-25T13:00:00' } };
  const timing: Artifact = {
    schemaVersion: 1, grouping: GROUPING, routes: ['BLUE'], coverageEnd: '2026-09-24',
    sources: { departures: { sha256: 'same-file' } },
    get groups(): Artifact['groups'] { throw new Error('Broken timing shard'); },
  };
  const reports = fixture({ recordedDepartures: 200, departureDates: 10 });
  assert.deepEqual(reliabilityForRide(ride, walk, timing, now), { status: 'unavailable', reason: 'data_unavailable' });
  const result = enrichPlans([{ segments: [walk, ride] }], timing, now, reports) as any[];
  assert.deepEqual(result[0].segments[1].reliability, { status: 'unavailable', reason: 'data_unavailable' });
  assert.equal(result[0].segments[1].passupReports.status, 'available');
  assert.equal(result[0].segments[1].passupRisk.level, 'high');
});
