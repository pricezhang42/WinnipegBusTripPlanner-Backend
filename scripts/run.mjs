import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selection, localSettings, value, publicSupabase, cleanEnvironment } from './connections.mjs';
const root = new URL('../', import.meta.url);
const runtimeFields = ['PORT', 'CORS_ORIGINS', 'MAPBOX_TOKEN', 'WT_API_KEY', 'GTFS_REFRESH_HOURS',
  'RELIABILITY_DATA_PATH', 'PASSUP_RISK_DATA_PATH', 'PASSUP_REPORT_DATA_PATH', 'RELIABILITY_DESTINATIONS_PATH'];
const serverFields = [...runtimeFields, 'FLY_APP', 'API_URL'];
export function backendPlan(args, settings, inherited = process.env, registry) {
  const [command, ...flags] = args;
  if (!['dev', 'start', 'deploy'].includes(command)) throw new Error('Use dev, start or deploy.');
  const { selected, rest } = selection(flags, ['server', 'database']);
  if (rest.some(flag => flag !== '--print')) throw new Error('Unknown option. Use --server, --database or --print.');
  if (command === 'deploy' && (!selected.server || !selected.database)) throw new Error('Deployment requires --server and --database.');
  // Deploy keeps requiring explicit flags. Local defaults apply only to dev/start.
  if (command !== 'deploy') {
    selected.server ??= settings.DEFAULT_SERVER;
    selected.database ??= settings.DEFAULT_DATABASE;
  }
  let env = { ...inherited }, summary = { mode: 'host-provided runtime environment' }, runtime = {};
  if (selected.server || selected.database) {
    if (!selected.server || !selected.database) throw new Error('Select both --server and --database independently.');
    if (!serverFields.some(field => settings[`${selected.server.toUpperCase()}_${field}`]?.trim())) {
      throw new Error('Unknown server profile. Configure its runtime/deployment block first.');
    }
    const auth = publicSupabase(value(settings, selected.database, 'SUPABASE_URL'), value(settings, selected.database, 'SUPABASE_PUBLISHABLE_KEY'));
    if (registry) {
      const profile = registry[selected.database];
      if (!profile || !['qa', 'production'].includes(profile.kind) || profile.projectRef !== auth.ref ||
          (profile.kind === 'production' && selected.database !== 'production') ||
          (profile.kind === 'qa' && profile.projectRef === registry.production?.projectRef)) {
        throw new Error('Database profile URL does not match its registered project/kind.');
      }
    }
    runtime = { SUPABASE_URL: auth.url, SUPABASE_PUBLISHABLE_KEY: auth.key };
    for (const field of runtimeFields) {
      const configured = value(settings, selected.server, field, false) ?? settings[field];
      if (configured !== undefined && /[\r\n\0]/.test(configured)) throw new Error(`Invalid ${field}.`);
      if (configured !== undefined && configured !== '') runtime[field] = configured;
    }
    if (runtime.PORT && (!/^\d+$/.test(runtime.PORT) || +runtime.PORT < 1 || +runtime.PORT > 65535)) throw new Error('PORT must be 1–65535.');
    env = { ...cleanEnvironment(inherited), ...runtime };
    summary = { server: selected.server, database: selected.database, supabaseUrl: auth.url, port: runtime.PORT ?? '8787' };
  }
  let flyApp;
  if (command === 'deploy') {
    flyApp = value(settings, selected.server, 'FLY_APP');
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(flyApp)) throw new Error('Invalid Fly app name.');
    // Container-side paths differ from developer checkout paths. Resolve these
    // through committed artifacts or explicitly container-relative profile values.
    summary.flyApp = flyApp;
  }
  const executable = command === 'dev' ? fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)) : process.execPath;
  return { command, executable, args: command === 'dev' ? ['watch', 'src/index.ts'] : ['dist/index.js'],
    env, runtime, flyApp, summary, print: rest.includes('--print') };
}
function child(command, args, env, input) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(command, args, { cwd: fileURLToPath(root), env, shell: false,
      stdio: input === undefined ? 'inherit' : ['pipe', 'ignore', 'ignore'] });
    if (input !== undefined) { processChild.stdin.on('error', () => {}); processChild.stdin.end(input); }
    processChild.on('error', () => reject(new Error('Could not start required command. Install dependencies/flyctl.')));
    processChild.on('exit', (code, signal) => code === 0 || signal === 'SIGINT' ? resolve() : reject(new Error('Command failed. No credential-bearing diagnostics were printed.')));
  });
}
export async function main(args = process.argv.slice(2)) {
  // One optional local file; hosting/CI variables take precedence.
  const settings = await localSettings(root);
  const registry = JSON.parse(await readFile(new URL('supabase/environments.json', root), 'utf8'));
  const plan = backendPlan(args, settings, process.env, registry);
  console.log(JSON.stringify(plan.summary));
  if (plan.print) return;
  if (plan.command === 'deploy') {
    // Staged values go through stdin, never shell interpolation, argv or Docker
    // build arguments. Do not upload the profile file or migration credentials.
    const input = Object.entries(plan.runtime).map(([key, val]) => `${key}=${JSON.stringify(val)}`).join('\n') + '\n';
    const flyEnv = { ...cleanEnvironment(process.env), ...(process.env.FLY_API_TOKEN ? { FLY_API_TOKEN: process.env.FLY_API_TOKEN } : {}) };
    await child('fly', ['secrets', 'import', '--stage', '--app', plan.flyApp], flyEnv, input);
    await child('fly', ['deploy', '--app', plan.flyApp], flyEnv);
    return;
  }
  await child(plan.executable, plan.args, plan.env);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
