// Builds and verifies the versioned SQLite reliability store from the JSON artifacts.
// Run with tsx so the backend's own artifact validators are reused:
//   npm run reliability:store -- build [--data data] [--out .reliability]
//   npm run reliability:store -- verify FILE [--data data]
//   npm run reliability:store -- publish FILE [--data data] [--repo OWNER/REPO]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadArtifact } from '../src/reliability.ts';
import { loadReportArtifact } from '../src/passupReports.ts';
import { loadRisk } from '../src/passupRisk.ts';
import { loadDestinationLookup } from '../src/reliabilityDestinations.ts';
import {
  encodeGroup, insertSql, openReliabilityStore, parseGroupKey, STORE_DATASETS, STORE_SCHEMA, STORE_SCHEMA_VERSION, STORE_TABLES,
} from '../src/reliabilityStore.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const LOCK_FILE = join(root, 'reliability-store.lock.json');
const REPOSITORY = 'pricezhang42/WinnipegBusTripPlanner-Backend';
const FILES = {
  timing: ['reliability.json', loadArtifact],
  reports: ['passup-report-counts.json', loadReportArtifact],
  legacy: ['passup-risk.json', loadRisk],
};
const DESTINATIONS = 'reliability-destinations.json';
// Build audits travel with the data they describe; they are provenance, never read at runtime.
export const AUDITS = [
  'reliability.report.json', 'passup-report-counts.report.json', 'passup-risk.report.json', 'passup-policy-report.json',
];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Reads every manifest and shard strictly; any missing or malformed input fails the build. */
export function readSources(dataDirectory) {
  const directory = resolve(dataDirectory);
  const inputs = [];
  const read = path => {
    const bytes = readFileSync(path);
    inputs.push([relative(directory, path).split(sep).join('/'), sha256(bytes)]);
    return JSON.parse(bytes.toString('utf8'));
  };
  const datasets = {};
  for (const [name, [file, load]] of Object.entries(FILES)) {
    const path = join(directory, file);
    const raw = read(path);
    if (!load(path)) throw new Error(`${file} failed backend validation.`);
    const groups = new Map();
    const add = (route, values, origin) => {
      for (const [key, value] of Object.entries(values ?? {})) {
        const parts = parseGroupKey(key);
        if (!parts || (route !== undefined && parts[0] !== route)) throw new Error(`${origin}: invalid group key ${key}`);
        if (!raw.routes.includes(parts[0])) throw new Error(`${origin}: group for unlisted route ${parts[0]}`);
        if (groups.has(key)) throw new Error(`${origin}: duplicate group ${key}`);
        groups.set(key, value);
      }
    };
    add(undefined, raw.groups, file);
    for (const route of raw.routes) {
      const shard = raw.routeFiles?.[route];
      if (shard === undefined) continue;
      const shardPath = resolve(dirname(path), shard);
      if (!shardPath.startsWith(directory + sep)) throw new Error(`${file}: shard outside data directory for ${route}`);
      const value = read(shardPath);
      if (!value?.groups || typeof value.groups !== 'object' || Array.isArray(value.groups)) {
        throw new Error(`${shard}: missing groups`);
      }
      add(route, value.groups, shard);
    }
    datasets[name] = { manifest: { ...raw, groups: {} }, groups };
  }
  const destinationsPath = join(directory, DESTINATIONS);
  const destinations = read(destinationsPath);
  if (!loadDestinationLookup(destinationsPath)) throw new Error(`${DESTINATIONS} failed backend validation.`);
  const audits = Object.fromEntries(AUDITS.map(file => {
    if (!existsSync(join(directory, file))) throw new Error(`Missing build audit ${file}.`);
    return [file, read(join(directory, file))];
  }));

  // Everything in one store must describe the same departure history.
  const hash = datasets.timing.manifest.sources?.departures?.sha256;
  for (const name of ['reports', 'legacy']) {
    if (datasets[name].manifest.sources?.departures?.sha256 !== hash) throw new Error(`${name} uses a different departure source.`);
  }
  if (destinations.historySourceSha256 !== hash) throw new Error('Destinations use a different departure source.');
  if (datasets.legacy.manifest.coverageEnd !== datasets.timing.manifest.coverageEnd) throw new Error('Legacy coverage differs.');

  inputs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const inputSha256 = sha256(inputs.map(([file, hash]) => `${hash}  ${file}\n`).join(''));
  return { datasets, destinations, audits, inputSha256 };
}

export function buildStore(dataDirectory, outDirectory) {
  const sources = readSources(dataDirectory);
  mkdirSync(outDirectory, { recursive: true });
  const temporary = join(outDirectory, `.building-${process.pid}.sqlite`);
  rmSync(temporary, { force: true });
  const counts = { destinations: Object.keys(sources.destinations.variants).length };
  const db = new DatabaseSync(temporary);
  try {
    db.exec(STORE_SCHEMA);
    const meta = db.prepare('INSERT INTO meta (name, value) VALUES (?, ?)');
    db.exec('BEGIN');
    for (const name of STORE_DATASETS) {
      const { manifest, groups } = sources.datasets[name];
      const insert = db.prepare(insertSql(name));
      meta.run(name, JSON.stringify(manifest));
      // Sorted inserts keep the file byte-identical for identical inputs.
      for (const key of [...groups.keys()].sort()) insert.run(...parseGroupKey(key), ...encodeGroup(name, groups.get(key)));
      counts[name] = groups.size;
    }
    meta.run('destinations', JSON.stringify(sources.destinations));
    for (const [file, audit] of Object.entries(sources.audits)) meta.run(`audit:${file}`, JSON.stringify(audit));
    meta.run('build', JSON.stringify({ storeSchemaVersion: STORE_SCHEMA_VERSION, inputSha256: sources.inputSha256, counts }));
    db.exec('COMMIT');
    db.exec('VACUUM');
  } catch (error) {
    db.close();
    rmSync(temporary, { force: true });
    throw error;
  }
  db.close();
  try {
    verifyStore(temporary, sources);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const fileSha256 = sha256(readFileSync(temporary));
  const file = join(outDirectory, `reliability-${fileSha256.slice(0, 16)}.sqlite`);
  // Same hash means the same build, so re-running is a no-op.
  if (existsSync(file)) rmSync(temporary);
  else renameSync(temporary, file);
  return { file, sha256: fileSha256, inputSha256: sources.inputSha256, counts };
}

/** Every source group must come back byte-for-byte equal, and nothing else may exist. */
export function verifyStore(file, sources) {
  const store = openReliabilityStore(file);
  if (!store) throw new Error(`${file} is not a readable reliability store.`);
  try {
    if (store.build.inputSha256 !== sources.inputSha256) throw new Error('Store was built from different inputs.');
    if (!isDeepStrictEqual(store.manifest('destinations'), sources.destinations)) throw new Error('Destination lookup differs.');
    for (const [file, audit] of Object.entries(sources.audits)) {
      if (!isDeepStrictEqual(store.manifest(`audit:${file}`), audit)) throw new Error(`Audit ${file} differs.`);
    }
    for (const name of STORE_DATASETS) {
      const { manifest, groups } = sources.datasets[name];
      if (!isDeepStrictEqual(store.manifest(name), manifest)) throw new Error(`${name} manifest differs.`);
      if (store.build.counts[name] !== groups.size) throw new Error(`${name} row count differs.`);
      const lookup = store.lookup(name);
      for (const [key, value] of groups) {
        if (!isDeepStrictEqual(lookup(parseGroupKey(key)[0], key), value)) throw new Error(`${name} group differs: ${key}`);
      }
    }
  } finally {
    store.close();
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const name of STORE_DATASETS) {
      const { n } = db.prepare(`SELECT count(*) AS n FROM ${STORE_TABLES[name].table}`).get();
      if (n !== sources.datasets[name].groups.size) throw new Error(`${name} has extra rows.`);
    }
  } finally {
    db.close();
  }
}

function gh(args) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new Error('GitHub CLI (gh) is required to publish.');
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Uploads a verified store as a GitHub release asset and pins it in the lock file.
 * Re-publishing the same file reuses its release. Committing the lock publishes it.
 */
export function publishStore(file, { data = join(root, 'data'), repo = REPOSITORY, lock = LOCK_FILE, run = gh } = {}) {
  const store = openReliabilityStore(file);
  if (!store) throw new Error(`${file} is not a readable reliability store.`);
  const build = store.build;
  const coverage = store.manifest('timing');
  store.close();
  // While the JSON artifacts are still committed, only a store built from them can be published.
  if (existsSync(join(data, 'reliability.json'))) verifyStore(file, readSources(data));

  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const tag = `reliability-${sha256.slice(0, 16)}`;
  const asset = `${tag}.sqlite`;
  if (basename(file) !== asset) throw new Error(`Expected the file built by this tool, named ${asset}.`);
  const existing = run(['release', 'view', tag, '--repo', repo, '--json', 'assets']);
  if (!existing.ok) {
    const notes = [
      `Reliability store, departures ${coverage?.coverageStart} to ${coverage?.coverageEnd}.`,
      `SHA-256 ${sha256}`, `Input SHA-256 ${build.inputSha256}`, `Rows ${JSON.stringify(build.counts)}`,
    ].join('\n\n');
    const created = run(['release', 'create', tag, file, '--repo', repo, '--title', `Reliability store ${sha256.slice(0, 16)}`,
      '--notes', notes, '--latest=false']);
    if (!created.ok) throw new Error(`Could not create release ${tag}: ${created.stderr.trim()}`);
  } else if (!JSON.parse(existing.stdout).assets?.some(item => item.name === asset)) {
    const uploaded = run(['release', 'upload', tag, file, '--repo', repo]);
    if (!uploaded.ok) throw new Error(`Could not upload ${asset}: ${uploaded.stderr.trim()}`);
  }
  const pinned = {
    storeSchemaVersion: build.storeSchemaVersion, sha256, inputSha256: build.inputSha256,
    coverageStart: coverage?.coverageStart, coverageEnd: coverage?.coverageEnd, counts: build.counts,
    url: `https://github.com/${repo}/releases/download/${tag}/${asset}`,
  };
  writeFileSync(lock, `${JSON.stringify(pinned, null, 2)}\n`);
  return pinned;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  args.splice(index, 2);
  return value;
}

export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const data = option(rest, '--data', join(root, 'data'));
  if (command === 'build') {
    const out = option(rest, '--out', join(root, '.reliability'));
    if (rest.length) throw new Error(`Unknown arguments: ${rest.join(' ')}`);
    console.log(JSON.stringify(buildStore(data, out), null, 2));
  } else if (command === 'publish') {
    const repo = option(rest, '--repo', REPOSITORY);
    if (rest.length !== 1) throw new Error('Use: publish FILE [--data DIR] [--repo OWNER/REPO]');
    console.log(JSON.stringify(publishStore(resolve(rest[0]), { data, repo }), null, 2));
  } else if (command === 'verify' && rest.length === 1) {
    verifyStore(rest[0], readSources(data));
    console.log(JSON.stringify({ verified: rest[0] }));
  } else {
    throw new Error('Use: build [--data DIR] [--out DIR] | verify FILE [--data DIR] | publish FILE [--repo OWNER/REPO]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
