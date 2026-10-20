import 'dotenv/config';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

// Opt-in only: use two empty disposable accounts, never real user sessions.
const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key,
  SAVED_ITEMS_TEST_TOKEN_A: tokenA, SAVED_ITEMS_TEST_TOKEN_B: tokenB } = process.env;
const base = process.env.SAVED_ITEMS_TEST_BACKEND_URL;
if (process.env.SAVED_ITEMS_TEST_DISPOSABLE !== '1' || !url || !key || !tokenA || !tokenB || !base) {
  console.error('Set SAVED_ITEMS_TEST_DISPOSABLE=1, SAVED_ITEMS_TEST_BACKEND_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SAVED_ITEMS_TEST_TOKEN_A/B for two empty disposable accounts. No requests sent.');
  process.exit(1);
}
const client = token => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { retry: false },
  global: { headers: { Authorization: `Bearer ${token}` }, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) },
});
const clients = [client(tokenA), client(tokenB)];
const users = await Promise.all(clients.map((c, i) => c.auth.getUser([tokenA, tokenB][i])));
assert.ok(users.every(r => !r.error && r.data.user), 'Both test accounts must be authenticated');
assert.notEqual(users[0].data.user.id, users[1].data.user.id, 'Use two different test accounts');
const userB = users[1].data.user.id;
async function request(token, path, method = 'GET', body, expected = method === 'GET' ? 200 : 204) {
  const response = await fetch(`${base.replace(/\/+$/, '')}/api/me${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000),
  });
  assert.equal(response.status, expected, `${method} ${path.split('/')[1]} returned unexpected status`);
  return response.status === 204 ? undefined : response.json();
}
const initial = await Promise.all([tokenA, tokenB].map(t => request(t, '/saved-items')));
assert.ok(initial.every(l => !l.locations.length && !l.favorites.length && !l.history.length), 'Use empty disposable accounts; no writes performed');
const location = i => ({ id: `saved-api-test-${i}`, place_name: `Saved API test ${i}`, geometry: { coordinates: [-97.1 - i / 1000, 49.8] } });
const trip = i => ({ origin: location(i), destination: location(100) });
const pointKey = p => p.geometry.coordinates.join(',');
const tripKey = t => `${pointKey(t.origin)}>${pointKey(t.destination)}`;
let completed = false;
try {
  await Promise.all([request(tokenA, '/favorite-locations', 'POST', { location: location(0) }),
    request(tokenB, '/favorite-locations', 'POST', { location: location(1) })]);
  await request(tokenA, '/favorite-trips', 'POST', trip(0));
  await request(tokenA, '/favorite-trips', 'POST', trip(0));
  await request(tokenB, '/trip-history', 'POST', trip(1));
  const b = await request(tokenB, '/saved-items');
  await request(tokenA, `/favorite-locations/${encodeURIComponent(pointKey(location(1)))}`, 'DELETE');
  await request(tokenA, `/trip-history/${b.history[0].id}`, 'DELETE');
  const bAfter = await request(tokenB, '/saved-items');
  assert.equal(bAfter.locations.length, 1);
  assert.equal(bAfter.history.length, 1);
  assert.equal((await request(tokenA, '/saved-items')).favorites.length, 1);
  await request(tokenA, '/favorite-locations', 'POST', { location: location(2), user_id: userB }, 400);
  // Test actual database RLS too, including direct Data API access outside the backend.
  for (const table of ['favorite_locations', 'favorite_trips', 'trip_history']) {
    const result = await clients[0].from(table).select('*').eq('user_id', userB);
    assert.equal(result.error, null); assert.deepEqual(result.data, []);
  }
  const forged = await clients[0].from('favorite_locations').upsert({ user_id: userB,
    location_key: pointKey(location(1)), location: location(1) });
  assert.ok(forged.error, 'RLS must reject ownership forgery');
  const deletion = await clients[0].from('favorite_locations').delete().eq('user_id', userB);
  assert.equal(deletion.error, null);
  assert.equal((await request(tokenB, '/saved-items')).locations.length, 1);
  for (let i = 0; i < 12; i++) await request(tokenA, '/trip-history', 'POST', trip(i));
  let history = (await request(tokenA, '/saved-items')).history;
  assert.equal(history.length, 10);
  assert.equal(history[0].origin.id, location(11).id);
  await request(tokenA, '/trip-history', 'POST', trip(3));
  history = (await request(tokenA, '/saved-items')).history;
  assert.equal(history.length, 10);
  assert.equal(history[0].origin.id, location(3).id);
  await Promise.all([request(tokenA, '/trip-history', 'POST', trip(3)), request(tokenA, '/trip-history', 'POST', trip(3))]);
  history = (await request(tokenA, '/saved-items')).history;
  assert.equal(history.length, 10);
  assert.equal(history.filter(t => t.origin.id === location(3).id).length, 1);
  completed = true;
} finally {
  // Both accounts were required to be empty before any writes.
  for (const token of [tokenA, tokenB]) {
    const lists = await request(token, '/saved-items');
    for (const place of lists.locations) await request(token, `/favorite-locations/${encodeURIComponent(pointKey(place))}`, 'DELETE');
    for (const t of lists.favorites) await request(token, `/favorite-trips/${encodeURIComponent(tripKey(t))}`, 'DELETE');
    for (const t of lists.history) await request(token, `/trip-history/${t.id}`, 'DELETE');
  }
}
if (completed) console.log('Saved-data API and real Supabase RLS checks passed for two accounts; fixtures removed.');
