import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { artifactGroups } from './artifactGroups.js';
import { loadArtifact } from './reliability.js';
import { loadReportArtifact, reportCountsForGroup, type ReportEvidence } from './passupReports.js';
import { REPORT_POLICY, reportRisk } from './passupReportRisk.js';

test('shipped report shards match the analysis policy audit and timing source', () => {
  const dataPath = (name: string) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));
  const data = loadReportArtifact(dataPath('passup-report-counts.json'));
  const timing = loadArtifact(dataPath('reliability.json'));
  const audit = JSON.parse(readFileSync(dataPath('passup-policy-report.json'), 'utf8'));
  assert.ok(data);
  assert.ok(timing);
  assert.deepEqual(data.policy, REPORT_POLICY);
  assert.deepEqual(audit.policy, REPORT_POLICY);
  assert.equal(data.coverageEnd, timing.coverageEnd);
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  let total = 0;
  for (const route of data.routes) {
    const groups: Record<string, ReportEvidence> = artifactGroups(data, route);
    assert.ok(Object.keys(groups).length > 0, `Missing/empty report shard for ${route}`);
    for (const key of Object.keys(groups)) {
      const dayType = JSON.parse(key)[3];
      const tripDate = dayType === 'weekend' ? '2026-09-26' : '2026-09-25';
      const evidence = reportCountsForGroup(key, tripDate, timing.sources?.departures?.sha256,
        new Date('2026-09-25'), data);
      assert.equal(evidence.status, 'available', key);
      if (evidence.status !== 'available') continue;
      counts[reportRisk(evidence).level]++;
      total++;
    }
  }
  assert.equal(total, audit.groups);
  assert.deepEqual(counts, audit.labelCounts);
});
