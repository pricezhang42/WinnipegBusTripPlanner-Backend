// Compares API enrichment from the JSON artifacts with a SQLite store, ride by ride:
//   npm run reliability:parity -- FILE [--data data]
// Each side runs in its own process because the readers load their source at startup.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
// Inside the 30-day window after coverage ends (2026-09-24), avoiding holidays.
const NOW = '2026-09-25T18:00:00Z';
const DATES = { weekday: '2026-09-29', weekend: '2026-09-26' };

const ride = (route, stop, variant, date, hour) => ({
  type: 'ride', route: { key: route }, variant, from: { stop: { key: stop } },
  times: { start: `${date}T${String(hour).padStart(2, '0')}:15:00` },
});

/** Every group key in any dataset, every reviewed variant, and unsupported cases. */
export function parityRides(dataDirectory) {
  const keys = new Set();
  for (const file of ['reliability.json', 'passup-report-counts.json', 'passup-risk.json']) {
    const manifest = JSON.parse(readFileSync(join(dataDirectory, file), 'utf8'));
    for (const key of Object.keys(manifest.groups)) keys.add(key);
    for (const shard of Object.values(manifest.routeFiles ?? {})) {
      for (const key of Object.keys(JSON.parse(readFileSync(join(dataDirectory, shard), 'utf8')).groups)) keys.add(key);
    }
  }
  const rides = [];
  const stopsByDestination = new Map();
  for (const key of [...keys].sort()) {
    const [route, stop, destination, dayType, hour] = JSON.parse(key);
    rides.push(ride(route, stop, { name: destination }, DATES[dayType], hour));
    if (!stopsByDestination.has(`${route}|${destination}`)) stopsByDestination.set(`${route}|${destination}`, [stop, dayType, hour]);
  }
  const destinations = JSON.parse(readFileSync(join(dataDirectory, 'reliability-destinations.json'), 'utf8'));
  for (const [variantKey, entry] of Object.entries(destinations.variants)) {
    const [stop, dayType, hour] = stopsByDestination.get(`${entry.route}|${entry.destination}`) ?? ['1', 'weekday', 8];
    for (const name of entry.displayNames) rides.push(ride(entry.route, stop, { key: variantKey, name }, DATES[dayType], hour));
    rides.push(ride(entry.route, stop, { key: variantKey, name: 'changed to elsewhere' }, DATES[dayType], hour));
  }
  const fixtures = JSON.parse(readFileSync(join(root, 'src/fixtures/reliability-destination-names.json'), 'utf8'));
  for (const fixture of fixtures) rides.push({ ...ride(String(fixture.route.key), '10000', fixture.variant, DATES.weekday, 8), route: fixture.route });
  rides.push(ride('NOT-A-ROUTE', '1', { name: 'downtown' }, DATES.weekday, 8));
  rides.push(ride('BLUE', '1', { name: 'downtown' }, '2026-09-30', 8));
  rides.push(ride('BLUE', '1', { name: 'downtown' }, '2026-12-01', 8));
  rides.push({ type: 'ride', route: { key: 'BLUE' }, times: { start: `${DATES.weekday}T08:00:00` } });
  return rides;
}

/** Child mode: print one hash per ride, then timing. */
async function enrich(ridesFile) {
  const { enrichPlans } = await import('../src/reliability.ts');
  const rides = JSON.parse(readFileSync(ridesFile, 'utf8'));
  const now = new Date(NOW);
  const started = process.hrtime.bigint();
  const hashes = rides.map(item => createHash('sha256').update(JSON.stringify(enrichPlans([{ segments: [item] }], undefined, now))).digest('hex'));
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  const available = rides.filter(item => enrichPlans([{ segments: [item] }], undefined, now)[0].segments[0].reliability.status === 'available').length;
  process.stdout.write(JSON.stringify({ hashes, milliseconds, available }));
}

function side(ridesFile, env) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--no-warnings', script, '--enrich', ridesFile], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 30,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Parity child failed.');
  return JSON.parse(result.stdout);
}

export function parity(storeFile, dataDirectory) {
  const directory = mkdtempSync(join(tmpdir(), 'reliability-parity-'));
  try {
    const rides = parityRides(dataDirectory);
    const ridesFile = join(directory, 'rides.json');
    writeFileSync(ridesFile, JSON.stringify(rides));
    const json = side(ridesFile, {
      RELIABILITY_STORE_PATH: '',
      RELIABILITY_DATA_PATH: join(dataDirectory, 'reliability.json'),
      PASSUP_REPORT_DATA_PATH: join(dataDirectory, 'passup-report-counts.json'),
      PASSUP_RISK_DATA_PATH: join(dataDirectory, 'passup-risk.json'),
      RELIABILITY_DESTINATIONS_PATH: join(dataDirectory, 'reliability-destinations.json'),
    });
    const store = side(ridesFile, { RELIABILITY_STORE_PATH: storeFile });
    const mismatches = json.hashes.flatMap((hash, index) => hash === store.hashes[index] ? [] : [index]);
    return {
      rides: rides.length,
      availableTiming: json.available,
      mismatches: mismatches.length,
      firstMismatches: mismatches.slice(0, 5).map(index => rides[index]),
      jsonMilliseconds: Math.round(json.milliseconds),
      storeMilliseconds: Math.round(store.milliseconds),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--enrich') {
    await enrich(args[1]);
  } else {
    const dataIndex = args.indexOf('--data');
    const data = dataIndex === -1 ? join(root, 'data') : resolve(args.splice(dataIndex, 2)[1]);
    if (args.length !== 1) {
      console.error('Use: FILE [--data DIR]');
      process.exitCode = 1;
    } else {
      const result = parity(resolve(args[0]), data);
      console.log(JSON.stringify(result, null, 2));
      if (result.mismatches || !result.availableTiming) process.exitCode = 1;
    }
  }
}
