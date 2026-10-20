import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  target, projectRef, requireQa, confirmTarget, migrationFiles, fileManifest, validateManifest,
  readAudit, assertMigrationHistory, redact, privateJson, sha256,
} from './core.mjs';
import { findings, expectedFunctionBodies } from './contract.mjs';
import { parseArguments, verifyQaEvidence } from './cli.mjs';
import { qaApiSettings, createAccounts, removeAccounts, validateAccountsManifest, runtimeEnvironment, qaBackendUrl } from './qa.mjs';

const production = 'rshgohxdntjglnqilyls';
const qa = 'abcdefghijklmnopqrst';
const settings = { production: { projectRef: production }, qa: { projectRef: qa } };
const connection = ref => `postgresql://postgres.${ref}:dummy%40password@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;

test('target binds direct/session connections to explicit environment and enforces TLS', () => {
  const result = target(settings, 'qa', { QA_DATABASE_URL: connection(qa) });
  assert.equal(result.projectRef, qa);
  assert.equal(new URL(result.url).searchParams.get('sslmode'), 'verify-full');
  assert.ok(target(settings, 'production', { PRODUCTION_DATABASE_URL: `postgresql://postgres:dummy@db.${production}.supabase.co:5432/postgres` }));
  for (const url of [connection(production), connection(qa).replace(':5432/', ':6543/'),
    connection(qa).replace('pooler.supabase.com', 'evil.test'), connection(qa).replace('/postgres?', '/other?'),
    connection(qa) + '&sslpassword=dummy', `https://${qa}.supabase.co`, 'not a URL']) {
    assert.throws(() => target(settings, 'qa', { QA_DATABASE_URL: url }));
  }
  assert.throws(() => target(settings, 'qa', {}), /QA_DATABASE_URL/);
  assert.throws(() => target(settings, 'other', {}), /explicitly/);
});

test('QA mutation commands cannot target production or unregistered QA', () => {
  assert.throws(() => requireQa(settings, 'production'), /only for QA/);
  assert.throws(() => projectRef({ ...settings, qa: { projectRef: production } }, 'qa'), /different project/);
  assert.throws(() => projectRef({ ...settings, qa: { projectRef: null } }, 'qa'), /Register/);
  assert.throws(() => confirmTarget(qa, { apply: true, confirmRef: production }));
  assert.throws(() => confirmTarget(qa, { confirmRef: qa }));
  confirmTarget(qa, { apply: true, confirmRef: qa });
});

test('database audit is an explicitly read-only transaction and exports no user rows or stored migration SQL', async () => {
  const queries = [];
  const catalog = { tables: [] };
  const client = { query: async sql => {
    queries.push(sql);
    if (sql === 'SHOW server_version') return { rows: [{ server_version: '17.6' }] };
    if (sql.includes('as catalog')) return { rows: [{ catalog }] };
    if (sql.includes('to_regclass')) return { rows: [{ exists: true }] };
    if (sql.startsWith('SELECT version')) return { rows: [{ version: '202609250001' }] };
    return { rows: [] };
  } };
  const audit = await readAudit(client, { environment: 'production', projectRef: production }, []);
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(audit.catalogHash, sha256(JSON.stringify(catalog)));
  assert.deepEqual(audit.remoteMigrations, ['202609250001']);
  assert.ok(queries.every(q => !/\bfrom\s+(?:public\.(?:favorite_locations|favorite_trips|trip_history)|auth\.users)\b/i.test(q)));
  assert.equal(JSON.stringify(audit).includes('dummy'), false);
});

test('failed audit rolls back and missing history is reported without creating it', async () => {
  const queries = [];
  const client = { query: async sql => {
    queries.push(sql);
    if (sql === 'SHOW server_version') return { rows: [{ server_version: '17.6' }] };
    if (sql.includes('as catalog')) return { rows: [{ catalog: { tables: [] } }] };
    if (sql.includes('to_regclass')) return { rows: [{ exists: false }] };
    return { rows: [] };
  } };
  assert.deepEqual((await readAudit(client, { environment: 'qa', projectRef: qa }, [])).remoteMigrations, []);
  assert.equal(queries.some(q => /CREATE TABLE|INSERT INTO|SELECT version/.test(q)), false);
  queries.length = 0;
  const broken = { query: async sql => { queries.push(sql); if (sql.includes('statement_timeout')) throw new Error('query failed'); } };
  await assert.rejects(() => readAudit(broken, { environment: 'production', projectRef: production }, []));
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('deployment blocks untracked existing schemas, remote-only versions and migration history gaps', () => {
  const files = [{ version: '1' }, { version: '2' }, { version: '3' }];
  const report = { catalog: { tables: [{ name: 'trip_history' }] }, historyTableExists: false, remoteMigrations: [] };
  assert.throws(() => assertMigrationHistory(report, files), /recorded baseline/);
  assert.throws(() => assertMigrationHistory({ ...report, historyTableExists: true, remoteMigrations: ['4'] }, files), /missing from Git/);
  assert.throws(() => assertMigrationHistory({ ...report, historyTableExists: true, remoteMigrations: ['1', '3'] }, files), /gaps/);
  assert.deepEqual(assertMigrationHistory({ ...report, historyTableExists: true, remoteMigrations: ['1', '2'] }, files).pending, ['3']);
  assert.equal(assertMigrationHistory({ ...report, catalog: { tables: [] } }, files).pending.length, 3);
});

test('migration filenames are ordered, unique, and hashed without executing SQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'db-migrations-'));
  try {
    await writeFile(join(directory, '202610200002_later.sql'), 'select 2;');
    await writeFile(join(directory, '202610200001_earlier.sql'), 'select 1;');
    const files = await migrationFiles(directory);
    assert.equal(files[0].version, '202610200001');
    assert.equal(files[0].sha256, sha256('select 1;'));
    assert.equal(Object.hasOwn(fileManifest(files)[0], 'sql'), false);
    await writeFile(join(directory, '202610200001_duplicate.sql'), 'select 3;');
    await assert.rejects(() => migrationFiles(directory), /duplicate/);
  } finally { await rm(directory, { recursive: true }); }
});

test('QA evidence must match the current project, migrations and freshness', () => {
  const files = [{ version: '1', name: '1_a.sql', sha256: 'abc' }];
  const now = Date.parse('2026-10-20T12:00:00Z');
  const evidence = { status: 'passed', projectRef: qa, generatedAt: '2026-10-20T11:00:00Z', migrations: fileManifest(files) };
  verifyQaEvidence(evidence, settings, files, now);
  for (const value of [{ ...evidence, status: 'failed' }, { ...evidence, projectRef: production },
    { ...evidence, generatedAt: '2026-10-18T12:00:00Z' }, { ...evidence, generatedAt: 'bad' },
    { ...evidence, generatedAt: '2026-10-21T12:00:00Z' }, { ...evidence, migrations: [] }]) {
    assert.throws(() => verifyQaEvidence(value, settings, files, now), /passing QA/);
  }
});

test('database password, token and modified connection strings are redacted from tool output', () => {
  const env = { PRODUCTION_DATABASE_URL: connection(production), QA_SUPABASE_ADMIN_KEY: 'sb_secret_dummy', SUPABASE_ACCESS_TOKEN: 'test-management-token' };
  const safe = redact(`${connection(production)} dummy@password dummy%40password sb_secret_dummy test-management-token\npostgres://postgres:secret@db.example/postgres`, env);
  for (const secret of ['dummy@password', 'dummy%40password', 'sb_secret_dummy', 'test-management-token', 'postgres://']) assert.ok(!safe.includes(secret));
});

test('audit and fixture reports are private and never overwrite an existing file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'db-reports-'));
  try {
    const file = await privateJson('report.json', { status: 'test' }, directory);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(() => privateJson('report.json', {}, directory), /EEXIST/);
  } finally { await rm(directory, { recursive: true }); }
});

test('CLI rejects incomplete/unknown options and parses explicit confirmation', () => {
  assert.deepEqual(parseArguments(['migrate', 'qa', '--apply', '--confirm-ref', qa]), { command: 'migrate', environment: 'qa', options: { apply: true, confirmRef: qa } });
  assert.throws(() => parseArguments(['migrate', 'qa', '--confirm-ref']));
  assert.throws(() => parseArguments(['migrate', 'qa', '--include-all']));
});

test('QA API settings derive the host from registered QA and reject privileged public keys', () => {
  const env = { QA_SUPABASE_ADMIN_KEY: 'sb_secret_test', QA_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
  assert.equal(qaApiSettings(settings, env).url, `https://${qa}.supabase.co`);
  assert.throws(() => qaApiSettings(settings, { ...env, QA_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_test' }));
  const key = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  assert.throws(() => qaApiSettings(settings, { ...env, QA_SUPABASE_ADMIN_KEY: key({ role: 'service_role', ref: production }) }));
  assert.throws(() => qaApiSettings(settings, { ...env, QA_SUPABASE_ADMIN_KEY: 'not-a-key' }));
  assert.ok(qaApiSettings(settings, { QA_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }, false));
});

test('temporary accounts are preconfirmed without sending emails and cleanup owns the exact run', async () => {
  const created = []; const removed = [];
  const admin = { auth: { admin: {
    createUser: async input => { created.push(input); return { data: { user: { id: String(created.length) } } }; },
    getUserById: async id => ({ data: { user: { id, app_metadata: created[Number(id) - 1].app_metadata } } }),
    deleteUser: async id => { removed.push(id); return { data: {} }; },
  } } };
  const accounts = [];
  const client = () => ({ auth: { signInWithPassword: async ({ email }) => ({ data: { session: {
    user: { id: String(created.findIndex(c => c.email === email) + 1) }, access_token: 'test-token',
  } } }) } });
  await createAccounts(admin, client, 'test-run', accounts);
  assert.equal(accounts.length, 2);
  assert.ok(created.every(c => c.email_confirm === true && c.email.endsWith('@example.invalid') && c.password.length > 20));
  assert.ok(created.every(c => c.app_metadata.database_qa_fixture && c.app_metadata.database_qa_run === 'test-run'));
  await removeAccounts(admin, 'other-run', accounts).then(() => assert.fail('Must reject ownership mismatch'), () => {});
  assert.equal(removed.length, 0);
  await removeAccounts(admin, 'test-run', accounts);
  assert.deepEqual(removed, ['1', '2']);
});

test('failed sign-in still records the created account for cleanup', async () => {
  const admin = { auth: { admin: { createUser: async () => ({ data: { user: { id: 'created-id' } } }) } } };
  const accounts = [];
  await assert.rejects(() => createAccounts(admin, () => ({ auth: { signInWithPassword: async () => ({ error: new Error('denied') }) } }), 'test-run', accounts));
  assert.equal(accounts[0].id, 'created-id');
});

test('backend runtime does not inherit database/admin/management credentials', () => {
  const env = { PATH: '/usr/bin', PRODUCTION_DATABASE_URL: 'secret', QA_DATABASE_URL: 'secret', QA_SUPABASE_ADMIN_KEY: 'secret', SUPABASE_ACCESS_TOKEN: 'secret', SAVED_ITEMS_TEST_TOKEN_A: 'secret' };
  assert.deepEqual(runtimeEnvironment(env), { PATH: '/usr/bin' });
});

test('cleanup manifests are project-bound and limited to this run’s accounts', () => {
  const runId = '00000000-0000-4000-8000-000000000000';
  validateAccountsManifest({ schemaVersion: 1, projectRef: qa, runId, accounts: [{ id: runId }] }, qa);
  assert.throws(() => validateAccountsManifest({ schemaVersion: 1, projectRef: production, runId, accounts: [] }, qa));
  assert.throws(() => validateAccountsManifest({ schemaVersion: 1, projectRef: qa, runId, accounts: [{ id: 'bad-id' }] }, qa));
});

test('application contract detects the reported missing history grant and policy', async () => {
  const files = await migrationFiles();
  const bodies = expectedFunctionBodies(files);
  assert.deepEqual([...bodies.keys()].sort(), ['record_planned_trip', 'trip_point_key']);
  const catalog = { tables: [{ name: 'trip_history', rls: true }], columns: [], constraints: [],
    policies: [{ table_name: 'trip_history', name: 'own_history', command: 'SELECT', roles: ['authenticated'], using_expression: '(user_id = ( SELECT auth.uid() AS uid))' }],
    tableGrants: [{ table_name: 'trip_history', grantee: 'authenticated', privilege: 'SELECT' }],
    functions: [], functionGrants: [] };
  const messages = findings({ catalog }, files);
  assert.ok(messages.includes('Missing authenticated DELETE: trip_history'));
  assert.ok(messages.includes('Missing/incompatible ownership policy: trip_history.delete_own_history'));
  assert.ok(!messages.includes('Missing/incompatible ownership policy: trip_history.own_history'));
});


test('registered migration changes and removal fail even while adding new versions', () => {
  const files = [{ version: '1', name: '1_a.sql', sha256: 'hash1' }];
  const extra = { version: '2', name: '2_b.sql', sha256: 'hash2' };
  validateManifest(files, files);
  assert.throws(() => validateManifest(files, [...files, extra]), /Register new migrations/);
  validateManifest(files, [...files, extra], true);
  assert.throws(() => validateManifest(files, [{ ...files[0], sha256: 'changed' }, extra], true), /changed or disappeared/);
  assert.throws(() => validateManifest(files, [], true), /changed or disappeared/);
});

test('application contract accepts the expected schema and catches ownership or function drift', async () => {
  const files = await migrationFiles();
  const bodies = expectedFunctionBodies(files);
  const requiredColumns = {
    favorite_locations: { user_id: 'uuid', location_key: 'text', location: 'jsonb', created_at: 'timestamp with time zone' },
    favorite_trips: { user_id: 'uuid', trip_key: 'text', origin: 'jsonb', destination: 'jsonb', created_at: 'timestamp with time zone' },
    trip_history: { id: 'bigint', user_id: 'uuid', trip_key: 'text', origin: 'jsonb', destination: 'jsonb', created_at: 'timestamp with time zone' },
  };
  const catalog = { tables: [], columns: [], constraints: [], policies: [], tableGrants: [], functions: [], functionGrants: [] };
  for (const [table_name, columns] of Object.entries(requiredColumns)) {
    catalog.tables.push({ name: table_name, rls: true });
    for (const [name, type] of Object.entries(columns)) catalog.columns.push({ table_name, name, type, not_null: true });
    catalog.constraints.push({ table_name, type: 'f', definition: 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE' });
    const history = table_name === 'trip_history';
    catalog.constraints.push({ table_name, type: 'p', definition: `PRIMARY KEY (${history ? 'id' : `user_id, ${table_name === 'favorite_locations' ? 'location_key' : 'trip_key'}`})` });
    const commands = history ? [['own_history', 'SELECT'], ['delete_own_history', 'DELETE']] : [[table_name === 'favorite_locations' ? 'own_locations' : 'own_trips', 'ALL']];
    for (const [name, command] of commands) catalog.policies.push({ table_name, name, command, roles: ['authenticated'], using_expression: '(user_id = ( SELECT auth.uid() AS uid))', check_expression: '(user_id = auth.uid())' });
    for (const privilege of history ? ['SELECT', 'DELETE'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) catalog.tableGrants.push({ table_name, grantee: 'authenticated', privilege });
  }
  catalog.constraints.push({ table_name: 'trip_history', type: 'u', definition: 'UNIQUE (user_id, trip_key)' });
  for (const [name, body] of bodies) catalog.functions.push({ name, body, settings: ['search_path=""'], security_definer: name === 'record_planned_trip' });
  catalog.functionGrants.push({ name: 'record_planned_trip', grantee: 'authenticated', privilege: 'EXECUTE' });
  assert.deepEqual(findings({ catalog }, files), []);
  catalog.policies[0].using_expression = 'true';
  catalog.functions[0].body = 'select 1';
  const drift = findings({ catalog }, files);
  assert.ok(drift.some(message => message.includes('ownership policy')));
  assert.ok(drift.some(message => message.includes('function body/signature')));
});


test('named QA profiles remain distinct and production evidence binds the chosen project', () => {
  const qa2 = 'tsrqponmlkjihgfedcba';
  const profiles = { production:{kind:'production',projectRef:production},
    qa1:{kind:'qa',projectRef:qa}, qa2:{kind:'qa',projectRef:qa2} };
  assert.equal(target(profiles,'qa2',{QA2_DATABASE_URL:connection(qa2)}).projectRef,qa2);
  assert.equal(requireQa(profiles,'qa1'),qa);
  assert.throws(() => requireQa({...profiles,qa2:{kind:'qa',projectRef:production}},'qa2'));
  assert.throws(() => requireQa({...profiles,qa2:{kind:'production',projectRef:qa2}},'qa2'));
  const files = [{version:'1',name:'1_a.sql',sha256:'abc'}];
  const now = Date.parse('2026-10-20T12:00:00Z');
  const evidence = {status:'passed',projectRef:qa,generatedAt:'2026-10-20T11:00:00Z',migrations:fileManifest(files)};
  verifyQaEvidence(evidence,profiles,files,now,'qa1');
  assert.throws(() => verifyQaEvidence(evidence,profiles,files,now,'qa2'));
  assert.deepEqual(parseArguments(['test','--database','qa2','--api','local']),
    {command:'test',environment:'qa2',options:{api:'local'}});
  assert.throws(() => parseArguments(['test','--database','qa1','--database','qa2']));
});

test('QA test API selection is explicit and rejects unsafe/missing URLs before fixtures', () => {
  assert.equal(qaBackendUrl('local',{LOCAL_API_URL:'http://localhost:18787'}).port,'18787');
  for (const value of ['http://remote.example','https://user:password@example.com','https://example.com/?token=private']) {
    assert.throws(() => qaBackendUrl('qa2',{QA2_API_URL:value}));
  }
  assert.throws(() => qaBackendUrl(undefined,{}));
  assert.throws(() => qaBackendUrl('qa2',{}));
});
