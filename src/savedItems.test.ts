import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { createSavedItemsRoute } from './routes/savedItems.js';
import { parsePayload, locationKey, tripKey } from './savedItems.js';

const location = { id: 'home', place_name: 'Home', geometry: { coordinates: [-97.123456, 49.123456] as [number, number] } };
const destination = { ...location, id: 'work', geometry: { coordinates: [-97.2, 49.2] as [number, number] } };
const trip = { origin: location, destination };
type Call = { token: string; method: string; url: URL; body: any };

function harness(options: { authStatus?: number; databaseStatus?: number; throwAuth?: boolean } = {}) {
  const calls: Call[] = [];
  const favorites: Record<string, typeof location[]> = {};
  const clients: object[] = [];
  const app = new Hono();
  app.route('/api/me', createSavedItemsRoute(token => {
    const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { retry: false },
      global: { headers: { Authorization: `Bearer ${token}` }, fetch: async (input, init) => {
        const url = new URL(String(input));
        const actualToken = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ token: actualToken, method: init?.method ?? 'GET', url, body });
        const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname === '/auth/v1/user') {
          if (options.throwAuth) throw new Error('private upstream details');
          if (options.authStatus) return respond({ message: 'private auth details' }, options.authStatus);
          return respond({ id: actualToken === 'token-a' ? 'user-a' : 'user-b', aud: 'authenticated', role: 'authenticated' });
        }
        if (options.databaseStatus) return respond({ code: 'XX000', message: 'private database details' }, options.databaseStatus);
        const uid = actualToken === 'token-a' ? 'user-a' : 'user-b';
        if (url.pathname.endsWith('/favorite_locations')) {
          if (init?.method === 'POST') favorites[uid] = [body.location];
          return respond(init?.method === 'GET' || !init?.method ? (favorites[uid] ?? []).map(location => ({ location })) : null);
        }
        return respond(url.pathname.includes('/rpc/') ? null : []);
      } },
    });
    clients.push(client);
    return client;
  }));
  const request = (path: string, method = 'GET', body?: unknown, token: string | null = 'token-a') => app.request(`/api/me${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, calls, clients };
}

test('rejects unauthenticated and invalid tokens before database operations; does not cache errors', async () => {
  const h = harness();
  const missing = await h.request('/saved-items', 'GET', undefined, null);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
  assert.equal(h.calls.length, 0);
  const invalid = harness({ authStatus: 401 });
  assert.equal((await invalid.request('/saved-items')).status, 401);
  assert.equal(invalid.calls.length, 1);
});

test('auth outages are 503, not logout errors, and upstream details are hidden', async () => {
  for (const options of [{ authStatus: 503 }, { throwAuth: true }, { databaseStatus: 503 }]) {
    const response = await harness(options).request('/saved-items');
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private/);
  }
});

test('each concurrent request has its own identity; reads and deletes filter by verified user', async () => {
  const h = harness();
  await Promise.all([
    h.request('/favorite-locations', 'POST', { location }, 'token-a'),
    h.request('/favorite-locations', 'POST', { location: destination }, 'token-b'),
  ]);
  const [a, b] = await Promise.all([h.request('/saved-items'), h.request('/saved-items', 'GET', undefined, 'token-b')]);
  assert.deepEqual((await a.json() as { locations: unknown[] }).locations, [location]);
  assert.deepEqual((await b.json() as { locations: unknown[] }).locations, [destination]);
  await h.request('/trip-history/42', 'DELETE', undefined, 'token-a');
  await h.request(`/favorite-trips/${encodeURIComponent(tripKey(trip))}`, 'DELETE', undefined, 'token-b');
  assert.equal(new Set(h.clients).size, 6);
  for (const call of h.calls.filter(call => call.url.pathname.startsWith('/rest/v1/') && call.method !== 'POST')) {
    assert.equal(call.url.searchParams.get('user_id'), call.token === 'token-a' ? 'eq.user-a' : 'eq.user-b');
    assert.doesNotMatch(call.url.searchParams.get('select') ?? '', /user_id/);
  }
  const historyRead = h.calls.find(call => call.url.pathname.endsWith('/trip_history') && call.method === 'GET')!;
  assert.equal(historyRead.url.searchParams.get('limit'), '10');
  assert.equal(historyRead.url.searchParams.get('order'), 'created_at.desc,id.desc');
});

test('validates payloads and rejects client ownership before any write', async () => {
  const h = harness();
  for (const body of [{ location, user_id: 'user-b' }, { location: { ...location, geometry: { coordinates: [181, 0] } } },
    { location: { ...location, place_name: '' } }, { location: null }]) {
    assert.equal((await h.request('/favorite-locations', 'POST', body)).status, 400);
  }
  assert.equal((await h.request('/trip-history/-1', 'DELETE')).status, 400);
  assert.equal((await h.request('/favorite-trips', 'POST', { ...trip, user_id: 'user-b' })).status, 400);
  assert.equal((await h.request('/favorite-locations', 'POST', { location: { ...location, place_name: 'x'.repeat(17000) } })).status, 413);
  assert.equal(h.calls.filter(call => call.url.pathname.startsWith('/rest/')).length, 0);
});

test('favorite upserts use existing exact keys and history forwards user token to atomic RPC', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) assert.equal((await h.request('/favorite-trips', 'POST', trip)).status, 204);
  assert.equal((await h.request('/trip-history', 'POST', trip)).status, 204);
  const writes = h.calls.filter(call => call.url.pathname.startsWith('/rest/'));
  assert.deepEqual(writes[0].body, { user_id: 'user-a', trip_key: tripKey(trip), ...trip });
  assert.equal(writes[0].url.searchParams.get('on_conflict'), 'user_id,trip_key');
  assert.equal(locationKey(location), '-97.123456,49.123456');
  assert.deepEqual(writes[2].body, { p_origin: location, p_destination: destination });
  assert.equal(writes[2].token, 'token-a');
  assert.equal(writes[2].url.pathname, '/rest/v1/rpc/record_planned_trip');
  assert.equal((await h.request(`/favorite-locations/${encodeURIComponent(locationKey(location))}`, 'DELETE')).status, 204);
  assert.equal((await h.request(`/favorite-locations/${encodeURIComponent(locationKey(location))}`, 'DELETE')).status, 204);
});

test('payload normalization preserves public shape without accepting arbitrary geocoder properties', () => {
  assert.deepEqual(parsePayload({ location: { ...location, extra: 'ignored' } }, 'location'), { location });
  assert.throws(() => parsePayload({ location: { ...location, geometry: { coordinates: [NaN, 0] } } }, 'location'));
});

test('browser preflight accepts bearer authorization and DELETE without authentication', async () => {
  const { apiCors } = await import('./middleware/apiCors.js');
  const app = new Hono();
  app.use('/api/*', apiCors());
  app.route('/api/me', createSavedItemsRoute(() => { throw new Error('Preflight must not authenticate'); }));
  const response = await app.request('/api/me/trip-history/42', {
    method: 'OPTIONS', headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /DELETE/);
  assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/i);
});

test('server configuration refuses secret/service-role keys before database access', async () => {
  const { createUserClient } = await import('./middleware/savedItemsAuth.js');
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    for (const key of ['sb_secret_do_not_use', `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`]) {
      process.env.SUPABASE_PUBLISHABLE_KEY = key;
      assert.throws(() => createUserClient('token-a'), /publishable|configured/);
    }
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    assert.ok(createUserClient('token-a'));
  } finally {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previous.key;
  }
});
