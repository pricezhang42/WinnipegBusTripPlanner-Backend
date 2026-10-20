import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { savedItemsAuth, type SavedItemsEnv, type UserClientFactory } from '../middleware/savedItemsAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parsePayload, savedItemsStore, SavedItemsError } from '../savedItems.js';

async function readBody(c: Context) {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new SavedItemsError(400, 'invalid_payload', 'Send an application/json request body.');
  }
  try { return await c.req.json(); }
  catch (error) {
    if (error instanceof Error && error.name === 'BodyLimitError') {
      throw new SavedItemsError(413, 'payload_too_large', 'Saved-item requests must be at most 16 KiB.');
    }
    throw new SavedItemsError(400, 'invalid_json', 'The request body must be valid JSON.');
  }
}

export function createSavedItemsRoute(factory?: UserClientFactory) {
  const route = new Hono<SavedItemsEnv>();
  route.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  route.use('*', rateLimit({ windowMs: 60_000, max: 120, label: 'saved-items' }));
  route.use('*', bodyLimit({ maxSize: 16 * 1024, onError: c =>
    c.json({ error: { code: 'payload_too_large', message: 'Saved-item requests must be at most 16 KiB.' } }, 413) }));
  route.use('*', savedItemsAuth(factory));

  const store = (c: Context<SavedItemsEnv>) => savedItemsStore(c.get('userClient'), c.get('userId'));
  route.get('/saved-items', async c => c.json(await store(c).list()));
  route.post('/favorite-locations', async c => {
    const { location } = parsePayload(await readBody(c), 'location');
    await store(c).saveLocation(location);
    return c.body(null, 204);
  });
  route.post('/favorite-trips', async c => {
    await store(c).saveTrip(parsePayload(await readBody(c), 'trip'));
    return c.body(null, 204);
  });
  route.post('/trip-history', async c => {
    await store(c).recordTrip(parsePayload(await readBody(c), 'trip'));
    return c.body(null, 204);
  });
  for (const [path, kind] of [['favorite-locations', 'location'], ['favorite-trips', 'trip'], ['trip-history', 'history']] as const) {
    route.delete(`/${path}/:key`, async c => {
      const key = c.req.param('key');
      if (!key || key.length > 512 || (kind === 'history' && !/^[1-9]\d{0,18}$/.test(key))) {
        throw new SavedItemsError(400, 'invalid_key', 'The saved-item identifier is invalid.');
      }
      await store(c).remove(kind, key);
      return c.body(null, 204);
    });
  }
  route.onError((error, c) => {
    if (error instanceof SavedItemsError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    // Do not leak upstream errors, credentials, or saved locations into responses/logs.
    return c.json({ error: { code: 'saved_items_unavailable', message: 'Saved items are temporarily unavailable. Please try again.' } }, 503);
  });
  return route;
}
