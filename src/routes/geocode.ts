import { Hono } from 'hono';
import { rateLimit } from '../middleware/rateLimit.js';

export const geocodeRoute = new Hono();

// Tuned for typical app usage with headroom for carrier-grade NAT.
geocodeRoute.use('*', rateLimit({ windowMs: 60_000, max: 120, label: 'geocode' }));

const MAPBOX_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

type CacheEntry = { body: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — geocode answers change slowly

geocodeRoute.get('/', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 3) {
    return c.json({ features: [] });
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    return c.json({ error: 'Server missing MAPBOX_TOKEN' }, 500);
  }

  const cacheKey = q.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return c.json(cached.body);
  }

  const url = new URL(`${MAPBOX_URL}/${encodeURIComponent(q)}.json`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('autocomplete', 'true');
  url.searchParams.set('country', 'ca');
  url.searchParams.set('proximity', '-97.1384,49.8951');
  url.searchParams.set('limit', '5');

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      return c.json({ error: 'Mapbox request failed', status: r.status }, 502);
    }
    const data = (await r.json()) as { features?: unknown[] };
    const body = { features: data.features ?? [] };
    cache.set(cacheKey, { body, expires: Date.now() + CACHE_TTL_MS });
    return c.json(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Geocode request failed', message }, 502);
  }
});
