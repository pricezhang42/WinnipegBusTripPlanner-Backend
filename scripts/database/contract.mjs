import { TABLES } from './core.mjs';

const columns = {
  favorite_locations: { user_id: 'uuid', location_key: 'text', location: 'jsonb', created_at: 'timestamp with time zone' },
  favorite_trips: { user_id: 'uuid', trip_key: 'text', origin: 'jsonb', destination: 'jsonb', created_at: 'timestamp with time zone' },
  trip_history: { id: 'bigint', user_id: 'uuid', trip_key: 'text', origin: 'jsonb', destination: 'jsonb', created_at: 'timestamp with time zone' },
};
const policies = {
  favorite_locations: { own_locations: 'ALL' }, favorite_trips: { own_trips: 'ALL' },
  trip_history: { own_history: 'SELECT', delete_own_history: 'DELETE' },
};
const ownRows = expression => typeof expression === 'string' &&
  expression.replace(/[()\s"]/g, '').replace(/select/gi, '').replace(/asuid/gi, '').toLowerCase() === 'user_id=auth.uid';
const normalize = sql => sql.trim().replace(/\s+/g, ' ');

export function expectedFunctionBodies(files) {
  const bodies = new Map();
  const pattern = /create(?:\s+or\s+replace)?\s+function\s+public\.([a-z_]+)\s*\([^]*?\)\s*returns[^]*?as\s+\$\$([^]*?)\$\$\s*;/gi;
  for (const file of files) for (const match of file.sql.matchAll(pattern)) bodies.set(match[1], match[2]);
  return bodies;
}

/** A focused application contract, not a complete PostgreSQL schema diff engine. */
export function findings(audit, files) {
  const issues = [];
  const add = message => issues.push(message);
  const c = audit.catalog;
  for (const tableName of TABLES) {
    const table = c.tables.find(t => t.name === tableName);
    if (!table) { add(`Missing application table: ${tableName}`); continue; }
    if (!table.rls) add(`RLS disabled: ${tableName}`);
    for (const [name, type] of Object.entries(columns[tableName])) {
      const column = c.columns.find(col => col.table_name === tableName && col.name === name);
      if (!column || column.type !== type || !column.not_null) add(`Missing/incompatible required column: ${tableName}.${name}`);
    }
    if (!c.constraints.some(constraint => constraint.table_name === tableName && constraint.type === 'f' &&
        /FOREIGN KEY \(user_id\) REFERENCES auth\.users\(id\) ON DELETE CASCADE/i.test(constraint.definition))) {
      add(`Missing expected Auth-user foreign key: ${tableName}`);
    }
    for (const [name, command] of Object.entries(policies[tableName])) {
      const policy = c.policies.find(p => p.table_name === tableName && p.name === name);
      if (!policy || policy.command !== command || policy.roles.length !== 1 || policy.roles[0] !== 'authenticated' ||
          !ownRows(policy.using_expression) || (command === 'ALL' && !ownRows(policy.check_expression))) {
        add(`Missing/incompatible ownership policy: ${tableName}.${name}`);
      }
    }
    for (const policy of c.policies.filter(p => p.table_name === tableName)) {
      if (!Object.hasOwn(policies[tableName], policy.name)) add(`Review unexpected policy: ${tableName}.${policy.name}`);
    }
    const allowed = tableName === 'trip_history' ? ['SELECT', 'DELETE'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    const grants = c.tableGrants.filter(g => g.table_name === tableName);
    for (const privilege of allowed) {
      if (!grants.some(g => g.grantee === 'authenticated' && g.privilege === privilege)) add(`Missing authenticated ${privilege}: ${tableName}`);
    }
    if (grants.some(g => ['anon', 'PUBLIC'].includes(g.grantee) ||
        (g.grantee === 'authenticated' && !allowed.includes(g.privilege)))) add(`Review excessive application grants: ${tableName}`);
  }
  const hasConstraint = (table, type, definition) => c.constraints.some(x => x.table_name === table && x.type === type && definition.test(x.definition));
  for (const [table, pattern] of [['favorite_locations', /PRIMARY KEY \(user_id, location_key\)/], ['favorite_trips', /PRIMARY KEY \(user_id, trip_key\)/], ['trip_history', /PRIMARY KEY \(id\)/]]) {
    if (!hasConstraint(table, 'p', pattern)) add(`Missing expected primary key: ${table}`);
  }
  if (!hasConstraint('trip_history', 'u', /UNIQUE \(user_id, trip_key\)/)) add('Missing distinct-trip history constraint');
  const expected = expectedFunctionBodies(files);
  for (const name of ['record_planned_trip', 'trip_point_key']) {
    const matches = c.functions.filter(f => f.name === name);
    const f = matches[0];
    if (matches.length !== 1 || !expected.has(name) || normalize(f?.body ?? '') !== normalize(expected.get(name) ?? '')) add(`Review function body/signature: ${name}`);
    if (f && !f.settings?.some(setting => setting === 'search_path=""' || setting === 'search_path=')) add(`Missing fixed empty search_path: ${name}`);
  }
  const record = c.functions.find(f => f.name === 'record_planned_trip');
  if (record && !record.security_definer) add('record_planned_trip must retain its explicitly scoped SECURITY DEFINER implementation');
  const helper = c.functions.find(f => f.name === 'trip_point_key');
  if (helper?.security_definer) add('trip_point_key must not be SECURITY DEFINER');
  for (const name of ['record_planned_trip', 'trip_point_key']) {
    const grants = c.functionGrants.filter(g => g.name === name);
    if (grants.some(g => ['PUBLIC', 'anon'].includes(g.grantee))) add(`Unexpected public/anon function access: ${name}`);
    if (name === 'record_planned_trip' && !grants.some(g => g.grantee === 'authenticated' && g.privilege === 'EXECUTE')) add('Missing authenticated history-function execution grant');
  }
  return issues;
}

export function catalogDifferences(production, qa) {
  const keys = new Set([...Object.keys(production.catalog), ...Object.keys(qa.catalog)]);
  return [...keys].filter(key => JSON.stringify(production.catalog[key]) !== JSON.stringify(qa.catalog[key]));
}
