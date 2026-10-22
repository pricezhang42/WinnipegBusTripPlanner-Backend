import { DatabaseSync, type StatementSync } from 'node:sqlite';

// One SQLite file holds a complete build: departures, report counts, legacy risk
// and destinations together, so a deployment can never mix dataset versions.
export const STORE_SCHEMA_VERSION = 1;
export const STORE_DATASETS = ['timing', 'reports', 'legacy'] as const;
export type StoreDataset = typeof STORE_DATASETS[number];
export type StoreManifest = StoreDataset | 'destinations';

type Path = (string | number)[];
type Column = [name: string, path: Path, type: 'INTEGER' | 'REAL' | 'TEXT'];
const shareIntervals = ['early', 'within', 'late'].flatMap((name, index) => [
  [`${name}_interval_low`, ['shareIntervals', index, 0], 'REAL'],
  [`${name}_interval_high`, ['shareIntervals', index, 1], 'REAL'],
] as Column[]);
const reportProfiles = ['60m', '100m', '150m'].flatMap(name => [
  [`reports_${name}`, ['profiles', name, 'reports'], 'INTEGER'],
  [`report_dates_${name}`, ['profiles', name, 'reportDates'], 'INTEGER'],
] as Column[]);
const legacyProfiles = ['60m_120s', '100m_180s', '150m_300s'].flatMap(name => [
  [`reported_visits_${name}`, ['profiles', name, 'reportedVisits'], 'INTEGER'],
  [`report_dates_${name}`, ['profiles', name, 'reportDates'], 'INTEGER'],
] as Column[]);

// Typed columns, in the JSON field order, so values can be queried and rebuilt exactly.
export const STORE_TABLES: Record<StoreDataset, { table: string; columns: Column[] }> = {
  timing: { table: 'departure_groups', columns: [
    ['observations', ['observations'], 'INTEGER'],
    ['distinct_dates', ['distinctDates'], 'INTEGER'],
    ['coverage_start', ['coverageStart'], 'TEXT'],
    ['coverage_end', ['coverageEnd'], 'TEXT'],
    ['median_seconds', ['medianSeconds'], 'REAL'],
    ['p10_seconds', ['p10Seconds'], 'REAL'],
    ['p90_seconds', ['p90Seconds'], 'REAL'],
    ['early_share', ['earlyShare'], 'REAL'],
    ['within_share', ['withinShare'], 'REAL'],
    ['late_share', ['lateShare'], 'REAL'],
    ['before_schedule_share', ['beforeScheduleShare'], 'REAL'],
    ...shareIntervals,
    ['nearby_full_bus_reports', ['nearbyFullBusReports'], 'INTEGER'],
  ] },
  reports: { table: 'passup_report_groups', columns: [
    ['recorded_departures', ['recordedDepartures'], 'INTEGER'],
    ['departure_dates', ['departureDates'], 'INTEGER'],
    ['reference_coverage_start', ['referenceCoverageStart'], 'TEXT'],
    ['reference_coverage_end', ['referenceCoverageEnd'], 'TEXT'],
    ['report_count', ['reportCount'], 'INTEGER'],
    ['report_dates', ['reportDates'], 'INTEGER'],
    ['coverage_start', ['coverageStart'], 'TEXT'],
    ['coverage_end', ['coverageEnd'], 'TEXT'],
    ...reportProfiles,
  ] },
  legacy: { table: 'passup_legacy_groups', columns: [
    ['level', ['level'], 'TEXT'],
    ['recorded_visits', ['recordedVisits'], 'INTEGER'],
    ['distinct_dates', ['distinctDates'], 'INTEGER'],
    ['coverage_start', ['coverageStart'], 'TEXT'],
    ['coverage_end', ['coverageEnd'], 'TEXT'],
    ...legacyProfiles,
  ] },
};
const KEY_COLUMNS = ['route', 'boarding_stop', 'destination', 'day_type', 'window_start_hour'];

export const STORE_SCHEMA = [
  'CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;',
  ...STORE_DATASETS.map(dataset => {
    const { table, columns } = STORE_TABLES[dataset];
    return `CREATE TABLE ${table} (
  route TEXT NOT NULL,
  boarding_stop TEXT NOT NULL,
  destination TEXT NOT NULL,
  day_type TEXT NOT NULL CHECK (day_type IN ('weekday', 'weekend')),
  window_start_hour INTEGER NOT NULL,
${columns.map(([name, , type]) => `  ${name} ${type},`).join('\n')}
  PRIMARY KEY (${KEY_COLUMNS.join(', ')})
) WITHOUT ROWID;`;
  }),
].join('\n');

export function insertSql(dataset: StoreDataset): string {
  const { table, columns } = STORE_TABLES[dataset];
  const names = [...KEY_COLUMNS, ...columns.map(([name]) => name)];
  return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
}

/** Column values for one group; anything missing or of the wrong type fails the build. */
export function encodeGroup(dataset: StoreDataset, value: unknown): (string | number | null)[] {
  return STORE_TABLES[dataset].columns.map(([name, path, type]) => {
    let current: any = value;
    for (const part of path) current = current?.[part];
    if (current === null && type === 'TEXT') return null;
    if (type === 'TEXT' ? typeof current !== 'string' : !Number.isFinite(current) ||
        (type === 'INTEGER' && !Number.isInteger(current))) {
      throw new Error(`${dataset}.${name} has an unsupported value`);
    }
    return current;
  });
}

function decodeGroup(dataset: StoreDataset, row: Record<string, unknown>): unknown {
  const value: any = {};
  for (const [name, path] of STORE_TABLES[dataset].columns) {
    let target = value;
    path.forEach((part, index) => {
      if (index === path.length - 1) target[part] = row[name];
      else target = target[part] ??= typeof path[index + 1] === 'number' ? [] : {};
    });
  }
  return value;
}

export type StoreBuild = {
  storeSchemaVersion: number;
  inputSha256: string;
  counts: Record<StoreDataset, number> & { destinations: number };
};

export type ReliabilityStore = {
  build: StoreBuild;
  manifest(name: StoreManifest): Record<string, unknown> | undefined;
  lookup<T>(dataset: StoreDataset): (route: string, key: string) => T | undefined;
  close(): void;
};

export type GroupKey = [route: string, boardingStop: string, destination: string, dayType: string, hour: number];

/** Only canonical keys round-trip, so the store and JSON shards agree on identity. */
export function parseGroupKey(key: string): GroupKey | undefined {
  try {
    const value = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 5) return undefined;
    const [route, stop, destination, dayType, hour] = value;
    if (![route, stop, destination, dayType].every(part => typeof part === 'string') || !Number.isInteger(hour)) return undefined;
    return JSON.stringify(value) === key ? value as GroupKey : undefined;
  } catch {
    return undefined;
  }
}

export function openReliabilityStore(path: string): ReliabilityStore | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const meta = new Map((db.prepare('SELECT name, value FROM meta').all() as { name: string; value: string }[])
      .map(row => [row.name, JSON.parse(row.value)]));
    const build = meta.get('build') as StoreBuild | undefined;
    if (build?.storeSchemaVersion !== STORE_SCHEMA_VERSION || typeof build.inputSha256 !== 'string') {
      db.close();
      return undefined;
    }
    const selects = Object.fromEntries(STORE_DATASETS.map(dataset => [dataset, db!.prepare(
      `SELECT * FROM ${STORE_TABLES[dataset].table} WHERE ${KEY_COLUMNS.map(name => `${name} = ?`).join(' AND ')}`,
    )])) as Record<StoreDataset, StatementSync>;
    const database = db;
    return {
      build,
      manifest: name => {
        const value = meta.get(name);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
      },
      lookup: <T>(dataset: StoreDataset) => (route: string, key: string) => lookupGroup<T>(selects[dataset], dataset, route, key),
      close: () => database.close(),
    };
  } catch {
    db?.close();
    return undefined;
  }
}

function lookupGroup<T>(select: StatementSync, dataset: StoreDataset, route: string, key: string): T | undefined {
  const parts = parseGroupKey(key);
  if (!parts || parts[0] !== route) return undefined;
  const row = select.get(...parts) as Record<string, unknown> | undefined;
  return row ? decodeGroup(dataset, row) as T : undefined;
}

function configuredStore(): ReliabilityStore | null | undefined {
  const path = process.env.RELIABILITY_STORE_PATH;
  if (!path) return undefined;
  const store = openReliabilityStore(path);
  if (!store) console.warn('[reliability] store unavailable; reliability evidence will be reported as unavailable');
  return store ?? null;
}

/** undefined: JSON artifacts are used. null: a store was configured but failed, so evidence is unavailable. */
export const reliabilityStore = configuredStore();
