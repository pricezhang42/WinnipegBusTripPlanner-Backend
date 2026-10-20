import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export const validName = name => /^[a-z][a-z0-9_]*$/.test(name ?? '');
export function selection(args, names) {
  const selected = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !names.includes(name)) { rest.push(args[i]); continue; }
    const value = args[++i];
    if (!validName(value) || Object.hasOwn(selected, name)) throw new Error(`Use --${name} once with a profile name.`);
    selected[name] = value;
  }
  return { selected, rest };
}
export async function localSettings(root, env = process.env) {
  let file = {};
  try { file = parseEnv(await readFile(new URL('.env.connections.local', root), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .env.connections.local.'); }
  return { ...file, ...env };
}
export function value(settings, profile, field, required = true) {
  if (!validName(profile)) throw new Error('Select a connection profile explicitly.');
  const key = `${profile.toUpperCase()}_${field}`;
  const result = settings[key]?.trim();
  if (required && !result) throw new Error(`Set ${key} in .env.connections.local or the process environment.`);
  if (result && /[\r\n\0]/.test(result)) throw new Error(`Invalid ${key}.`);
  return result;
}
export function connectionUrl(text, label = 'connection') {
  let url;
  try { url = new URL(text); } catch { throw new Error(`Invalid ${label} URL.`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Use an HTTP(S) ${label} URL without credentials, query or fragment.`);
  }
  return url.toString().replace(/\/+$/, '');
}
export function publicSupabase(url, key) {
  const base = connectionUrl(url, 'Supabase');
  const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(base)?.[1];
  if (!ref) throw new Error('Use the hosted Supabase project URL.');
  if (key?.startsWith('sb_publishable_') && /^sb_publishable_[\w-]+$/.test(key)) return { url: base, key, ref };
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    if (key.split('.').length === 3 && claims.role === 'anon' && (!claims.ref || claims.ref === ref)) return { url: base, key, ref };
  } catch {}
  throw new Error('Use a publishable or matching legacy anon key; admin keys are never runtime settings.');
}
// Child processes receive connection values only after selection. Unselected
// profile blocks, database/admin credentials and inherited public URLs stay out.
const managedFields = [
  'DATABASE_URL', 'DATABASE_CA_FILE', 'DATABASE_PASSWORD', 'API_URL', 'BACKEND_URL',
  'FLY_APP', 'PORT', 'CORS_ORIGINS', 'MAPBOX_TOKEN', 'WT_API_KEY', 'GTFS_REFRESH_HOURS',
  'RELIABILITY_DATA_PATH', 'RELIABILITY_DESTINATIONS_PATH', 'PASSUP_RISK_DATA_PATH', 'PASSUP_REPORT_DATA_PATH',
];
export function cleanEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => {
    if (name.startsWith('EXPO_PUBLIC_') || name.includes('SUPABASE') ||
        name.startsWith('SAVED_ITEMS_TEST_TOKEN') || /(?:PASSWORD|TOKEN|SECRET|KEY)$/.test(name)) return false;
    return !managedFields.some(field => name === field || name.endsWith('_' + field));
  }));
}
