import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GROUPING } from './artifactGroups.js';
import { POLICY_VERSION, passupRisk, loadRisk, type RiskArtifact } from './passupRisk.js';
const profiles = ['60m_120s', '100m_180s', '150m_300s'];
function fixture(level: string, count: number, days: number): RiskArtifact {
  return { grouping: GROUPING, schemaVersion: 1, coverageEnd: '2026-09-24', policy: { version: POLICY_VERSION }, sources: { departures: { sha256: 'same-file' } }, groups: { x: { level: level as any, recordedVisits: 120, distinctDates: 12, coverageEnd: '2026-09-24', profiles: Object.fromEntries(profiles.map(p => [p, { reportedVisits: count, reportDates: days }])) } } };
}
const read = (data: RiskArtifact) => passupRisk('x', '2026-09-24', 'same-file', data).level;
test('returns only evidence-backed historical categories', () => {
  assert.equal(read(fixture('low', 0, 0)), 'low');
  assert.equal(read(fixture('medium', 3, 2)), 'medium');
  assert.equal(read(fixture('high', 5, 3)), 'high');
  assert.equal(read(fixture('high', 5, 1)), 'unknown');
});
test('missing, mismatched, unstable or malformed artifacts cannot assign risk', () => {
  assert.equal(loadRisk('/missing-risk-file'), undefined);
  const data = fixture('high', 5, 3);
  assert.equal(passupRisk('x', '2026-09-23', 'same-file', data).level, 'unknown');
  assert.equal(passupRisk('x', '2026-09-24', 'different-file', data).level, 'unknown');
  assert.equal(passupRisk('absent', '2026-09-24', 'same-file', data).level, 'unknown');
  data.groups.x.profiles['60m_120s'] = { reportedVisits: 0, reportDates: 0 };
  assert.equal(read(data), 'unknown');
  assert.equal(read({ ...fixture('low', 0, 0), grouping: 'route-stop-destination-daytype-hour-v1' }), 'unknown');
  const invalid = fixture('low', 0, 0); invalid.groups.x.recordedVisits = NaN;
  assert.equal(read(invalid), 'unknown');
});
test('artifacts from the older reported-pattern-v1 policy are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'risk-policy-'));
  try {
    for (const version of ['reported-pattern-v1', POLICY_VERSION]) {
      writeFileSync(join(root, 'risk.json'), JSON.stringify({ ...fixture('low', 0, 0), policy: { version } }));
      assert.equal(loadRisk(join(root, 'risk.json')) === undefined, version !== POLICY_VERSION);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
