import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStore, publishStore, readSources, verifyStore } from './reliability-store.mjs';
import { fetchStore } from './fetch-reliability-store.mjs';
import { openReliabilityStore } from '../src/reliabilityStore.ts';
import { reliabilityForRide, storeArtifact } from '../src/reliability.ts';
import { reportCountsForGroup, storeReportArtifact } from '../src/passupReports.ts';
import { passupRisk, POLICY_VERSION, storeRisk } from '../src/passupRisk.ts';
import { REPORT_POLICY } from '../src/passupReportRisk.ts';
import { GROUPING } from '../src/artifactGroups.ts';

const HASH = 'departures-hash';
const KEY = JSON.stringify(['678', '61234', 'freedman terminal', 'weekday', 8]);
const timing = {
  observations: 120, distinctDates: 12, coverageStart: '2025-09-01', coverageEnd: '2026-09-24',
  medianSeconds: -12.5, p10Seconds: -100, p90Seconds: 131.90000000000012,
  earlyShare: 0.2, withinShare: 0.6, lateShare: 0.2, beforeScheduleShare: 0.3,
  shareIntervals: [[0, 0.3], [0.5, 0.7], [0.1, 0.3]], nearbyFullBusReports: 3,
};
const report = {
  recordedDepartures: 441, departureDates: 208, referenceCoverageStart: '2025-07-02', referenceCoverageEnd: '2026-09-24',
  reportCount: 0, reportDates: 0, coverageStart: null, coverageEnd: null,
  profiles: { '60m': { reports: 0, reportDates: 0 }, '100m': { reports: 0, reportDates: 0 }, '150m': { reports: 0, reportDates: 0 } },
};
const legacy = {
  level: 'low', recordedVisits: 234, distinctDates: 95, coverageStart: '2025-07-05', coverageEnd: '2026-09-20',
  profiles: Object.fromEntries(['60m_120s', '100m_180s', '150m_300s'].map(name => [name, { reportedVisits: 0, reportDates: 0 }])),
};

function fixture(directory, changes = {}) {
  const common = { grouping: GROUPING, groupWindowMinutes: 120, coverageStart: '2025-07-01', coverageEnd: '2026-09-24',
    routes: ['678'], groups: {}, sources: { departures: { sha256: HASH } } };
  const write = (file, value) => {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), JSON.stringify(value));
  };
  write('reliability.json', { ...common, schemaVersion: 2, routeFiles: { 678: 'reliability-routes/678.json' } });
  write('reliability-routes/678.json', { groups: { [KEY]: changes.timing ?? timing } });
  write('passup-report-counts.json', { ...common, schemaVersion: 3, passupMatchingMethod: 'nearest-stop-report-time-v1',
    evidenceVersion: 'stop-report-counts-v1', evidenceUnit: 'unique-report-id', groupTimeBasis: 'reported-local-time',
    referenceTimeBasis: 'scheduled-local-time', labelStatus: 'approved', policy: REPORT_POLICY,
    routeFiles: { 678: 'passup-report-routes/678.json' } });
  write('passup-report-routes/678.json', { groups: { [KEY]: report } });
  write('passup-risk.json', { ...common, schemaVersion: 2, policy: { version: POLICY_VERSION },
    routeFiles: { 678: 'passup-risk-routes/678.json' } });
  write('passup-risk-routes/678.json', { groups: { [KEY]: legacy } });
  write('reliability-destinations.json', { schemaVersion: 1, generatedAt: '2026-10-19T05:01:05.175Z',
    historySourceSha256: changes.destinationsHash ?? HASH,
    variants: { '678-0-F': { route: '678', destination: 'freedman terminal', displayNames: ['freedman terminal'], source: 'variant-api' } } });
}

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'reliability-store-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a build round-trips every group and serves the same evidence', () => withDirectory(directory => {
  fixture(join(directory, 'data'));
  const built = buildStore(join(directory, 'data'), join(directory, 'out'));
  assert.deepEqual(built.counts, { destinations: 1, timing: 1, reports: 1, legacy: 1 });

  const store = openReliabilityStore(built.file);
  try {
    assert.deepEqual(store.lookup('timing')('678', KEY), timing);
    assert.equal(store.lookup('timing')('679', KEY), undefined);
    assert.equal(store.lookup('timing')('678', KEY.replace(',8]', ', 8]')), undefined);
    const ride = { type: 'ride', route: { key: '678' }, variant: { name: 'Freedman Terminal' },
      from: { stop: { key: '61234' } }, times: { start: '2026-09-29T09:10:00' } };
    const now = new Date('2026-09-25T18:00:00Z');
    assert.equal(reliabilityForRide(ride, undefined, storeArtifact(store), now).status, 'available');
    assert.equal(reportCountsForGroup(KEY, '2026-09-29', HASH, now, storeReportArtifact(store)).status, 'available');
    assert.equal(passupRisk(KEY, '2026-09-24', HASH, storeRisk(store)).level, 'low');
    // A configured store that fails to open leaves every reader without data.
    assert.deepEqual([storeArtifact(null), storeReportArtifact(null), storeRisk(null)], [undefined, undefined, undefined]);
  } finally {
    store.close();
  }
}));

test('rebuilding the same inputs produces the same file', () => withDirectory(directory => {
  fixture(join(directory, 'data'));
  const first = buildStore(join(directory, 'data'), join(directory, 'out'));
  const second = buildStore(join(directory, 'data'), join(directory, 'out'));
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.inputSha256, first.inputSha256);
  assert.deepEqual(readdirSync(join(directory, 'out')), [first.file.split('/').at(-1)]);
}));

test('mixed sources, unknown fields and tampered files are rejected', () => withDirectory(directory => {
  fixture(join(directory, 'mixed'), { destinationsHash: 'other-history' });
  assert.throws(() => buildStore(join(directory, 'mixed'), join(directory, 'out')), /different departure source/);

  fixture(join(directory, 'extra'), { timing: { ...timing, newField: 1 } });
  assert.throws(() => buildStore(join(directory, 'extra'), join(directory, 'out')), /timing group differs/);
  assert.deepEqual(readdirSync(join(directory, 'out')).filter(name => name.endsWith('.sqlite')), []);

  fixture(join(directory, 'data'));
  const built = buildStore(join(directory, 'data'), join(directory, 'out'));
  writeFileSync(join(directory, 'data/reliability-routes/678.json'), JSON.stringify({ groups: { [KEY]: { ...timing, observations: 121 } } }));
  assert.throws(() => verifyStore(built.file, readSources(join(directory, 'data'))), /different inputs/);

  writeFileSync(built.file, readFileSync(built.file).subarray(0, 512));
  assert.equal(openReliabilityStore(built.file), undefined);
  assert.equal(openReliabilityStore(join(directory, 'missing.sqlite')), undefined);
}));

test('publishing pins the release asset, and fetching checks its hash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reliability-publish-'));
  try {
    fixture(join(directory, 'data'));
    const built = buildStore(join(directory, 'data'), join(directory, 'out'));
    const calls = [];
    const run = args => {
      calls.push(args.slice(0, 2));
      return args[1] === 'view' ? { ok: false, stdout: '', stderr: 'release not found' } : { ok: true, stdout: '', stderr: '' };
    };
    const lock = join(directory, 'reliability-store.lock.json');
    const pinned = publishStore(built.file, { data: join(directory, 'data'), repo: 'owner/repo', lock, run });
    assert.deepEqual(calls, [['release', 'view'], ['release', 'create']]);
    assert.equal(pinned.sha256, built.sha256);
    assert.equal(pinned.url, `https://github.com/owner/repo/releases/download/reliability-${built.sha256.slice(0, 16)}/reliability-${built.sha256.slice(0, 16)}.sqlite`);
    assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')), pinned);

    const bytes = readFileSync(built.file);
    const download = async () => new Response(bytes);
    const out = join(directory, 'app/reliability/reliability.sqlite');
    assert.equal((await fetchStore(lock, out, download)).status, 'downloaded');
    assert.equal((await fetchStore(lock, out, async () => { throw new Error('should not download'); })).status, 'present');
    assert.equal(openReliabilityStore(out)?.build.inputSha256, built.inputSha256);

    rmSync(out);
    await assert.rejects(fetchStore(lock, out, async () => new Response(bytes.subarray(1))), /lock expects/);
    assert.equal(existsSync(out), false);
    assert.equal((await fetchStore(join(directory, 'missing.lock.json'), out, download)).status, 'not_pinned');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
