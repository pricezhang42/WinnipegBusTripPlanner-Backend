import { localSettings } from './connections.mjs';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { GROUPING } from '../src/artifactGroups.ts';
import { createDestinationLookup } from '../src/reliabilityDestinations.ts';

const settings = await localSettings(new URL('../', import.meta.url));
const apiKey = settings.WT_API_KEY;
if (!apiKey) throw new Error('WT_API_KEY is required to refresh destination names');

async function fetchJson(path, usage) {
  const url = new URL(`./${path}.json`, 'https://api.winnipegtransit.com/v3/');
  url.searchParams.set('api-key', apiKey);
  if (usage) url.searchParams.set('usage', usage);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (response.ok) return await response.json();
  } catch { /* Avoid logging URLs containing the API credential. */ }
  throw new Error(`Transit metadata request failed: ${path} (${usage ?? 'default'})`);
}

function addHistoricalDestinations(manifestPath, destinations) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const route of manifest.routes) {
    let groups = manifest.groups;
    if (manifest.routeFiles) {
      const directory = resolve(dirname(manifestPath));
      const file = resolve(directory, manifest.routeFiles[route]);
      if (!file.startsWith(directory + sep)) throw new Error(`Unsafe shard path for ${route}`);
      groups = JSON.parse(readFileSync(file, 'utf8')).groups;
    }
    const names = destinations.get(route) ?? new Set();
    for (const key of Object.keys(groups)) {
      const [groupRoute, , destination] = JSON.parse(key);
      if (groupRoute === route) names.add(destination);
    }
    destinations.set(route, names);
  }
  return manifest;
}

async function main() {
  // The analysis export the next store is built from; the lookup is written into it.
  const index = process.argv.indexOf('--data');
  if (index === -1 || !process.argv[index + 1]) throw new Error('Use: npm run refresh:destinations -- --data DIR');
  const data = resolve(process.argv[index + 1]);
  const historyPath = resolve(data, 'reliability.json');
  const reportPath = resolve(data, 'passup-report-counts.json');
  const destinations = new Map();
  const timing = addHistoricalDestinations(historyPath, destinations);
  const reports = addHistoricalDestinations(reportPath, destinations);
  if (timing.grouping !== GROUPING || reports.grouping !== GROUPING) {
    throw new Error('Unsupported historical grouping');
  }
  const sourceHash = timing.sources?.departures?.sha256;
  if (typeof sourceHash !== 'string' || !sourceHash || sourceHash !== reports.sources?.departures?.sha256) {
    throw new Error('Timing and report artifacts must use the same departure source');
  }
  const { routes } = await fetchJson('routes');
  if (!Array.isArray(routes) || !routes.length) throw new Error('No routes returned');
  const records = [];
  let nextRoute = 0;
  async function worker() {
    while (nextRoute < routes.length) {
      const route = routes[nextRoute++];
      if (!Array.isArray(route.variants)) throw new Error(`Missing variant list for ${route.key}`);
      const display = await fetchJson(`variants:${route.key}`);
      // Long-usage terminal names match the City's historical destination field.
      // Short usage can instead return a route label (e.g. 28-1-S).
      const canonical = await fetchJson(`variants:${route.key}`, 'long');
      const displayNames = new Map((display.variants ?? []).map(variant => [variant.key, variant.name]));
      const canonicalNames = new Map((canonical.variants ?? []).map(variant => [variant.key, variant.name]));
      // Wildcards may include sibling routes or omit variants; use declared exact IDs.
      for (const variant of route.variants) {
        const displayName = displayNames.get(variant.key) ?? (await fetchJson(`variants/${variant.key}`)).variant?.name;
        const canonicalName = canonicalNames.get(variant.key) ?? (await fetchJson(`variants/${variant.key}`, 'long')).variant?.name;
        if (typeof displayName !== 'string') throw new Error(`Missing display name for ${variant.key}`);
        records.push({ route: String(route.key), routeName: route.name, key: variant.key, displayName, canonicalName });
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  records.sort((a, b) => a.key.localeCompare(b.key));
  const lookup = createDestinationLookup(records, destinations, sourceHash);
  const output = resolve(data, 'reliability-destinations.json');
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lookup, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, output);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed or never written. */ }
  }
  console.log(`Saved ${records.length} variants across ${routes.length} routes to ${output}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
