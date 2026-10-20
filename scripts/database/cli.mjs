import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, PRIVATE_DIR, loadSettings, loadJson, projectRef, target, requireQa, confirmTarget,
  migrationFiles, fileManifest, checkManifest, connect, readAudit, migrationStatus, assertMigrationHistory,
  privateJson, supabase, redact, reportPath,
} from './core.mjs';
import { findings, catalogDifferences } from './contract.mjs';

export function parseArguments(args) {
  const [command, ...rest] = args;
  let environment;
  if (rest[0] && !rest[0].startsWith('--')) environment = rest.shift();
  const options = {};
  const values = { '--database': 'database', '--qa-database': 'qaDatabase', '--api': 'api',
    '--confirm-ref': 'confirmRef', '--project-ref': 'projectRef', '--evidence': 'evidence', '--accounts': 'accounts' };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i], key = values[flag] ?? (flag === '--apply' ? 'apply' : null);
    if (!key || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (flag === '--apply') options[key] = true;
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) options[key] = rest[++i];
    else throw new Error(`Incomplete option: ${flag}`);
  }
  if (environment && options.database) throw new Error('Select the database only once.');
  environment ??= options.database;
  delete options.database;
  return { command, environment, options };
}
async function auditTarget(settings, environment, files) {
  const database = target(settings, environment);
  const client = await connect(database);
  try { return { database, report: await readAudit(client, database, files) }; }
  finally { await client.end(); }
}
export function verifyQaEvidence(evidence, settings, files, now = Date.now(), environment = 'qa') {
  requireQa(settings, environment);
  const age = now - Date.parse(evidence.generatedAt);
  if (evidence.status !== 'passed' || evidence.projectRef !== projectRef(settings, environment) ||
      evidence.projectRef === settings.production.projectRef || !Number.isFinite(age) || age < 0 || age > 86400000 ||
      JSON.stringify(evidence.migrations) !== JSON.stringify(fileManifest(files))) {
    throw new Error('Production migration requires a passing QA test report from the last 24 hours for exactly these migration files and registered QA project.');
  }
}
export async function main(args = process.argv.slice(2)) {
  const { command, environment, options } = parseArguments(args);
  const settings = await loadSettings();
  if (command === 'register') {
    if (!/^qa[a-z0-9_]*$/.test(environment ?? '') || !/^[a-z0-9]{20}$/.test(options.projectRef ?? '') || Object.entries(settings).some(([name, value]) => name !== environment && value.projectRef === options.projectRef)) {
      throw new Error('Register a distinct QA reference: npm run db -- register --database qa2 --project-ref <20-character-ref>.');
    }
    settings[environment] = { kind: 'qa', projectRef: options.projectRef };
    await writeFile(join(ROOT, 'supabase/environments.json'), `${JSON.stringify(settings, null, 2)}\n`);
    console.log(`Registered QA ${options.projectRef}. No hosted settings changed.`);
    return;
  }
  const files = await migrationFiles();
  if (command === 'manifest' || command === 'check') {
    await checkManifest(files, command === 'manifest');
    console.log(`${files.length} migration files verified${command === 'manifest' ? ' and registered' : ''}.`);
    return;
  }
  await checkManifest(files);
  if (command === 'auth-audit') {
    const { authConfig } = await import('./qa.mjs');
    console.log(JSON.stringify(await authConfig(settings, environment), null, 2));
    return;
  }
  if (['seed', 'test', 'cleanup', 'auth'].includes(command)) {
    requireQa(settings, environment);
    const { qaCommand } = await import('./qa.mjs');
    return qaCommand(command, settings, options, files, environment);
  }
  if (command === 'compare') {
    const prod = await auditTarget(settings, 'production', files);
    requireQa(settings, options.qaDatabase);
    const qa = await auditTarget(settings, options.qaDatabase, files);
    const differences = catalogDifferences(prod.report, qa.report);
    console.log(JSON.stringify({ production: prod.report.projectRef, qa: qa.report.projectRef, differentCatalogSections: differences }, null, 2));
    return;
  }
  if (!['status', 'audit', 'migrate', 'rebuild'].includes(command)) throw new Error('Use status, audit, compare, migrate, rebuild, seed, test, cleanup, auth, register, manifest, or check.');
  if (command === 'rebuild') requireQa(settings, environment);
  const { database, report } = await auditTarget(settings, environment, files);
  const status = migrationStatus(report, files);
  const summary = { environment, projectRef: database.projectRef, postgresVersion: report.postgresVersion,
    historyTableExists: report.historyTableExists, applied: report.remoteMigrations, ...status, findings: findings(report, files) };
  if (command === 'audit') {
    const path = await privateJson(`${environment}-audit-${Date.now()}.json`, { ...report, findings: summary.findings });
    console.log(JSON.stringify({ ...summary, report: reportPath(path) }, null, 2));
    return;
  }
  if (command === 'status') { console.log(JSON.stringify(summary, null, 2)); return; }
  if (command === 'rebuild') {
    if (!options.apply) { console.log(`QA-only rebuild target ${database.projectRef}: Supabase CLI will reset the hosted QA database and replay migrations without seed data. Pass --apply --confirm-ref ${database.projectRef} to execute.`); return; }
    confirmTarget(database.projectRef, options);
    await supabase(['db', 'reset', '--no-seed'], database);
    console.log('QA reset and migration replay completed. Recreate QA fixtures with npm run db -- seed --database <qa-profile>.');
    return;
  }
  if (!options.apply) {
    console.log(JSON.stringify({ ...summary, pendingFiles: files.filter(f => status.pending.includes(f.version)).map(({ name, sha256 }) => ({ name, sha256 })) }, null, 2));
    return;
  }
  confirmTarget(database.projectRef, options);
  assertMigrationHistory(report, files);
  if (!status.pending.length) { console.log('No pending migrations; nothing changed.'); return; }
  if (environment === 'production') {
    requireQa(settings, options.qaDatabase);
    const evidence = await loadJson(options.evidence ?? join(PRIVATE_DIR, `${options.qaDatabase}-verification.json`));
    verifyQaEvidence(evidence, settings, files, Date.now(), options.qaDatabase);
    const qa = await auditTarget(settings, options.qaDatabase, files);
    const qaStatus = migrationStatus(qa.report, files);
    if (qa.report.catalogHash !== evidence.catalogHash || findings(qa.report, files).length ||
        qaStatus.pending.length || qaStatus.remoteOnly.length ||
        Number.parseInt(qa.report.postgresVersion) !== Number.parseInt(report.postgresVersion)) {
      throw new Error('QA changed after verification or its PostgreSQL major version differs. Audit both environments and rerun QA tests.');
    }
  }
  // Supabase CLI alone applies migrations and records its own history. No --include-all,
  // --include-seed, role sync or automatic baseline repair is performed by this wrapper.
  const output = await supabase(['db', 'push', '--skip-vault'], database);
  console.log(output);
  console.log(`Migration deployment completed for ${environment} ${database.projectRef}. Run npm run db -- audit --database ${environment} and review the result.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}
