import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, chmod, lstat, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRIVATE_DIR, loadSettings, connect, migrationFiles, checkManifest, readAudit, migrationStatus } from './core.mjs';
import { findings } from './contract.mjs';
import {
  RefreshError, fail, parseRefreshArguments, refreshTargets, shapeHash, compatibility,
  selectedTables, tableKey, qualified, identifier, literal, catalogSqlPath,
  pgEnvironment, passfileLine, toolPath, dumpArguments, restoreList, fingerprintQuery,
  verifyRowsSql, verifyForeignKeysSql, sequenceSql, verifySequencesSql, restorePrefix, schemaGuardSql,
} from './refresh-plan.mjs';

const LOCK = [428175, 23];
const plainAuthTables = new Set(['users', 'identities', 'instances', 'audit_log_entries', 'sessions', 'refresh_tokens', 'flow_state', 'one_time_tokens', 'mfa_amr_claims']);
const platformSchemas = new Set(['supabase_migrations', 'storage', 'vault', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'net', 'cron', 'supabase_functions', 'pgsodium', 'pgsodium_masks']);
const artifacts = ['production.dump', 'production.data.sql', 'production.toc', 'qa.dump', 'qa.data.sql', 'qa.toc'];
const limitBytes = 256n * 1024n * 1024n;

// Native tool diagnostics can include complete COPY rows/password hashes. Do not
// forward them to the generic CLI error handler or store them in a public log.
export function nativeTool(name, args, { env, signal, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath(name), args, { env: env ?? { PATH: process.env.PATH ?? '' }, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = ''; let tooLarge = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1_000_000) { tooLarge = true; child.kill('SIGTERM'); } });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new RefreshError(`${name} could not run. Check PostgreSQL 17 client tools, DATABASE_PG_BIN and cancellation state. Private tool diagnostics were withheld.`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) reject(new RefreshError(`${name} failed. Private diagnostics were withheld because they may contain Auth data. No success was recorded; inspect the private run status and recovery instructions.`));
      else resolve(output);
    });
  });
}
export async function checkTools(run = nativeTool) {
  const result = [];
  for (const name of ['pg_dump', 'pg_restore', 'psql']) {
    try {
      const output = await run(name, ['--version']);
      if (!/\(PostgreSQL\) 17\./.test(output)) fail('Wrong PostgreSQL client major version.');
      result.push({ name, available: true });
    } catch { result.push({ name, available: false }); }
  }
  return result;
}
async function query(client, text) { return (await client.query({ text, query_timeout: 120000 })).rows; }
export async function readCatalog(client) { return (await query(client, await readFile(catalogSqlPath, 'utf8')))[0].catalog; }
async function readOnlyCatalog(database) {
  const client = await connect(database);
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const c = await readCatalog(client); await client.query('COMMIT'); return c; }
  finally { await client.end(); }
}
export async function fingerprints(client, catalog) {
  const result = {};
  for (const table of selectedTables(catalog)) result[tableKey(table)] = (await query(client, fingerprintQuery(table)))[0];
  return result;
}

export async function checkSourceContent(client, catalog) {
  // Unknown/encrypted feature data is a blocker, never silently dropped. These
  // reads occur only after explicit apply acknowledgements, not during preview.
  for (const table of selectedTables(catalog).filter(t => t.schema === 'auth' && !plainAuthTables.has(t.name))) {
    if ((await query(client, `SELECT EXISTS(SELECT 1 FROM ${qualified(table)}) AS present`))[0].present) fail('Production uses unsupported MFA/SSO/OAuth/passkey/SCIM or newer Auth feature data. A specialized encrypted/provider migration is required; no QA replacement started.');
  }
  for (const column of catalog.columns.filter(c => c.schema === 'auth' && /encrypt|cipher|secret/i.test(c.name) && !(c.table_name === 'users' && c.name === 'encrypted_password'))) {
    if ((await query(client, `SELECT EXISTS(SELECT 1 FROM ${qualified(column)} WHERE ${identifier(column.name)} IS NOT NULL) AS present`))[0].present) fail('Production contains unsupported encrypted Auth material. No partial copy will be performed.');
  }
  if ((await query(client, "SELECT EXISTS(SELECT 1 FROM auth.identities WHERE provider <> 'email') AS present"))[0].present ||
      (await query(client, "SELECT EXISTS(SELECT 1 FROM auth.users WHERE coalesce(phone,'') <> '' OR is_sso_user IS TRUE) AS present"))[0].present) {
    fail('This runner supports email/password accounts only. Provider/phone migration needs a separate compatibility review.');
  }
  if (catalog.columns.some(c => c.schema === 'auth' && c.table_name === 'instances' && c.name === 'raw_base_config')) {
    if ((await query(client, "SELECT EXISTS(SELECT 1 FROM auth.instances WHERE raw_base_config IS NOT NULL AND btrim(raw_base_config::text) NOT IN ('','{}','null')) AS present"))[0].present) {
      fail('Production Auth instances contain project-specific configuration; copying it needs a separate key/configuration review.');
    }
  }
  const extras = catalog.otherTables.filter(t => !platformSchemas.has(t.schema));
  if (extras.length) fail('Production has unreviewed additional schema tables outside the Auth/application copy boundary.');
  for (const table of catalog.otherTables.filter(t => ['storage.buckets', 'storage.objects', 'vault.secrets', 'cron.job', 'net.http_request_queue'].includes(tableKey(t)))) {
    if ((await query(client, `SELECT EXISTS(SELECT 1 FROM ${qualified(table)}) AS present`))[0].present) fail('Production has Storage/Vault/scheduled/external-operation data requiring a separate migration. No partial copy will be performed.');
  }
}
async function sequenceStates(client, catalog) {
  const result = {};
  for (const sequence of catalog.sequences) {
    const key = `${sequence.schema}.${sequence.name}`;
    // A sequence descriptor also names its owning table: qualify the sequence explicitly.
    const name = qualified({ schema: sequence.schema, name: sequence.name });
    const state = (await query(client, `SELECT last_value::text,is_called FROM ${name}`))[0];
    const { maximum } = (await query(client, `SELECT max(${identifier(sequence.column_name)})::text AS maximum FROM ${qualified({ schema: sequence.table_schema, name: sequence.table_name })}`))[0];
    const next = BigInt(state.last_value) + (state.is_called ? BigInt(sequence.increment) : 0n);
    if (next > BigInt(sequence.maximum) || (maximum !== null && next <= BigInt(maximum))) fail('Sequence allocation state is exhausted or behind existing IDs; refusing an inexact restore.');
    result[key] = state;
  }
  return result;
}

export async function privateRunDirectory(runId, create = false, root = PRIVATE_DIR) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)) fail('Invalid refresh run ID.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await lstat(root);
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail('Private database directory must not be a symlink.');
  await chmod(root, 0o700);
  const path = join(root, `refresh-${runId}`);
  if (create) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('Refresh run directory must be private and not a symlink.');
  return path;
}
async function saveFile(directory, name, value) {
  const path = join(directory, name);
  await writeFile(path, value, { flag: 'wx', mode: 0o600 });
  return path;
}
async function fileHash(path) {
  const hash = createHash('sha256');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('Private refresh artifact has unsafe permissions/type.');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function saveStatus(directory, value) {
  const path = join(directory, 'status.json');
  // The run directory is private, unique and checked before use.
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function backup(client, database, catalog, directory, prefix, source, run = nativeTool, signal) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='120s'");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query(`LOCK TABLE ${selectedTables(catalog).map(qualified).join(',')} IN ACCESS SHARE MODE`);
  const current = await readCatalog(client);
  if (shapeHash(current) !== shapeHash(catalog)) fail('Schema changed after preview; rerun preflight.');
  if (selectedTables(current).reduce((n, t) => n + BigInt(t.bytes), 0n) > limitBytes) fail('Selected data exceeds the 256 MiB bound for this first runner. Use a reviewed larger-database migration.');
  if (source) await checkSourceContent(client, current);
  const rows = await fingerprints(client, current);
  const sequences = await sequenceStates(client, current);
  const snapshot = (await query(client, 'SELECT pg_export_snapshot() AS id'))[0].id;
  const passfile = await saveFile(directory, `${prefix}.pgpass`, passfileLine(database));
  const env = pgEnvironment(database, passfile, true);
  const archive = await saveFile(directory, `${prefix}.dump`, '');
  await run('pg_dump', dumpArguments(archive, current, snapshot), { env, signal });
  const toc = restoreList(await run('pg_restore', ['--list', archive], { env, signal }), current);
  const list = await saveFile(directory, `${prefix}.toc`, toc);
  const sql = await saveFile(directory, `${prefix}.data.sql`, '');
  await run('pg_restore', ['--data-only', '--no-owner', '--no-privileges', '--no-comments', '--use-list', list, '--file', sql, archive], { env, signal });
  if (shapeHash(await readCatalog(client)) !== shapeHash(current)) fail('Schema changed during backup; no QA replacement started.');
  await client.query('COMMIT');
  return { rows, sequences, schemaHash: shapeHash(current), createdAt: new Date().toISOString() };
}

export async function restore(database, catalog, state, directory, prefix, previous, run = nativeTool, signal) {
  const metadataGuard = schemaGuardSql(catalog, await readFile(catalogSqlPath, 'utf8'));
  const before = await saveFile(directory, `${prefix}.before-${randomUUID()}.sql`, restorePrefix(catalog, previous, metadataGuard));
  const after = await saveFile(directory, `${prefix}.after-${randomUUID()}.sql`,
    "SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC';\n" + verifyRowsSql(catalog, state.rows) + '\n' + verifyForeignKeysSql(catalog) + '\n' +
    sequenceSql(catalog, state.sequences) + '\n' + verifySequencesSql(catalog, state.sequences));
  const passfile = join(directory, 'qa.pgpass');
  await run('psql', ['--no-psqlrc', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=terse',
    '--file', before, '--file', join(directory, `${prefix}.data.sql`), '--file', after],
  { env: pgEnvironment(database, passfile, false), signal });
}
async function acquireQaLock(client) {
  const result = await client.query('SELECT pg_try_advisory_lock($1,$2) AS locked', LOCK);
  if (!result.rows[0].locked) fail('Another refresh/recovery is using QA.');
}
async function removePassfiles(directory) {
  for (const name of ['production.pgpass', 'qa.pgpass']) await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function invalidateEvidence(root = PRIVATE_DIR, environment = 'qa') { await unlink(join(root, `${environment}-verification.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
async function qaAudit(client, database, files) {
  const report = await readAudit(client, database, files);
  const status = migrationStatus(report, files);
  if (findings(report, files).length || status.pending.length || status.remoteOnly.length) fail('QA schema/permissions/migration ledger are not current. Run npm run db -- audit --database <qa-profile>.');
  return report;
}

export async function applyCopy(settings, options, sourceCatalog, qaCatalog, files, { run = nativeTool, open = connect, audit = qaAudit, root = PRIVATE_DIR, env = process.env, log = console.log, signal } = {}) {
  if (!options.apply) fail('Copy execution requires --apply. Use the default metadata preview first.');
  const targets = refreshTargets(settings, options, env);
  const blockers = compatibility(sourceCatalog, qaCatalog);
  if (blockers.length) fail(blockers.join(' '));
  const runId = randomUUID(); const directory = await privateRunDirectory(runId, true, root);
  const status = { schemaVersion: 1, runId, sourceRef: targets.production.projectRef, qaRef: targets.qa.projectRef,
    createdAt: new Date().toISOString(), status: 'preparing' };
  let source; let qa; let replacing = false;
  try {
    await saveStatus(directory, status);
    source = await open(targets.production); qa = await open(targets.qa);
    await source.query('SET default_transaction_read_only=on');
    await acquireQaLock(qa);
    const before = await audit(qa, targets.qa, files);
    const originalQa = await backup(qa, targets.qa, qaCatalog, directory, 'qa', false, run, signal);
    const production = await backup(source, targets.production, sourceCatalog, directory, 'production', true, run, signal);
    const hashes = {};
    for (const name of artifacts) hashes[name] = await fileHash(join(directory, name));
    const manifest = { ...status, qaCatalog, originalQa, production, hashes, qaCatalogHash: before.catalogHash };
    await saveFile(directory, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    // Backup snapshot must still match under the destination table locks. No
    // earlier passing QA report remains valid after a replacement attempt.
    await invalidateEvidence(root, options.database ?? 'qa');
    await saveStatus(directory, { ...status, status: 'replacing' });
    replacing = true;
    await restore(targets.qa, qaCatalog, production, directory, 'production', originalQa, run, signal);
    const after = await audit(qa, targets.qa, files);
    if (after.catalogHash !== before.catalogHash) fail('QA schema/ledger changed during refresh; use the recovery runbook.');
    status.status = 'copied-needs-login-and-api-verification';
    await saveStatus(directory, status);
    log(`QA data copy verified. Private recovery run: ${runId}. Sign in to QA locally with an original account, then rerun npm run db -- test --database <qa-profile> --api <server-profile>. No promotion evidence was created by this copy.`);
  } catch (error) {
    status.status = replacing ? 'needs-recovery-review' : 'failed-before-replacement';
    await saveStatus(directory, status);
    // Do not guess whether a broken connection committed. setval is not
    // transactional; even rolled-back table data can require sequence recovery.
    throw new RefreshError(`Refresh stopped (${status.status}). Private run: ${runId}. ${error instanceof RefreshError ? error.message : 'Database diagnostics withheld.'} Keep QA quiesced and follow the recovery instructions if replacement began.`);
  } finally {
    await source?.end().catch(() => {}); await qa?.end().catch(() => {});
    await removePassfiles(directory);
  }
}

export async function loadRun(runId, qaRef, root = PRIVATE_DIR) {
  const directory = await privateRunDirectory(runId, false, root);
  await fileHash(join(directory, 'manifest.json'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.runId !== runId || manifest.qaRef !== qaRef || !manifest.originalQa || !manifest.qaCatalog) fail('Private recovery manifest does not match QA/run.');
  // Source exports can be deleted after verification without destroying the
  // independent QA recovery path. Recovery needs only the original QA archive.
  for (const name of artifacts.filter(name => name.startsWith('qa.'))) {
    if (await fileHash(join(directory, name)) !== manifest.hashes[name]) fail('Private backup artifact changed; recovery refused.');
  }
  return { directory, manifest };
}
export async function recoverCopy(settings, options, files, { run = nativeTool, open = connect, audit = qaAudit, root = PRIVATE_DIR, env = process.env, log = console.log, signal } = {}) {
  if (!options.apply) fail('Recovery execution requires --apply.');
  const { qa: database } = refreshTargets(settings, options, env);
  const { directory, manifest } = await loadRun(options.recover, database.projectRef, root);
  const client = await open(database);
  try {
    await acquireQaLock(client);
    const current = await readCatalog(client);
    if (shapeHash(current) !== manifest.originalQa.schemaHash) fail('QA schema changed since backup; recovery needs manual review.');
    const currentAudit = await audit(client, database, files);
    if (currentAudit.catalogHash !== manifest.qaCatalogHash) fail('QA schema/ledger changed since backup; recovery refused.');
    await saveFile(directory, 'qa.pgpass', passfileLine(database));
    await invalidateEvidence(root, options.database ?? 'qa');
    await saveStatus(directory, { runId: options.recover, qaRef: database.projectRef, status: 'recovering' });
    await restore(database, current, manifest.originalQa, directory, 'qa', null, run, signal);
    await saveStatus(directory, { runId: options.recover, qaRef: database.projectRef, status: 'recovered-needs-api-verification' });
    log('Previous QA rows and sequence state restored and verified. Rerun npm run db -- test --database <qa-profile> --api <server-profile>; no previous promotion report was retained.');
  } catch (error) {
    await saveStatus(directory, { runId: options.recover, qaRef: database.projectRef, status: 'needs-recovery-review' });
    throw new RefreshError(error instanceof RefreshError ? error.message : 'Recovery failed; private database diagnostics withheld. Keep QA quiesced and review the backup.');
  } finally { await client.end().catch(() => {}); await removePassfiles(directory); }
}
async function cleanupRun(settings, options) {
  const ref = refreshTargets(settings, options).qa.projectRef;
  const directory = await privateRunDirectory(options.cleanup);
  await fileHash(join(directory, 'status.json'));
  const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
  if (status.qaRef !== ref || !['copied-needs-login-and-api-verification', 'recovered-needs-api-verification', 'failed-before-replacement'].includes(status.status)) fail('Run may be active or need recovery. Review it before deleting recovery artifacts.');
  for (const name of await readdir(directory)) {
    const stat = await lstat(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('Unexpected private artifact type; cleanup refused.');
  }
  await rm(directory, { recursive: true });
  console.log('Selected private refresh artifacts removed. No database connection was made.');
}

export async function main(args = process.argv.slice(2), signal) {
  const options = parseRefreshArguments(args); const settings = await loadSettings();
  const targets = refreshTargets(settings, options);
  if (options.cleanup) {
    if (!options.apply) { console.log('Private artifact cleanup preview only. Supply --apply --confirm-ref and the run ID to delete that run.'); return; }
    return cleanupRun(settings, options);
  }
  const files = await migrationFiles(); await checkManifest(files);
  const tools = await checkTools();
  if (options.recover) {
    if (!options.apply) { console.log('QA recovery preview only. Supply --apply and all replacement acknowledgements to restore that run.'); return; }
    if (tools.some(t => !t.available)) fail('Install PostgreSQL 17 client tools or set DATABASE_PG_BIN before recovery.');
    return recoverCopy(settings, options, files, { signal });
  }
  const source = await readOnlyCatalog(targets.production); const qa = await readOnlyCatalog(targets.qa);
  const blockers = compatibility(source, qa);
  if (tools.some(t => !t.available)) blockers.push('Install PostgreSQL 17 client tools or set DATABASE_PG_BIN.');
  if (!options.apply) {
    console.log(JSON.stringify({ source: targets.production.projectRef, destination: targets.qa.projectRef,
      mode: 'metadata-only-preview', selectedTables: selectedTables(source).map(tableKey), tools, blockers,
      executionChecks: 'Data-dependent encrypted/provider/Storage/Vault/integration checks run only after explicit apply. Stop QA traffic and other jobs before replacement. No data was exported.' }, null, 2));
    return;
  }
  if (blockers.length) fail(blockers.join(' '));
  return applyCopy(settings, options, source, qa, files, { signal });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort(); process.on('SIGINT', stop); process.on('SIGTERM', stop);
  main(undefined, controller.signal).catch(error => {
    console.error(error instanceof RefreshError ? error.message : 'Refresh/preflight failed. Database diagnostics were withheld to avoid exposing private Auth data. Check credentials, TLS and the private run status.');
    process.exitCode = 1;
  }).finally(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
}
