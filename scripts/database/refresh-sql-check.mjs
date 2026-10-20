// Explicit hosted QA SQL rehearsal. Uses only session-local temporary fixtures;
// no production connection or real auth/public rows are read or modified.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadSettings, target, connect, requireQa } from './core.mjs';
import { fingerprints, readCatalog } from './refresh.mjs';
import { qualified, restorePrefix, verifyRowsSql, verifyForeignKeysSql, sequenceSql, verifySequencesSql, schemaGuardSql, catalogSqlPath } from './refresh-plan.mjs';

const catalog = {
  tables: [{ schema: 'auth', name: 'users' }, { schema: 'auth', name: 'identities' }, { schema: 'public', name: 'trip_history' }],
  foreignKeys: [{ schema: 'auth', table_name: 'identities', parent_schema: 'auth', parent_table: 'users', columns: ['user_id'], parent_columns: ['id'] },
    { schema: 'public', table_name: 'trip_history', parent_schema: 'auth', parent_table: 'users', columns: ['user_id'], parent_columns: ['id'] }],
  sequences: [{ schema: 'public', name: 'trip_history_id_seq' }],
};
const mapFixtureNames = sql => {
  for (const table of [...catalog.tables, { schema: 'public', name: 'trip_history_id_seq' }]) {
    sql = sql.replaceAll(qualified(table), `"pg_temp"."${table.name}"`);
  }
  return sql;
};
const fixtureData = `
INSERT INTO pg_temp.users VALUES ('11111111-1111-4111-8111-111111111111','qa-fixture@example.invalid','synthetic-hash', '2026-01-01T12:00:00.123456Z');
INSERT INTO pg_temp.identities VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','{"provider":"email"}');
INSERT INTO pg_temp.trip_history OVERRIDING SYSTEM VALUE VALUES (9007199254740999,'11111111-1111-4111-8111-111111111111','{"coordinates":[-97.1,49.8]}','2026-01-01T12:00:00.654321Z');
`;
const sourceStates = { 'public.trip_history_id_seq': { last_value: '9007199254740999', is_called: true } };
let client;
try {
  const settings = await loadSettings();
  const fixtureDatabase = process.argv[2] === '--database' && process.argv.length === 4 ? process.argv[3] : null;
  requireQa(settings, fixtureDatabase);
  client = await connect(target(settings, fixtureDatabase));
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'");
  const realMetadata = await readCatalog(client);
  await client.query(schemaGuardSql(realMetadata, await readFile(catalogSqlPath, 'utf8')));
  await client.query(`
    CREATE TEMP TABLE users(id uuid PRIMARY KEY,email text,encrypted_password text,created_at timestamptz);
    CREATE TEMP TABLE identities(id uuid PRIMARY KEY,user_id uuid REFERENCES pg_temp.users(id),identity_data jsonb);
    CREATE TEMP TABLE trip_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid REFERENCES pg_temp.users(id),origin jsonb,created_at timestamptz);
  `);
  const fixtureClient = { query: input => client.query({ ...input, text: mapFixtureNames(input.text) }) };
  const execute = sql => client.query(mapFixtureNames(sql));
  await execute(fixtureData + sequenceSql(catalog, sourceStates));
  const expected = await fingerprints(fixtureClient, catalog);
  await execute('TRUNCATE TABLE "auth"."identities","public"."trip_history","auth"."users" RESTRICT;');
  await client.query("INSERT INTO pg_temp.users VALUES ('33333333-3333-4333-8333-333333333333','old-qa@example.invalid','old-synthetic-hash',now())");
  const oldRows = await fingerprints(fixtureClient, catalog);
  await execute(restorePrefix(catalog, { rows: oldRows, sequences: sourceStates }));
  await execute(fixtureData);
  await execute(verifyRowsSql(catalog, expected));
  await execute(verifyForeignKeysSql(catalog));
  await execute(sequenceSql(catalog, sourceStates) + verifySequencesSql(catalog, sourceStates));
  assert.equal((await client.query("SELECT nextval('pg_temp.trip_history_id_seq')::text AS id")).rows[0].id, '9007199254741000');

  // A changed hash must fail digest verification without echoing its value.
  await client.query('SAVEPOINT wrong_data');
  await client.query("UPDATE pg_temp.users SET encrypted_password='changed-synthetic-hash'");
  await assert.rejects(() => execute(verifyRowsSql(catalog, expected)), error => error.code === 'P0001');
  await client.query('ROLLBACK TO SAVEPOINT wrong_data');
  await execute(verifyRowsSql(catalog, expected));

  await client.query('SAVEPOINT wrong_fk');
  await assert.rejects(() => client.query("INSERT INTO pg_temp.identities VALUES ('44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','{}')"), error => error.code === '23503');
  await client.query('ROLLBACK TO SAVEPOINT wrong_fk');
  await client.query('ROLLBACK');
  console.log('Hosted QA temporary-fixture SQL checks passed: exact row digests, hash mismatch, FK enforcement, bigint IDs and sequence allocation. All temporary fixtures rolled back; no real Auth/app data was read or replaced.');
} catch {
  await client?.query('ROLLBACK').catch(() => {});
  console.error('Hosted QA fixture SQL check failed. Private database diagnostics withheld. No production connection was used.');
  process.exitCode = 1;
} finally { await client?.end(); }
