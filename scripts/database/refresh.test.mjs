import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  parseRefreshArguments, refreshTargets, compatibility, shapeHash, selectedTables, tableKey,
  pgEnvironment, passfileLine, dumpArguments, restoreList, orderedTables, fingerprintQuery,
  verifyRowsSql, verifyForeignKeysSql, sequenceSql, restorePrefix, schemaGuardSql,
} from './refresh-plan.mjs';
import { checkTools, nativeTool, checkSourceContent, privateRunDirectory, applyCopy, recoverCopy, loadRun } from './refresh.mjs';

const production = 'rshgohxdntjglnqilyls', qa = 'dvxkygiqnvvghkmqxhvk';
const settings = { production: { projectRef: production }, qa: { projectRef: qa } };
const url = ref => `postgresql://postgres.${ref}:fixture%3Apassword@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const env = { PRODUCTION_DATABASE_URL: url(production), QA_DATABASE_URL: url(qa) };
const options = { apply: true, confirmSource: production, confirmRef: qa, replaceQaData: true, qaQuiesced: true, copyAuthState: true };
const row = { count: '2', digest: 'a'.repeat(64) };
const nextSequence = { last_value: '9007199254740999', is_called: true };

function catalog() {
  const tables = ['auth.identities', 'auth.mfa_factors', 'auth.schema_migrations', 'auth.users',
    'public.favorite_locations', 'public.favorite_trips', 'public.trip_history'].map(name => {
    const [schema, table] = name.split('.');
    return { schema, name: table, kind: 'r', partition: false, bytes: '8192', can_read: true, can_insert: true, can_truncate: true };
  });
  const columns = tables.map(t => ({ schema: t.schema, table_name: t.name, name: 'id', position: 1, type: 'bigint', not_null: true, identity: '', generated: '', default_expression: null }));
  columns.push({ schema: 'auth', table_name: 'users', name: 'encrypted_password', type: 'text' });
  return { postgresMajor: 17, authVersions: ['20260101000000'], extensions: [], tables, columns, constraints: [], triggers: [], otherTables: [],
    foreignKeys: [{ schema: 'auth', table_name: 'identities', name: 'identity_owner', parent_schema: 'auth', parent_table: 'users', columns: ['user_id'], parent_columns: ['id'], match: 's' },
      { schema: 'public', table_name: 'trip_history', name: 'history_owner', parent_schema: 'auth', parent_table: 'users', columns: ['user_id'], parent_columns: ['id'], match: 's' }],
    sequences: [{ schema: 'public', name: 'trip_history_id_seq', table_schema: 'public', table_name: 'trip_history', column_name: 'id',
      increment: '1', minimum: '1', maximum: '9223372036854775807', cache: '1', cycle: false, can_read: true, can_update: true }] };
}
const rowsFor = c => Object.fromEntries(selectedTables(c).map(t => [tableKey(t), row]));
function toc(c) { return selectedTables(c).map((t, i) => `${i + 1}; 0 ${i + 100} TABLE DATA ${t.schema} ${t.name} postgres`).join('\n') + '\n20; 0 200 SEQUENCE SET public trip_history_id_seq postgres\n'; }

test('refresh requires exact distinct references and every replacement acknowledgement', () => {
  assert.equal(refreshTargets(settings, options, env).qa.projectRef, qa);
  for (const field of ['confirmSource', 'confirmRef', 'replaceQaData', 'qaQuiesced', 'copyAuthState']) {
    assert.throws(() => refreshTargets(settings, { ...options, [field]: undefined }, env));
  }
  assert.throws(() => refreshTargets({ ...settings, qa: { projectRef: production } }, options, env));
  assert.throws(() => refreshTargets(settings, options, { ...env, QA_DATABASE_URL: url(production) }));
  const parsed = parseRefreshArguments(['--apply', '--confirm-ref', qa, '--qa-quiesced', '--copy-auth-state', '--replace-qa-data']);
  assert.equal(parsed.confirmRef, qa);
  for (const args of [['--force'], ['--apply', '--apply'], ['--confirm-ref'], ['--recover', '../outside'], ['--cleanup', 'bad']]) assert.throws(() => parseRefreshArguments(args));
});

test('execution helpers cannot bypass explicit apply even when imported directly', async () => {
  const c = catalog(); const open = () => assert.fail('No connection should open');
  await assert.rejects(() => applyCopy(settings, {}, c, c, [], { open, env }), /requires --apply/);
  await assert.rejects(() => recoverCopy(settings, {}, [], { open, env }), /requires --apply/);
});

test('preflight rejects Auth/schema/FK/trigger/permission differences without examining private rows', () => {
  const source = catalog(), target = catalog();
  assert.deepEqual(compatibility(source, target), []);
  target.tables[0].bytes = '999999';
  assert.equal(shapeHash(source), shapeHash(target));
  const changes = [
    c => c.authVersions.push('new'), c => c.columns[0].type = 'text', c => c.extensions.push({ name: 'new_extension', version: '1' }),
    c => c.tables.push({ schema: 'public', name: 'new_table' }), c => c.tables[0].kind = 'p',
    c => c.triggers.push({ schema: 'auth', table_name: 'users', name: 'notify' }),
    c => c.tables[0].can_truncate = false, c => c.sequences[0].can_update = false,
    c => c.sequences[0].cycle = true,
    c => c.foreignKeys.push({ schema: 'private', table_name: 'profiles', parent_schema: 'auth', parent_table: 'users' }),
    c => c.constraints.push({ schema: 'auth', table_name: 'users', validated: false }),
  ];
  for (const change of changes) { const c = catalog(); change(c); assert.ok(compatibility(source, c).length); }
});

test('native connection settings keep passwords out of argv and production writes disabled', () => {
  const database = refreshTargets(settings, options, env).production;
  const pgEnv = pgEnvironment(database, '/private/run/source.pgpass', true, { PATH: '/bin', SUPABASE_ACCESS_TOKEN: 'private' });
  assert.equal(pgEnv.PGSSLMODE, 'verify-full');
  assert.match(pgEnv.PGOPTIONS, /default_transaction_read_only=on/);
  assert.equal(pgEnv.PGSERVICEFILE, '/dev/null');
  assert.equal(pgEnv.PGPASSWORD, undefined); assert.equal(pgEnv.SUPABASE_ACCESS_TOKEN, undefined);
  assert.match(passfileLine(database), /fixture\\:password/);
  const args = dumpArguments('/private/run/source.dump', catalog(), 'snapshot-id');
  assert.ok(!args.join(' ').includes('password')); assert.ok(!args.join(' ').includes('postgresql://'));
  assert.ok(args.includes('"public"."trip_history_id_seq"'));
  assert.ok(!args.includes('"auth"."schema_migrations"'));
  assert.ok(!args.join(' ').includes('supabase_migrations'));
});

test('restore archive is complete, data-only and ordered with foreign keys enabled', () => {
  const c = catalog(); const list = restoreList(toc(c), c);
  assert.ok(list.indexOf('TABLE DATA auth users') < list.indexOf('TABLE DATA auth identities'));
  assert.ok(list.indexOf('TABLE DATA auth users') < list.indexOf('TABLE DATA public trip_history'));
  assert.match(list, /; 20; 0 200 SEQUENCE SET/);
  assert.throws(() => restoreList(toc(c) + '30; 0 300 TABLE DATA auth schema_migrations postgres\n', c));
  assert.throws(() => restoreList(toc(c).replace(/.*TABLE DATA auth users.*\n/, ''), c));
  assert.throws(() => restoreList(toc(c) + '30; 0 300 FUNCTION public bad postgres\n', c));
  c.foreignKeys.push({ schema: 'auth', table_name: 'users', parent_schema: 'auth', parent_table: 'identities' });
  assert.throws(() => orderedTables(c), /cycle/);
});

test('verification preserves large IDs and avoids JS conversion of original row values', () => {
  const c = catalog(), states = { 'public.trip_history_id_seq': nextSequence };
  const fingerprint = fingerprintQuery({ schema: 'auth', name: 'users' });
  assert.match(fingerprint, /to_jsonb\(t\)::text/); assert.match(fingerprint, /ORDER BY h/);
  const sql = sequenceSql(c, states);
  assert.match(sql, /9007199254740999/); assert.match(sql, /"public"\."trip_history_id_seq"/);
  assert.doesNotMatch(sql, /"public"\."trip_history"'/);
  const prefix = restorePrefix(c, { rows: rowsFor(c), sequences: states });
  assert.match(prefix, /ACCESS EXCLUSIVE/); assert.match(prefix, /TRUNCATE TABLE[^;]+ RESTRICT;/);
  assert.doesNotMatch(prefix, /CASCADE|session_replication_role|DISABLE TRIGGER/);
  assert.ok(prefix.indexOf('row verification') < prefix.indexOf('TRUNCATE TABLE'));
  assert.match(verifyForeignKeysSql(c), /"user_id" IS NOT NULL/);
  assert.throws(() => verifyRowsSql(c, {}));
});

test('unsupported encrypted/provider data fails before replacement instead of being omitted', async () => {
  const c = catalog();
  const calls = [];
  const client = { query: async ({ text }) => { calls.push(text); return { rows: [{ present: true }] }; } };
  await assert.rejects(() => checkSourceContent(client, c), /unsupported/);
  assert.ok(calls.every(sql => sql.startsWith('SELECT EXISTS')));
  assert.ok(!calls.some(sql => /SELECT \*|encrypted_password|TRUNCATE/.test(sql)));
});

test('password-session AMR metadata is supported without treating it as an MFA secret', async () => {
  const c = catalog();
  c.tables.push({ schema: 'auth', name: 'mfa_amr_claims' });
  const calls = [];
  const client = { query: async ({ text }) => { calls.push(text); return { rows: [{ present: false }] }; } };
  await checkSourceContent(client, c);
  assert.ok(!calls.some(sql => sql.includes('mfa_amr_claims')));
});

test('schema guard quotes metadata safely even when a default contains its DO delimiter', () => {
  const c = catalog(); c.columns[0].default_expression = "'$refresh_check$'";
  const sql = schemaGuardSql(c, 'SELECT null::jsonb AS catalog;');
  assert.ok(sql.startsWith('DO $refresh_check_1$'));
  assert.ok(sql.endsWith('END $refresh_check_1$;'));
});

test('missing/wrong PostgreSQL tools are reported before any data export', async () => {
  const tools = await checkTools(async name => name === 'psql' ? 'psql (PostgreSQL) 17.11' : 'pg_dump (PostgreSQL) 16.0');
  assert.deepEqual(tools.map(t => t.available), [false, false, true]);
});

test('private refresh paths are mode 0700 and reject traversal and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-paths-'));
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    const dir = await privateRunDirectory(id, true, root);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await assert.rejects(() => privateRunDirectory('../outside', false, root));
    await rm(dir, { recursive: true }); await symlink(root, dir);
    await assert.rejects(() => privateRunDirectory(id, false, root), /symlink/);
  } finally { await rm(root, { recursive: true }); }
});

function harness(c) {
  const commands = []; const connections = [];
  const open = async database => {
    const calls = [];
    connections.push({ environment: database.environment, calls });
    return { end: async () => {}, query: async input => {
      const text = typeof input === 'string' ? input : input.text; calls.push(text);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (text.includes("'authVersions'")) return { rows: [{ catalog: c }] };
      if (text.startsWith('SELECT EXISTS')) return { rows: [{ present: false }] };
      if (text.startsWith('SELECT count(*)')) return { rows: [row] };
      if (text.startsWith('SELECT last_value')) return { rows: [nextSequence] };
      if (text.startsWith('SELECT max(')) return { rows: [{ maximum: '9007199254740998' }] };
      if (text.includes('pg_export_snapshot')) return { rows: [{ id: '00000001-00000001-1' }] };
      return { rows: [] };
    } };
  };
  const run = async (name, args, opts) => {
    commands.push({ name, args, env: opts?.env });
    if (name === 'pg_dump') await writeFile(args[args.indexOf('--file') + 1], 'fixture archive');
    if (name === 'pg_restore' && args.includes('--list')) return toc(c);
    if (name === 'pg_restore' && args.includes('--file')) await writeFile(args[args.indexOf('--file') + 1], '-- fixture Auth/application data only\n');
    return '';
  };
  return { commands, connections, open, run, audit: async () => ({ catalogHash: 'stable-qa-schema' }), env, log: () => {} };
}

test('copy orchestration backs up QA first, uses read-only source, invalidates old evidence and protects artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-success-')); const c = catalog(); const h = harness(c);
  try {
    await writeFile(join(root, 'qa-verification.json'), 'old evidence');
    await applyCopy(settings, options, c, c, [], { ...h, root });
    const dir = join(root, (await readdir(root)).find(n => n.startsWith('refresh-')));
    const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
    assert.equal(status.status, 'copied-needs-login-and-api-verification');
    assert.ok(h.commands.find(c => c.name === 'pg_dump').args.some(v => v.endsWith('qa.dump')));
    assert.ok(h.connections.find(c => c.environment === 'production').calls.every(sql => /^(SET|BEGIN|SELECT|COMMIT|--)/.test(sql) || (/^LOCK TABLE/.test(sql) && /ACCESS SHARE MODE$/.test(sql))));
    assert.ok(h.commands.filter(c => c.name === 'pg_dump').every(c => c.env.PGOPTIONS.includes('read_only=on')));
    assert.ok(h.commands.filter(c => c.name === 'psql').every(c => c.env.PGUSER.endsWith('.' + qa)));
    for (const name of await readdir(dir)) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
    assert.ok(!(await readdir(dir)).some(n => n.endsWith('.pgpass')));
    assert.ok(!(await readdir(root)).includes('qa-verification.json'));
    const runId = basename(dir).slice('refresh-'.length);
    await loadRun(runId, qa, root);
    await rm(join(dir, 'production.dump'));
    await rm(join(dir, 'production.data.sql'));
    await recoverCopy(settings, { ...options, recover: runId }, [], { ...h, root });
    assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).status, 'recovered-needs-api-verification');
    await writeFile(join(dir, 'qa.data.sql'), 'changed');
    await assert.rejects(() => loadRun(runId, qa, root), /changed/);
  } finally { await rm(root, { recursive: true }); }
});

test('restore failure with private SQL diagnostics records recovery-needed without leaking data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-failure-')); const c = catalog(); const h = harness(c);
  try {
    const run = async (...args) => { if (args[0] === 'psql') throw new Error('COPY auth.users: private-password-hash'); return h.run(...args); };
    await assert.rejects(() => applyCopy(settings, options, c, c, [], { ...h, run, root }), error => {
      assert.match(error.message, /needs-recovery-review/); assert.ok(!error.message.includes('private-password-hash')); return true;
    });
    const dir = join(root, (await readdir(root))[0]);
    assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).status, 'needs-recovery-review');
    assert.ok((await readdir(dir)).includes('qa.dump'));
    assert.ok(!(await readdir(dir)).some(n => n.endsWith('.pgpass')));
  } finally { await rm(root, { recursive: true }); }
});

test('tool stderr containing private COPY values is never propagated', async () => {
  // Use an ordinary local child executable; no PostgreSQL server or real data.
  const before = process.env.DATABASE_PG_BIN; process.env.DATABASE_PG_BIN = '';
  try {
    await assert.rejects(() => nativeTool(process.execPath, ['-e', "process.stderr.write('COPY private-password-hash');process.exit(1)"]), error => {
      assert.ok(!error.message.includes('private-password-hash')); assert.match(error.message, /withheld/); return true;
    });
  } finally { if (before === undefined) delete process.env.DATABASE_PG_BIN; else process.env.DATABASE_PG_BIN = before; }
});

test('source export failure leaves QA and prior verification untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-source-failure-')); const c = catalog(); const h = harness(c);
  try {
    await writeFile(join(root, 'qa-verification.json'), 'previous evidence');
    const run = async (...args) => {
      if (args[0] === 'pg_dump' && args[1].some(arg => arg.endsWith('production.dump'))) throw new Error('private row content');
      return h.run(...args);
    };
    await assert.rejects(() => applyCopy(settings, options, c, c, [], { ...h, run, root }), /failed-before-replacement/);
    assert.ok(!h.commands.some(command => command.name === 'psql'));
    assert.equal(await readFile(join(root, 'qa-verification.json'), 'utf8'), 'previous evidence');
  } finally { await rm(root, { recursive: true }); }
});


test('named QA copy and recovery invalidate only the selected database evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-named-'));
  const c = catalog(), h = harness(c);
  const named = {production:{kind:'production',projectRef:production},qa2:{kind:'qa',projectRef:qa}};
  const namedOptions = {...options,database:'qa2'};
  const namedEnv = {PRODUCTION_DATABASE_URL:env.PRODUCTION_DATABASE_URL,QA2_DATABASE_URL:env.QA_DATABASE_URL};
  try {
    await writeFile(join(root,'qa1-verification.json'),'qa1 evidence');
    await writeFile(join(root,'qa2-verification.json'),'qa2 evidence');
    await applyCopy(named,namedOptions,c,c,[],{...h,env:namedEnv,root});
    assert.equal(await readFile(join(root,'qa1-verification.json'),'utf8'),'qa1 evidence');
    assert.ok(!(await readdir(root)).includes('qa2-verification.json'));
    const dir = (await readdir(root)).find(name => name.startsWith('refresh-'));
    await writeFile(join(root,'qa2-verification.json'),'stale evidence');
    await recoverCopy(named,{...namedOptions,recover:dir.slice('refresh-'.length)},[],{...h,env:namedEnv,root});
    assert.ok(!(await readdir(root)).includes('qa2-verification.json'));
    assert.equal(await readFile(join(root,'qa1-verification.json'),'utf8'),'qa1 evidence');
  } finally {await rm(root,{recursive:true});}
});
