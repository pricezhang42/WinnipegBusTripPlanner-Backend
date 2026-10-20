// Native archive/restore rehearsal with synthetic data in disposable QA schemas.
// Never connects to production or selects real auth/public rows.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings, target, connect, requireQa } from './core.mjs';
import { nativeTool, privateRunDirectory, fingerprints, checkTools } from './refresh.mjs';
import { identifier, qualified, selectedTables, pgEnvironment, passfileLine, dumpArguments, restoreList,
  restorePrefix, verifyRowsSql, verifyForeignKeysSql, sequenceSql, verifySequencesSql } from './refresh-plan.mjs';

const catalog = {
  tables: ['auth.users', 'auth.identities', 'public.favorite_locations', 'public.favorite_trips', 'public.trip_history'].map(name => {
    const [schema, table] = name.split('.'); return { schema, name: table };
  }),
  foreignKeys: ['auth.identities', 'public.favorite_locations', 'public.favorite_trips', 'public.trip_history'].map(name => {
    const [schema, table_name] = name.split('.'); return { schema, table_name, parent_schema: 'auth', parent_table: 'users', columns: ['user_id'], parent_columns: ['id'] };
  }),
  sequences: [{ schema: 'public', name: 'trip_history_id_seq' }],
};
const stateKey = 'public.trip_history_id_seq';
const logical = new Map(selectedTables(catalog).map(t => [t.name, t]));
const runId = randomUUID(); const stem = `refresh_fixture_${runId.replaceAll('-', '')}`;
const sourceSchema = stem + '_src', qaSchema = stem + '_dst';
const schemas = [sourceSchema, qaSchema];
let directory; let client; let snapshotClient;

function mapSql(sql, schema) {
  for (const table of [...catalog.tables, { schema: 'public', name: 'trip_history_id_seq' }]) {
    sql = sql.replaceAll(qualified(table), `${identifier(schema)}.${identifier(table.name)}`);
  }
  return sql;
}
function fixtureClient(schema) {
  return { query: input => client.query({ ...input, text: mapSql(input.text, schema) }) };
}
async function save(name, value = '') {
  const path = join(directory, name); await writeFile(path, value, { mode: 0o600, flag: 'wx' }); return path;
}
async function sequenceState(schema) {
  const { rows: [state] } = await client.query(`SELECT last_value::text,is_called FROM ${identifier(schema)}.trip_history_id_seq`);
  return { [stateKey]: state };
}
async function takeBackup(schema, prefix, database, env) {
  snapshotClient = await connect(database);
  await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await snapshotClient.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const path = await save(`${prefix}.dump`);
  const args = dumpArguments(path, catalog, snapshot).map(arg => mapSql(arg, schema));
  await nativeTool('pg_dump', args, { env });
  let toc = await nativeTool('pg_restore', ['--list', path], { env });
  // TOC IDs control selection/order. Map synthetic physical schema labels back
  // to the logical names solely to test the production allowlist/sort code.
  toc = toc.split('\n').map(line => line.replace(new RegExp(`(TABLE DATA|SEQUENCE SET) ${schema} ([a-z_]+) `), (whole, kind, name) => {
    const schemaName = kind === 'SEQUENCE SET' ? 'public' : logical.get(name)?.schema;
    assert.ok(schemaName); return `${kind} ${schemaName} ${name} `;
  })).join('\n');
  const list = await save(`${prefix}.toc`, restoreList(toc, catalog));
  const data = await save(`${prefix}.sql`);
  await nativeTool('pg_restore', ['--data-only', '--no-owner', '--no-privileges', '--no-comments', '--use-list', list, '--file', data, path], { env });
  await snapshotClient.query('COMMIT'); await snapshotClient.end(); snapshotClient = null;
  return data;
}
async function restoreFixture(data, expected, previous, env, forceFailure = false) {
  const id = randomUUID();
  const before = await save(`${id}.before.sql`, mapSql(restorePrefix(catalog, previous), qaSchema));
  const after = await save(`${id}.after.sql`, mapSql(verifyRowsSql(catalog, expected.rows) + '\n' + verifyForeignKeysSql(catalog) + '\n' +
    sequenceSql(catalog, expected.sequences) + '\n' + verifySequencesSql(catalog, expected.sequences), qaSchema) + (forceFailure ? '\nSELECT 1/0;\n' : ''));
  await nativeTool('psql', ['--no-psqlrc', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1', '--file', before, '--file', data, '--file', after], { env });
}

try {
  const settings = await loadSettings();
  const fixtureDatabase = process.argv[2] === '--database' && process.argv.length === 4 ? process.argv[3] : null;
  requireQa(settings, fixtureDatabase); const database = target(settings, fixtureDatabase);
  assert.ok((await checkTools()).every(t => t.available), 'PostgreSQL 17 clients required');
  directory = await privateRunDirectory(runId, true);
  const passfile = await save('qa.pgpass', passfileLine(database));
  const sourceEnv = pgEnvironment(database, passfile, true), qaEnv = pgEnvironment(database, passfile, false);
  client = await connect(database);
  for (const schema of schemas) {
    await client.query(`CREATE SCHEMA ${identifier(schema)}`);
    await client.query(`
      CREATE TABLE ${identifier(schema)}.users(id uuid PRIMARY KEY,email text,encrypted_password text,created_at timestamptz);
      CREATE TABLE ${identifier(schema)}.identities(id uuid PRIMARY KEY,user_id uuid REFERENCES ${identifier(schema)}.users(id),identity_data jsonb);
      CREATE TABLE ${identifier(schema)}.favorite_locations(user_id uuid REFERENCES ${identifier(schema)}.users(id),location_key text,location jsonb,PRIMARY KEY(user_id,location_key));
      CREATE TABLE ${identifier(schema)}.favorite_trips(user_id uuid REFERENCES ${identifier(schema)}.users(id),trip_key text,origin jsonb,destination jsonb,PRIMARY KEY(user_id,trip_key));
      CREATE TABLE ${identifier(schema)}.trip_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid REFERENCES ${identifier(schema)}.users(id),origin jsonb,created_at timestamptz);
    `);
    const source = schema === sourceSchema; const historyId = source ? '9007199254740999' : '7';
    await client.query(`
      INSERT INTO ${identifier(schema)}.users VALUES ('11111111-1111-4111-8111-111111111111',${source ? "'source-fixture@example.invalid'" : "'old-qa@example.invalid'"},extensions.crypt('synthetic-password-never-used',extensions.gen_salt('bf')),'2026-01-01T00:00:00.123456Z');
      INSERT INTO ${identifier(schema)}.identities VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','{"provider":"email"}');
      INSERT INTO ${identifier(schema)}.favorite_locations VALUES ('11111111-1111-4111-8111-111111111111','fixture','{"coordinates":[-97.1,49.8]}');
      INSERT INTO ${identifier(schema)}.favorite_trips VALUES ('11111111-1111-4111-8111-111111111111','fixture','{"coordinates":[-97.1,49.8]}','{"coordinates":[-97.2,49.9]}');
      INSERT INTO ${identifier(schema)}.trip_history OVERRIDING SYSTEM VALUE VALUES (${historyId},'11111111-1111-4111-8111-111111111111','{"coordinates":[-97.1,49.8]}','2026-01-01T00:00:00.654321Z');
      SELECT setval('${schema}.trip_history_id_seq',${historyId},true);
    `);
  }
  const source = { rows: await fingerprints(fixtureClient(sourceSchema), catalog), sequences: await sequenceState(sourceSchema) };
  const originalQa = { rows: await fingerprints(fixtureClient(qaSchema), catalog), sequences: await sequenceState(qaSchema) };
  const qaData = await takeBackup(qaSchema, 'qa', database, sourceEnv);
  const sourceData = await takeBackup(sourceSchema, 'source', database, sourceEnv);
  // Fixture schema remapping is test-only: the real runner uses identical
  // auth/public schemas and never rewrites user COPY values.
  const mappedData = await save('mapped-source.sql', (await readFile(sourceData, 'utf8')).replaceAll(sourceSchema + '.', qaSchema + '.').replaceAll(identifier(sourceSchema) + '.', identifier(qaSchema) + '.'));
  await restoreFixture(mappedData, source, originalQa, qaEnv);
  assert.deepEqual(await fingerprints(fixtureClient(qaSchema), catalog), source.rows);
  await restoreFixture(mappedData, source, source, qaEnv); // repeat refresh
  await assert.rejects(() => restoreFixture(qaData, originalQa, source, qaEnv, true));
  assert.deepEqual(await fingerprints(fixtureClient(qaSchema), catalog), source.rows); // table transaction rolled back
  assert.equal((await sequenceState(qaSchema))[stateKey].last_value, '7'); // setval did not roll back
  await restoreFixture(qaData, originalQa, null, qaEnv); // explicit complete recovery
  assert.deepEqual(await fingerprints(fixtureClient(qaSchema), catalog), originalQa.rows);
  assert.deepEqual(await sequenceState(qaSchema), originalQa.sequences);
  assert.deepEqual(await fingerprints(fixtureClient(sourceSchema), catalog), source.rows);
  console.log('Native hosted QA fixture rehearsal passed: real archives, COPY ordering, bcrypt hash/value fidelity, repeat refresh, failed-transaction rollback and explicit sequence/data recovery. No production connection or real Auth/app data was used.');
} catch {
  console.error('Native QA fixture rehearsal failed. Private diagnostics withheld. Check the fixture cleanup result and PostgreSQL client configuration.');
  process.exitCode = 1;
} finally {
  await snapshotClient?.end().catch(() => {});
  let clean = true;
  if (client) for (const schema of schemas) {
    try { await client.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`); } catch { clean = false; }
  }
  await client?.end();
  if (clean && directory) await rm(directory, { recursive: true });
  if (!clean) { console.error(`Fixture cleanup requires review: ${sourceSchema}, ${qaSchema}. Private rehearsal artifacts retained.`); process.exitCode = 1; }
}
