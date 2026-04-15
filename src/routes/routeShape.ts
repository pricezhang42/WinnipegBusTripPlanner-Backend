import { Hono } from 'hono';
import { ensureGtfsIndex, getGtfsIndex } from '../gtfs/loader.js';
import { matchShape } from '../gtfs/shapes.js';

export const routeShapeRoute = new Hono();

function parseLatLng(s: string | undefined): { lat: number; lng: number } | null {
  if (!s) return null;
  const [latStr, lngStr] = s.split(',').map((p) => p.trim());
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

routeShapeRoute.get('/', async (c) => {
  const route = c.req.query('route');
  const from = parseLatLng(c.req.query('from'));
  const to = parseLatLng(c.req.query('to'));

  if (!route || !from || !to) {
    return c.json(
      { error: 'route, from (lat,lng), and to (lat,lng) are required' },
      400
    );
  }

  let idx = getGtfsIndex();
  if (!idx) {
    try {
      idx = await ensureGtfsIndex();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'GTFS index not ready', message }, 503);
    }
  }

  // Normalize to string — Winnipeg Transit API returns numeric route keys sometimes.
  const routeKey = String(route);
  const shapes = idx.shapesByRoute.get(routeKey);

  if (!shapes || shapes.length === 0) {
    return c.json({ points: null, reason: 'no_shapes_for_route', route: routeKey });
  }

  const match = matchShape(shapes, from, to);
  if (!match) {
    return c.json({ points: null, reason: 'no_match', route: routeKey });
  }

  return c.json({
    route: routeKey,
    shapeId: match.shapeId,
    points: match.points.map((p) => [p.lat, p.lng]),
  });
});
