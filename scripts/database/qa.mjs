import { cleanEnvironment } from '../connections.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  ROOT, PRIVATE_DIR, requireQa, projectRef, confirmTarget, loadJson, privateJson,
  target, connect, readAudit, fileManifest, migrationStatus, run, reportPath,
} from './core.mjs';
import { findings } from './contract.mjs';

const AUTH_FIELDS = ['site_url', 'uri_allow_list', 'external_email_enabled', 'mailer_autoconfirm', 'password_min_length', 'disable_signup',
  'mailer_otp_length', 'mailer_subjects_confirmation', 'mailer_templates_confirmation_content', 'mailer_subjects_recovery',
  'mailer_templates_recovery_content'];
const selectAuthFields = value => Object.fromEntries(AUTH_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
export async function authConfig(settings, environment, apply = false) {
  const ref = projectRef(settings, environment);
  if (apply) requireQa(settings, environment);
  const desired = settings[environment]?.kind === 'qa' || environment === 'qa' ? await loadJson(join(ROOT, 'supabase/qa-auth.json')) : null;
  if (desired && Object.keys(desired).some(key => !AUTH_FIELDS.includes(key))) throw new Error('QA Auth configuration contains unsupported fields.');
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error('Set SUPABASE_ACCESS_TOKEN to inspect hosted Auth configuration; database credentials cannot read Auth service settings.');
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    method: apply ? 'PATCH' : 'GET',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    ...(apply ? { body: JSON.stringify(desired) } : {}), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Supabase Auth configuration request failed (${response.status}); check token permissions.`);
  return { projectRef: ref, current: selectAuthFields(await response.json()), desired };
}

export function qaApiSettings(settings, env = process.env, needsAdmin = true, environment = 'qa') {
  const ref = requireQa(settings, environment);
  const adminKey = env[`${environment.toUpperCase()}_SUPABASE_ADMIN_KEY`];
  const publishableKey = env[`${environment.toUpperCase()}_SUPABASE_PUBLISHABLE_KEY`];
  if ((needsAdmin && !adminKey) || !publishableKey) throw new Error(`Set ${environment.toUpperCase()}_SUPABASE_ADMIN_KEY and ${environment.toUpperCase()}_SUPABASE_PUBLISHABLE_KEY in .env.local.`);
  if (needsAdmin && !adminKey.startsWith('sb_secret_')) {
    let claims;
    try { claims = JSON.parse(Buffer.from(adminKey.split('.')[1], 'base64url').toString()); } catch {}
    if (claims?.role !== 'service_role' || (claims.ref && claims.ref !== ref)) throw new Error('QA admin key must be a QA secret/service-role key.');
  }
  if (publishableKey.startsWith('sb_secret_')) throw new Error('QA public key must not be an admin key.');
  if (!publishableKey.startsWith('sb_publishable_')) {
    let claims;
    try { claims = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString()); } catch {}
    if (claims?.role !== 'anon' || (claims.ref && claims.ref !== ref)) throw new Error('QA public key must be a QA publishable/anon key.');
  }
  return { projectRef: ref, url: `https://${ref}.supabase.co`, adminKey, publishableKey };
}
export function runtimeEnvironment(env = process.env) {
  return cleanEnvironment(env);
}
function apiClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { retry: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?
      AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) },
  });
}
function checked(result, label) {
  if (result.error) throw new Error(`QA ${label} failed. Check QA configuration and migrations.`);
  return result.data;
}
export async function createAccounts(admin, userClient, runId, accounts) {
  for (const suffix of ['a', 'b']) {
    const email = `db-qa-${runId}-${suffix}@example.invalid`;
    const password = randomBytes(32).toString('base64url');
    const { user } = checked(await admin.auth.admin.createUser({ email, password, email_confirm: true,
      app_metadata: { database_qa_fixture: true, database_qa_run: runId } }), 'account provisioning');
    if (!user) throw new Error('QA account provisioning returned no user.');
    const account = { id: user.id, email, password };
    accounts.push(account); // Keep cleanup ownership even when sign-in fails.
    const { session } = checked(await userClient().auth.signInWithPassword({ email, password }), 'account sign-in');
    if (!session || session.user.id !== user.id) throw new Error('QA account session identity mismatch.');
    account.accessToken = session.access_token;
  }
}
export async function removeAccounts(admin, runId, accounts) {
  const failures = [];
  for (const account of accounts) {
    try {
      const result = await admin.auth.admin.getUserById(account.id);
      if (result.error?.status === 404) continue;
      const { user } = checked(result, 'cleanup lookup');
      if (!user || user.app_metadata?.database_qa_fixture !== true || user.app_metadata?.database_qa_run !== runId) {
        throw new Error('Account is not owned by this QA fixture run.');
      }
      checked(await admin.auth.admin.deleteUser(account.id), 'account cleanup');
    } catch { failures.push(account.id); }
  }
  if (failures.length) throw new Error(`Could not clean up ${failures.length} QA fixture accounts. Retry cleanup using this run's private account manifest.`);
}
function manifest(api, runId, accounts) {
  return { schemaVersion: 1, projectRef: api.projectRef, runId, accounts };
}
export function validateAccountsManifest(value, ref) {
  if (value?.schemaVersion !== 1 || value.projectRef !== ref || !/^[a-f0-9-]{36}$/.test(value.runId ?? '') ||
      !Array.isArray(value.accounts) || value.accounts.length > 2 || value.accounts.some(a => !/^[a-f0-9-]{36}$/.test(a.id ?? ''))) {
    throw new Error('Invalid QA account manifest or wrong project.');
  }
}
async function cleanupOrPreserve(admin, api, runId, accounts) {
  try { await removeAccounts(admin, runId, accounts); }
  catch (error) {
    const path = await privateJson(`qa-cleanup-${runId}-${Date.now()}.json`, manifest(api, runId, accounts.map(({ id }) => ({ id }))));
    throw new Error(`${error.message} Manifest: ${reportPath(path)}`);
  }
}
async function readQaAudit(settings, files, environment) {
  const database = target(settings, environment);
  const client = await connect(database);
  try { return await readAudit(client, database, files); }
  finally { await client.end(); }
}
async function seedSamples(api, accounts) {
  const place = (suffix, coordinates) => ({ id: `qa-${suffix}`, place_name: `QA ${suffix}`, geometry: { coordinates } });
  const origin = place('origin', [-97.144433, 49.816532]);
  const destination = place('destination', [-97.213726, 49.845319]);
  for (const account of accounts) {
    const client = createClient(api.url, api.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { retry: false },
      global: { headers: { Authorization: `Bearer ${account.accessToken}` },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) },
    });
    checked(await client.from('favorite_locations').upsert({ user_id: account.id,
      location_key: origin.geometry.coordinates.join(','), location: origin }, { onConflict: 'user_id,location_key' }), 'favorite location seed');
    checked(await client.from('favorite_trips').upsert({ user_id: account.id,
      trip_key: `${origin.geometry.coordinates.join(',')}>${destination.geometry.coordinates.join(',')}`, origin, destination },
    { onConflict: 'user_id,trip_key' }), 'favorite trip seed');
    checked(await client.rpc('record_planned_trip', { p_origin: origin, p_destination: destination }), 'history seed');
  }
}
export function qaBackendUrl(profile, env = process.env) {
  const apiProfile = profile;
  if (!/^[a-z][a-z0-9_]*$/.test(apiProfile ?? '')) throw new Error('Select the backend to test with --api <profile>.');
  const backendUrl = env[`${apiProfile.toUpperCase()}_API_URL`];
  let url;
  try { url = new URL(backendUrl); } catch { throw new Error('Set <API_PROFILE>_API_URL to the backend configured for this QA project.'); }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use HTTPS for the QA backend, or HTTP localhost for development.');
  }
  return url;
}
export async function qaCommand(command, settings, options, files, environment) {
  const ref = requireQa(settings, environment);
  if (command === 'auth') {
    if (options.apply) confirmTarget(ref, options);
    console.log(JSON.stringify(await authConfig(settings, environment, !!options.apply), null, 2));
    return;
  }
  if (['seed', 'cleanup'].includes(command) && !options.apply) {
    console.log(`QA ${command} target ${ref}. Pass --apply --confirm-ref ${ref} to execute${command === 'cleanup' ? ' and --accounts .database/<manifest>.json' : ''}.`);
    return;
  }
  if (['seed', 'cleanup'].includes(command)) confirmTarget(ref, options);
  const testUrl = command === 'test' ? qaBackendUrl(options.api) : null;
  const api = qaApiSettings(settings, process.env, true, environment);
  const admin = apiClient(api.url, api.adminKey);
  if (command === 'cleanup') {
    const path = resolve(ROOT, options.accounts ?? '');
    if (!options.accounts || !relative(PRIVATE_DIR, path) || relative(PRIVATE_DIR, path).startsWith('..')) throw new Error('Select a private .database account manifest with --accounts.');
    const data = await loadJson(path); validateAccountsManifest(data, ref);
    await removeAccounts(admin, data.runId, data.accounts);
    await unlink(path);
    console.log('This run’s QA fixture accounts and their saved data were removed.');
    return;
  }
  const audit = await readQaAudit(settings, files, environment);
  if (findings(audit, files).length || migrationStatus(audit, files).pending.length || migrationStatus(audit, files).remoteOnly.length) {
    throw new Error('QA schema/permissions or migration history need attention. Run db -- audit --database <profile> before seeding/testing.');
  }
  const runId = randomUUID(); const accounts = [];
  let keep = false;
  try {
    await createAccounts(admin, () => apiClient(api.url, api.publishableKey), runId, accounts);
    if (command === 'seed') {
      await seedSamples(api, accounts);
      const path = await privateJson(`qa-accounts-${runId}.json`, manifest(api, runId, accounts.map(({ accessToken, ...rest }) => rest)));
      keep = true;
      console.log(`Created two QA sample accounts. Credentials are in ${reportPath(path)} (private, ignored by Git).`);
      return;
    }
    if (command !== 'test') throw new Error('Unknown QA operation.');
    const backendDir = ROOT;
    const url = testUrl;
    // The existing backend test performs authenticated reads before any writes. QA
    // tokens must be accepted by that backend; production Auth rejects QA tokens.
    const output = await run(process.execPath, [join(backendDir, 'scripts/check-saved-items.mjs')], {
      cwd: backendDir, env: { ...runtimeEnvironment(), SUPABASE_URL: api.url, SUPABASE_PUBLISHABLE_KEY: api.publishableKey,
        SAVED_ITEMS_TEST_BACKEND_URL: url.toString(), SAVED_ITEMS_TEST_DISPOSABLE: '1',
        SAVED_ITEMS_TEST_TOKEN_A: accounts[0].accessToken, SAVED_ITEMS_TEST_TOKEN_B: accounts[1].accessToken },
    });
    console.log(output);
    // Verify the schema did not change during testing and that cleanup succeeded
    // before publishing passing evidence for production promotion.
    const finalAudit = await readQaAudit(settings, files, environment);
    if (finalAudit.catalogHash !== audit.catalogHash || findings(finalAudit, files).length) throw new Error('QA schema changed during verification. Rerun after migration activity finishes.');
    await cleanupOrPreserve(admin, api, runId, accounts);
    accounts.length = 0;
    const evidence = { status: 'passed', projectRef: ref, generatedAt: new Date().toISOString(),
      database: environment, migrations: fileManifest(files), catalogHash: finalAudit.catalogHash, backendUrl: url.origin };
    const path = await privateJson(`qa-verification-${runId}.json`, evidence);
    // Atomic latest pointer; contains no account credentials.
    const latest = join(PRIVATE_DIR, `${environment}-verification.json`);
    const temp = join(PRIVATE_DIR, `qa-verification-${runId}.tmp`);
    await writeFile(temp, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, latest);
    console.log(`QA verification passed; report: ${reportPath(path)}.`);
  } finally {
    if (!keep && accounts.length) await cleanupOrPreserve(admin, api, runId, accounts);
  }
}
