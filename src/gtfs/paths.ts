import type { Coord, GtfsIndex } from './loader.js';

// Approximate metres between two nearby points (equirectangular; fine at city scale).
function metres(a: Coord, b: Coord): number {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(x, b.lat - a.lat) * 111_320;
}

const NEAR_METRES = 50;
/**
 * Index of each stop along its shape, found in stop order so a loop that passes a
 * stop twice resolves to the right pass: scan forward from the previous stop, take
 * the first stretch within 50 m and follow it to its closest point.
 */
export function stopPositions(points: Coord[], stops: Array<Coord | undefined>): number[] {
  const positions: number[] = [];
  let cursor = 0;
  for (const stop of stops) {
    if (!stop) { positions.push(cursor); continue; }
    let found = -1;
    for (let i = cursor; i < points.length; i++) {
      if (metres(points[i], stop) <= NEAR_METRES) { found = i; break; }
    }
    if (found >= 0) {
      while (found + 1 < points.length && metres(points[found + 1], stop) < metres(points[found], stop)) found++;
    } else {
      // Stop is off the drawn line; fall back to the closest remaining point.
      found = cursor;
      for (let i = cursor; i < points.length; i++) if (metres(points[i], stop) < metres(points[found], stop)) found = i;
    }
    positions.push(found);
    cursor = found;
  }
  return positions;
}

// Positions depend only on the feed, so compute each shape once per loaded index.
const positionCache = new WeakMap<GtfsIndex, Map<string, number[]>>();
function positionsFor(idx: GtfsIndex, shapeId: string, points: Coord[], stops: string[]): number[] {
  let cache = positionCache.get(idx);
  if (!cache) positionCache.set(idx, (cache = new Map()));
  let positions = cache.get(shapeId);
  if (!positions) cache.set(shapeId, (positions = stopPositions(points, stops.map((s) => idx.stopCoords.get(s)))));
  return positions;
}

/**
 * The route's line between two stops, using the GTFS trips that serve the boarding
 * stop and then the exit stop. Stop IDs are the same keys the Winnipeg Transit API uses.
 * Returns null when no shape of that route serves both stops in that order.
 */
export function pathBetweenStops(idx: GtfsIndex, route: string, boardStop: string, exitStop: string): Coord[] | null {
  let best: { shapeId: string; from: number; to: number; span: number } | null = null;
  for (const shape of idx.shapesByRoute.get(route) ?? []) {
    const stops = idx.stopsByShape.get(shape.id);
    if (!stops) continue;
    for (let b = stops.indexOf(boardStop); b >= 0; b = stops.indexOf(boardStop, b + 1)) {
      const e = stops.indexOf(exitStop, b + 1);
      if (e < 0) break;
      // Branches often share the stretch between the two stops; the tightest match is enough.
      if (!best || e - b < best.span) best = { shapeId: shape.id, from: b, to: e, span: e - b };
    }
  }
  if (!best) return null;
  const shape = idx.shapesByRoute.get(route)!.find((s) => s.id === best!.shapeId)!;
  const positions = positionsFor(idx, shape.id, shape.points, idx.stopsByShape.get(shape.id)!);
  const slice = shape.points.slice(positions[best.from], positions[best.to] + 1);
  if (slice.length >= 2) return slice;
  // Adjacent stops can land on the same line point (e.g. at a terminal): join the two stops.
  const [from, to] = [idx.stopCoords.get(boardStop), idx.stopCoords.get(exitStop)];
  return from && to ? [from, to] : null;
}

type Segment = { type?: string; route?: { key?: unknown }; from?: { stop?: { key?: unknown } }; to?: { stop?: { key?: unknown } } };
const stopKey = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

/**
 * Attach `path: [[lat, lng], ...]` to each ride. The boarding stop comes from the
 * segment before the ride (walk or transfer) and the exit stop from the one after it.
 * Rides without a match get no path; the app then draws a straight line.
 */
export function attachPaths(plans: unknown[], idx: GtfsIndex | null): unknown[] {
  if (!idx) return plans;
  return plans.map((plan) => {
    const segments = (plan as { segments?: Segment[] } | null)?.segments;
    if (!Array.isArray(segments)) return plan;
    return { ...(plan as object), segments: segments.map((ride, i) => {
      if (ride?.type !== 'ride' || ride.route?.key == null) return ride;
      const board = stopKey(ride.from?.stop?.key) ?? (segments[i - 1]?.type !== 'ride' ? stopKey(segments[i - 1]?.to?.stop?.key) : undefined);
      const exit = stopKey(ride.to?.stop?.key) ?? (segments[i + 1]?.type !== 'ride' ? stopKey(segments[i + 1]?.from?.stop?.key) : undefined);
      if (!board || !exit) return ride;
      try {
        const path = pathBetweenStops(idx, String(ride.route.key), board, exit);
        return path ? { ...ride, path: path.map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5)]) } : ride;
      } catch { return ride; }
    }) };
  });
}
