import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PRIVATE_DIR = join(ROOT, '.database');
export const TABLES = ['favorite_locations', 'favorite_trips', 'trip_history'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const loadJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function loadSettings() {
  try { process.loadEnvFile(join(ROOT, '.env.connections.local')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return loadJson(join(ROOT, 'supabase/environments.json'));
}
export function databaseKind(settings, environment) {
  if (!/^[a-z][a-z0-9_]*$/.test(environment ?? '') || !Object.hasOwn(settings, environment)) {
    throw new Error('Choose a registered database explicitly with --database.');
  }
  const kind = settings[environment].kind ?? (environment === 'production' ? 'production' : environment === 'qa' ? 'qa' : null);
  if (!['production', 'qa'].includes(kind) || (kind === 'production' && environment !== 'production')) {
    throw new Error('Database profiles must declare kind qa; only production can declare kind production.');
  }
  return kind;
}
export function projectRef(settings, environment) {
  const kind = databaseKind(settings, environment);
  const ref = settings[environment]?.projectRef;
  if (!/^[a-z0-9]{20}$/.test(ref ?? '')) throw new Error(`Register the ${environment} project reference in supabase/environments.json first.`);
  if (kind === 'qa' && ref === settings.production?.projectRef) throw new Error('QA must be a different project from production.');
  // Two names for one project make destructive operations and evidence ambiguous.
  if (Object.entries(settings).some(([name, value]) => name !== environment && value.projectRef === ref)) {
    throw new Error('Database project references must be unique across profiles.');
  }
  return ref;
}
export function target(settings, environment, env = process.env) {
  const ref = projectRef(settings, environment);
  const value = env[`${environment.toUpperCase()}_DATABASE_URL`];
  if (!value) throw new Error(`Set ${environment.toUpperCase()}_DATABASE_URL in .env.connections.local (keep credentials out of chat/Git).`);
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid database connection URL.'); }
  const direct = url.hostname === `db.${ref}.supabase.co`;
  const session = /^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(url.hostname) &&
    decodeURIComponent(url.username).endsWith(`.${ref}`);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !session) ||
      (url.port && url.port !== '5432') || url.pathname !== '/postgres') {
    throw new Error(`Database URL must target registered ${environment} project ${ref} through its direct/session endpoint on port 5432.`);
  }
  if (!url.username || !url.password) throw new Error('Database URL must include the database role and percent-encoded password.');
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'sslrootcert'].includes(key)) throw new Error(`Unsupported database URL option: ${key}`);
  }
  const caFile = env[`${environment.toUpperCase()}_DATABASE_CA_FILE`] || url.searchParams.get('sslrootcert');
  // Do not inherit URL flags that weaken TLS verification.
  url.searchParams.set('sslmode', 'verify-full');
  if (caFile) url.searchParams.set('sslrootcert', resolve(ROOT, caFile));
  return { environment, projectRef: ref, url: url.toString(), caFile: caFile && resolve(ROOT, caFile) };
}
export function requireQa(settings, environment) {
  if (databaseKind(settings, environment) !== 'qa') throw new Error('This operation is available only for QA.');
  return projectRef(settings, environment);
}
export function confirmTarget(ref, options) {
  if (!options.apply || options.confirmRef !== ref) throw new Error(`To execute, pass --apply --confirm-ref ${ref}.`);
}
export async function migrationFiles(directory = join(ROOT, 'supabase/migrations')) {
  const entries = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const versions = new Set();
  return Promise.all(entries.map(async name => {
    const match = /^(\d{12,14})_([\w-]+)\.sql$/.exec(name);
    if (!match || versions.has(match[1])) throw new Error(`Invalid or duplicate migration version: ${name}`);
    versions.add(match[1]);
    const sql = await readFile(join(directory, name), 'utf8');
    return { version: match[1], name, sha256: sha256(sql), sql };
  }));
}
export const fileManifest = files => files.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
export async function checkManifest(files, update = false) {
  const path = join(ROOT, 'supabase/migrations.lock.json');
  let locked = [];
  try { locked = await loadJson(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  validateManifest(locked, files, update);
  if (update) await writeFile(path, `${JSON.stringify(fileManifest(files), null, 2)}\n`);
}
export function validateManifest(locked, files, allowNew = false) {
  for (const saved of locked) {
    const current = files.find(file => file.version === saved.version);
    if (!current || current.name !== saved.name || current.sha256 !== saved.sha256) {
      throw new Error(`Previously registered migration changed or disappeared: ${saved.name}. Add a new migration instead.`);
    }
  }
  if (!allowNew && locked.length !== files.length) throw new Error('Register new migrations with npm run db:manifest.');
}
export async function connect(database) {
  const url = new URL(database.url); url.search = '';
  const ssl = { rejectUnauthorized: true };
  if (database.caFile) ssl.ca = await readFile(database.caFile, 'utf8');
  const client = new pg.Client({ connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 10000, query_timeout: 15000, application_name: 'bustripplanner-db-tools' });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    if (['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code)) {
      throw new Error(`Database certificate verification failed. Download the root certificate from Supabase Dashboard → Database Settings → SSL Configuration, then set ${database.environment.toUpperCase()}_DATABASE_CA_FILE in .env.connections.local to its absolute path. TLS verification remains enabled.`);
    }
    throw error;
  }
  return client;
}
export async function readAudit(client, database, files) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows: [server] } = await client.query('SHOW server_version');
    const { rows: [metadata] } = await client.query(await readFile(join(ROOT, 'supabase/audit.sql'), 'utf8'));
    const { rows: [history] } = await client.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS exists");
    let remoteMigrations = [];
    if (history.exists) {
      // Version is the stable identifier; no stored SQL or data values are exported.
      remoteMigrations = (await client.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(row => row.version);
    }
    await client.query('COMMIT');
    return { schemaVersion: 1, environment: database.environment, projectRef: database.projectRef,
      generatedAt: new Date().toISOString(), postgresVersion: server.server_version,
      migrations: fileManifest(files), historyTableExists: history.exists, remoteMigrations,
      catalog: metadata.catalog, catalogHash: sha256(JSON.stringify(metadata.catalog)) };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
export function migrationStatus(audit, files) {
  const known = new Set(files.map(file => file.version));
  return {
    pending: files.filter(file => !audit.remoteMigrations.includes(file.version)).map(file => file.version),
    remoteOnly: audit.remoteMigrations.filter(version => !known.has(version)),
    hasApplicationTables: audit.catalog.tables.some(table => TABLES.includes(table.name)),
  };
}
export function assertMigrationHistory(audit, files) {
  const status = migrationStatus(audit, files);
  if (status.remoteOnly.length) throw new Error('Remote migration versions are missing from Git. Reconcile the audit before deploying.');
  if (status.hasApplicationTables && (!audit.historyTableExists || !audit.remoteMigrations.length)) {
    throw new Error('Existing application schema has no recorded baseline. Review the audit and reconcile migration history before deployment.');
  }
  const applied = files.filter(file => audit.remoteMigrations.includes(file.version));
  const last = applied.at(-1)?.version;
  if (last && status.pending.some(version => version < last)) throw new Error('Migration history has gaps. Reconcile them; do not automatically replay older SQL.');
  return status;
}
export async function privateJson(name, value, directory = PRIVATE_DIR) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}
export function redact(text, env = process.env) {
  let output = String(text);
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/(PASSWORD|TOKEN|KEY|DATABASE_URL)/.test(name)) continue;
    output = output.replaceAll(value, '[redacted]');
    if (/DATABASE_URL/.test(name)) {
      try {
        const url = new URL(value);
        for (const secret of [url.password, decodeURIComponent(url.password)]) if (secret) output = output.replaceAll(secret, '[redacted]');
      } catch {}
    }
  }
  return output.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[redacted key]');
}
export function run(command, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let overflow = false;
    const capture = chunk => { output += chunk; if (output.length > 2_000_000) { overflow = true; child.kill(); } };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', () => reject(new Error('Could not start the required tool. Run npm ci and check the documented prerequisites.')));
    child.on('close', code => {
      const safe = redact(output, env);
      if (code !== 0 || overflow) reject(new Error(`Tool failed${overflow ? ' (output limit)' : ''}: ${safe}`));
      else resolveRun(safe);
    });
  });
}
export async function supabase(args, database) {
  return run(join(ROOT, 'node_modules/.bin/supabase'), [...args, '--db-url', database.url, '--workdir', ROOT, '--yes']);
}
export function reportPath(path) { return relative(ROOT, path); }
