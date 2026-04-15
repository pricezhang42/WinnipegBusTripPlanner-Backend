import { Hono } from 'hono';
import { rateLimit } from '../middleware/rateLimit.js';

export const plansRoute = new Hono();

plansRoute.use('*', rateLimit({ windowMs: 60_000, max: 40, label: 'plans' }));

const TRIP_PLANNER_URL = 'https://api.winnipegtransit.com/v3/trip-planner.json';
const STOP_FEATURES_URL = (key: string | number) =>
  `https://api.winnipegtransit.com/v3/stops/${key}/features.json`;

type ShelterType = 'Heated Shelter' | 'Unheated Shelter' | 'Unsheltered';

// Stop features effectively never change — cache for a week.
const shelterCache = new Map<string, { value: ShelterType; expires: number }>();
const SHELTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function fetchShelter(stopKey: string | number, apiKey: string): Promise<ShelterType> {
  const k = String(stopKey);
  const cached = shelterCache.get(k);
  if (cached && cached.expires > Date.now()) return cached.value;

  const url = `${STOP_FEATURES_URL(stopKey)}?api-key=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return 'Unsheltered';
    const data = (await r.json()) as { 'stop-features'?: Array<{ name?: string }> };
    const features = data['stop-features'] ?? [];
    let value: ShelterType = 'Unsheltered';
    for (const f of features) {
      if (f.name === 'Heated Shelter') {
        value = 'Heated Shelter';
        break;
      }
      if (f.name === 'Unheated Shelter') {
        value = 'Unheated Shelter';
      }
    }
    shelterCache.set(k, { value, expires: Date.now() + SHELTER_TTL_MS });
    return value;
  } catch {
    return 'Unsheltered';
  }
}

function collectStopKeys(plans: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(plans)) return keys;
  for (const plan of plans) {
    const segs = (plan as { segments?: unknown[] }).segments;
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      const to = (seg as { to?: { stop?: { key?: unknown } } }).to;
      const k = to?.stop?.key;
      if (k !== undefined && k !== null) keys.add(String(k));
    }
  }
  return keys;
}

plansRoute.get('/', async (c) => {
  const apiKey = process.env.WT_API_KEY;
  if (!apiKey) return c.json({ error: 'Server missing WT_API_KEY' }, 500);

  const origin = c.req.query('origin');
  const destination = c.req.query('destination');
  const date = c.req.query('date');
  const time = c.req.query('time');
  const mode = c.req.query('mode');

  if (!origin || !destination) {
    return c.json({ error: 'origin and destination are required' }, 400);
  }

  const url = new URL(TRIP_PLANNER_URL);
  url.searchParams.set('api-key', apiKey);
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  if (date) url.searchParams.set('date', date);
  if (time) url.searchParams.set('time', time);
  if (mode) url.searchParams.set('mode', mode);

  let plansData: unknown;
  try {
    const r = await fetchWithTimeout(url.toString());
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const friendly =
        text === 'Coordinates not in zone 14U' ? 'Origin or destination not in Winnipeg' : text || r.statusText;
      return c.json({ error: 'Winnipeg Transit request failed', message: friendly }, 502);
    }
    plansData = await r.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Trip planner request failed', message }, 502);
  }

  const plans = (plansData as { plans?: unknown[] }).plans ?? [];

  const stopKeys = collectStopKeys(plans);
  const shelterEntries = await Promise.all(
    Array.from(stopKeys).map(async (k) => [k, await fetchShelter(k, apiKey)] as const)
  );
  const shelters: Record<string, ShelterType> = Object.fromEntries(shelterEntries);

  return c.json({ plans, shelters });
});
