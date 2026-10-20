import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, TABLES, projectRef, requireQa, target } from './core.mjs';

export class RefreshError extends Error {}
export const fail = message => { throw new RefreshError(message); };
export const identifier = value => '"' + value.replaceAll('"', '""') + '"';
export const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
export const tableKey = table => `${table.schema}.${table.table_name ?? table.name}`;
export const qualified = table => `${identifier(table.schema)}.${identifier(table.table_name ?? table.name)}`;
export const selectedTable = table => (table.schema === 'auth' && (table.table_name ?? table.name) !== 'schema_migrations') ||
  (table.schema === 'public' && TABLES.includes(table.table_name ?? table.name));
export const selectedTables = catalog => catalog.tables.filter(selectedTable);
export const digest = value => createHash('sha256').update(value).digest('hex');

export function parseRefreshArguments(args) {
  const options = {};
  const switches = { '--apply': 'apply', '--replace-qa-data': 'replaceQaData', '--qa-quiesced': 'qaQuiesced', '--copy-auth-state': 'copyAuthState' };
  const values = { '--database': 'database', '--confirm-source': 'confirmSource', '--confirm-ref': 'confirmRef', '--recover': 'recover', '--cleanup': 'cleanup' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; const key = switches[flag] ?? values[flag];
    if (!key || Object.hasOwn(options, key)) fail('Unknown or duplicate refresh option. See docs/exact-production-to-qa-copy.md.');
    if (switches[flag]) options[key] = true;
    else if (args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else fail('A refresh option is missing its value.');
  }
  if (options.cleanup && options.recover) fail('Choose cleanup or recovery, not both.');
  for (const id of [options.cleanup, options.recover].filter(Boolean)) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) fail('Invalid refresh run ID.');
  }
  return options;
}

export function refreshTargets(settings, options, env = process.env) {
  const environment = options.database ?? 'qa';
  const qaRef = requireQa(settings, environment);
  const productionRef = projectRef(settings, 'production');
  if (qaRef === productionRef) fail('Source and destination must differ.');
  if (options.apply) {
    if (options.confirmRef !== qaRef) fail('Confirm the registered QA destination with --confirm-ref.');
    if (!options.cleanup && (!options.replaceQaData || !options.qaQuiesced || !options.copyAuthState)) {
      fail('Applying requires --replace-qa-data --qa-quiesced --copy-auth-state.');
    }
    if (!options.cleanup && !options.recover && options.confirmSource !== productionRef) fail('Confirm the production source with --confirm-source.');
  }
  return { qa: target(settings, environment, env), production: options.cleanup || options.recover ? null : target(settings, 'production', env) };
}

// Only structural metadata is used for this fingerprint: no row counts or hashes.
export function schemaShape(catalog) {
  return {
    postgresMajor: catalog.postgresMajor, authVersions: catalog.authVersions, extensions: catalog.extensions,
    tables: selectedTables(catalog).map(({ schema, name, kind, partition }) => ({ schema, name, kind, partition })),
    columns: catalog.columns.filter(selectedTable), constraints: catalog.constraints.filter(selectedTable),
    foreignKeys: catalog.foreignKeys, triggers: catalog.triggers,
    sequences: catalog.sequences.map(({ can_read, can_update, ...sequence }) => sequence),
  };
}
export const shapeHash = catalog => digest(JSON.stringify(schemaShape(catalog)));

export function compatibility(source, qa) {
  const problems = [];
  if (source.postgresMajor !== qa.postgresMajor || source.postgresMajor !== 17) problems.push('This runner requires PostgreSQL 17 on both projects and PostgreSQL 17 client tools.');
  if (!source.authVersions.length || JSON.stringify(source.authVersions) !== JSON.stringify(qa.authVersions)) problems.push('Managed Auth migration versions differ or are missing.');
  if (JSON.stringify(source.extensions) !== JSON.stringify(qa.extensions)) problems.push('Extension definitions/versions differ; review compatibility before copying.');
  for (const [label, catalog] of [['production', source], ['QA', qa]]) {
    for (const table of catalog.tables) {
      if (table.schema === 'public' && !TABLES.includes(table.name)) problems.push(`${label} has additional public tables; review the copy boundary.`);
      if (selectedTable(table) && (table.kind !== 'r' || table.partition)) problems.push(`${label} has unsupported partitioned/materialized/foreign tables.`);
      if (selectedTable(table) && !table.can_read) problems.push(`${label} cannot read all selected tables.`);
    }
    if (!catalog.tables.some(t => t.schema === 'auth' && t.name === 'users') || !catalog.tables.some(t => t.schema === 'auth' && t.name === 'identities') ||
        TABLES.some(name => !catalog.tables.some(t => t.schema === 'public' && t.name === name))) problems.push(`${label} lacks required Auth/application tables.`);
    if (catalog.triggers.some(selectedTable)) problems.push(`${label} has custom table triggers; external effects need review.`);
    if (catalog.constraints.some(c => selectedTable(c) && !c.validated)) problems.push(`${label} has unvalidated constraints.`);
    const tables = new Set(selectedTables(catalog).map(tableKey));
    for (const fk of catalog.foreignKeys) {
      const child = tables.has(`${fk.schema}.${fk.table_name}`), parent = tables.has(`${fk.parent_schema}.${fk.parent_table}`);
      if (child !== parent) problems.push(`${label} has foreign keys crossing the copy boundary.`);
      if (child && fk.match !== 's') problems.push(`${label} has unsupported non-SIMPLE foreign keys.`);
    }
    for (const sequence of catalog.sequences) {
      if (!tables.has(`${sequence.table_schema}.${sequence.table_name}`) || !sequence.column_name ||
          sequence.cache !== '1' || sequence.cycle || BigInt(sequence.increment) <= 0n) problems.push(`${label} has unsupported sequence ownership/cache/cycle/increment.`);
      if (!sequence.can_read) problems.push(`${label} cannot read sequence allocation state.`);
    }
  }
  if (shapeHash(source) !== shapeHash(qa)) problems.push('Source and QA selected table/column/constraint/sequence structures differ.');
  try { orderedTables(qa); } catch { problems.push('Selected foreign keys contain a cycle; this runner will not disable constraints to bypass it.'); }
  if (selectedTables(qa).some(t => !t.can_insert || !t.can_truncate) || qa.sequences.some(s => !s.can_update)) problems.push('QA role lacks restore table/sequence privileges.');
  return [...new Set(problems)];
}

export function pgEnvironment(database, passfile, readOnly, env = process.env) {
  const url = new URL(database.url);
  return { PATH: env.PATH ?? '', ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    PGHOST: url.hostname, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: decodeURIComponent(url.username),
    PGPASSFILE: passfile, PGSERVICEFILE: '/dev/null', PGSSLMODE: 'verify-full',
    ...(database.caFile ? { PGSSLROOTCERT: database.caFile } : {}),
    PGAPPNAME: 'bustripplanner-qa-refresh',
    PGOPTIONS: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c statement_timeout=120000 -c lock_timeout=10000`,
  };
}
export function passfileLine(database) {
  const url = new URL(database.url);
  const escape = value => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  return [url.hostname, '5432', 'postgres', decodeURIComponent(url.username), decodeURIComponent(url.password)].map(escape).join(':') + '\n';
}
export const toolPath = name => process.env.DATABASE_PG_BIN ? join(process.env.DATABASE_PG_BIN, name) : name;

export function dumpArguments(path, catalog, snapshot) {
  return ['--format=custom', '--data-only', '--no-owner', '--no-privileges', '--no-comments', '--strict-names',
    '--file', path, '--snapshot', snapshot,
    ...[...selectedTables(catalog), ...catalog.sequences.map(({ schema, name }) => ({ schema, name }))].flatMap(table => ['--table', qualified(table)])];
}

// pg_restore's TOC is metadata; sequence SET entries are replaced with verified
// state at the end of the restore, after table/FK checks have succeeded.
export function restoreList(listing, catalog) {
  const allowed = new Set(selectedTables(catalog).map(tableKey)); const entries = new Map(); const comments = [];
  for (const line of listing.split('\n')) {
    if (!line.trim() || line.startsWith(';')) { comments.push(line); continue; }
    const table = /^\d+; \d+ \d+ TABLE DATA ([a-z_][a-z_0-9]*) ([a-z_][a-z_0-9]*) \S+$/.exec(line);
    if (table && allowed.has(`${table[1]}.${table[2]}`) && !entries.has(`${table[1]}.${table[2]}`)) {
      entries.set(`${table[1]}.${table[2]}`, line); continue;
    }
    if (/^\d+; \d+ \d+ SEQUENCE SET /.test(line)) { comments.push('; ' + line); continue; }
    fail('Backup contains an unexpected archive entry; restore refused.');
  }
  if (entries.size !== allowed.size) fail('Backup archive does not contain every selected table.');
  return [...comments, ...orderedTables(catalog).map(table => entries.get(tableKey(table)))].join('\n');
}

export function orderedTables(catalog) {
  const pending = new Map(selectedTables(catalog).map(table => [tableKey(table), table]));
  const dependencies = new Map([...pending.keys()].map(key => [key, new Set()]));
  for (const fk of catalog.foreignKeys) {
    const child = `${fk.schema}.${fk.table_name}`, parent = `${fk.parent_schema}.${fk.parent_table}`;
    if (pending.has(child) && pending.has(parent)) dependencies.get(child).add(parent);
  }
  const result = [];
  while (pending.size) {
    const ready = [...pending.keys()].filter(key => ![...dependencies.get(key)].some(parent => pending.has(parent)));
    if (!ready.length) fail('Foreign key cycle cannot be restored with constraints enabled.');
    for (const key of ready) { result.push(pending.get(key)); pending.delete(key); }
  }
  return result;
}

export function fingerprintQuery(table) {
  // Hash canonical server-side JSON, never JS numbers/dates or concatenated raw data.
  return `SELECT count(*)::text AS count, encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS digest
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM ${qualified(table)} t) fingerprint_rows`;
}

function assertion(condition, message) {
  let tag = '$refresh_check$'; let suffix = 0;
  while (condition.includes(tag) || message.includes(tag)) tag = `$refresh_check_${++suffix}$`;
  return `DO ${tag} BEGIN IF NOT (${condition}) THEN RAISE EXCEPTION ${literal(message)}; END IF; END ${tag};`;
}
export function verifyRowsSql(catalog, fingerprints) {
  return selectedTables(catalog).map(table => {
    const expected = fingerprints[tableKey(table)];
    if (!expected || !/^\d+$/.test(expected.count) || !/^[a-f0-9]{64}$/.test(expected.digest)) fail('Invalid private verification metadata.');
    return assertion(`(SELECT count=${literal(expected.count)} AND digest=${literal(expected.digest)} FROM (${fingerprintQuery(table)}) verification)`, 'Refresh row verification failed');
  }).join('\n');
}
export function verifyForeignKeysSql(catalog) {
  const tables = new Set(selectedTables(catalog).map(tableKey));
  return catalog.foreignKeys.filter(fk => tables.has(`${fk.schema}.${fk.table_name}`)).map(fk => {
    const child = qualified({ schema: fk.schema, name: fk.table_name });
    const parent = qualified({ schema: fk.parent_schema, name: fk.parent_table });
    const present = fk.columns.map(name => `c.${identifier(name)} IS NOT NULL`).join(' AND ');
    const equal = fk.columns.map((name, i) => `p.${identifier(fk.parent_columns[i])}=c.${identifier(name)}`).join(' AND ');
    return assertion(`NOT EXISTS (SELECT 1 FROM ${child} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE ${equal}))`, 'Refresh foreign key verification failed');
  }).join('\n');
}
export function sequenceSql(catalog, states) {
  return catalog.sequences.map(sequence => {
    const sequenceName = { schema: sequence.schema, name: sequence.name };
    const state = states[tableKey(sequenceName)];
    if (!state || !/^-?\d+$/.test(state.last_value) || typeof state.is_called !== 'boolean') fail('Invalid private sequence metadata.');
    return `SELECT pg_catalog.setval(${literal(qualified(sequenceName))}::regclass,${literal(state.last_value)}::bigint,${state.is_called});`;
  }).join('\n');
}
export function restorePrefix(catalog, previous, metadataGuard = '') {
  return `SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
SET LOCAL idle_in_transaction_session_timeout='120s';
SET LOCAL TIME ZONE 'UTC';
LOCK TABLE ${selectedTables(catalog).map(qualified).join(',')} IN ACCESS EXCLUSIVE MODE;
${metadataGuard}
${previous ? verifyRowsSql(catalog, previous.rows) + '\n' + verifySequencesSql(catalog, previous.sequences) : ''}
TRUNCATE TABLE ${selectedTables(catalog).map(qualified).join(',')} RESTRICT;
`;
}
export function schemaGuardSql(catalog, sql) {
  const expected = { ...catalog, tables: catalog.tables.map(({ bytes, ...table }) => table) };
  const normalized = `jsonb_set(fresh.catalog,'{tables}',coalesce((SELECT jsonb_agg(item.value-'bytes' ORDER BY item.ord) FROM jsonb_array_elements(fresh.catalog->'tables') WITH ORDINALITY item(value,ord)),'[]'::jsonb))`;
  return assertion(`(SELECT ${normalized} FROM (${sql.trim().replace(/;$/, '')}) fresh)=${literal(JSON.stringify(expected))}::jsonb`, 'Refresh schema changed after backup');
}
export function verifySequencesSql(catalog, states) {
  return catalog.sequences.map(({ schema, name }) => {
    const sequence = { schema, name }; const state = states[tableKey(sequence)];
    if (!state || !/^-?\d+$/.test(state.last_value) || typeof state.is_called !== 'boolean') fail('Invalid private sequence metadata.');
    return assertion(`(SELECT last_value=${literal(state.last_value)}::bigint AND is_called=${state.is_called} FROM ${qualified(sequence)})`, 'Refresh sequence verification failed');
  }).join('\n');
}
export const catalogSqlPath = join(ROOT, 'supabase/refresh-catalog.sql');
