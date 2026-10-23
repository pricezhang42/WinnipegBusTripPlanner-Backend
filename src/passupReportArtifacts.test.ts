import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reliabilityStore } from './reliabilityStore.js';
import { storeArtifact } from './reliability.js';
import { reportCountsForGroup, storeReportArtifact } from './passupReports.js';
import { REPORT_POLICY, reportRisk } from './passupReportRisk.js';

// Uses the pinned store: run `node scripts/fetch-reliability-store.mjs` first.
test('pinned report evidence matches the analysis policy audit and timing source', () => {
  assert.ok(reliabilityStore, 'reliability/reliability.sqlite is missing or unreadable');
  const data = storeReportArtifact(reliabilityStore);
  const timing = storeArtifact(reliabilityStore);
  const audit = reliabilityStore.manifest('audit:passup-policy-report.json') as
    { policy: unknown; groups: number; labelCounts: Record<string, number> } | undefined;
  assert.ok(data);
  assert.ok(timing);
  assert.ok(audit, 'store has no policy audit');
  assert.deepEqual(data.policy, REPORT_POLICY);
  assert.deepEqual(audit.policy, REPORT_POLICY);
  assert.equal(data.coverageEnd, timing.coverageEnd);
  const routes = new Set(data.routes);
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  let total = 0;
  for (const key of reliabilityStore.keys('reports')) {
    const [route, , , dayType] = JSON.parse(key);
    routes.delete(route);
    const tripDate = dayType === 'weekend' ? '2026-09-26' : '2026-09-25';
    const evidence = reportCountsForGroup(key, tripDate, timing.sources?.departures?.sha256,
      new Date('2026-09-25'), data);
    assert.equal(evidence.status, 'available', key);
    if (evidence.status !== 'available') continue;
    counts[reportRisk(evidence).level]++;
    total++;
  }
  assert.deepEqual([...routes], [], 'routes without report groups');
  assert.equal(total, audit.groups);
  assert.deepEqual(counts, audit.labelCounts);
});
