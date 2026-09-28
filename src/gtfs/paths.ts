/**
 * Draws each bus ride of a trip plan along the real route, using the GTFS index from loader.ts.
 *
 * A ride in the trip planner's response names its route but carries no line. The stops
 * around it do: the walk or transfer before the ride ends at the boarding stop, and the
 * one after it starts at the exit stop. GTFS stop IDs are the same numbers, so:
 *   1. find a shape of that route whose stop list has the boarding stop, then the exit stop;
 *   2. find where those two stops sit along the shape's points;
 *   3. cut the points between them.
 * Matching by stop ID (rather than by nearest line) picks the right direction and branch.
 * attachPaths() adds the result to /api/plans as `path`; rides without a match get none
 * and the app draws a straight line between the stops.
 */
import type { Coord, GtfsIndex } from './loader.js';

// Approximate metres between two nearby points (equirectangular; fine at city scale).
function metres(a: Coord, b: Coord): number {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(x, b.lat - a.lat) * 111_320;
}

// A shape point this close to a stop counts as passing it. Stops sit at the curb, a few
// metres from the drawn line, so 50 m is generous without reaching a parallel street.
const NEAR_METRES = 50;
/**
 * Index into `points` for each stop in `stops` (both in travel order).
 *
 * Stops are placed in order and the search only moves forward, so on a loop that passes
 * the same corner twice each stop resolves to the right pass: scan forward from the
 * previous stop, take the first point within NEAR_METRES and follow it to its closest
 * point. A stop farther than that from the line gets the closest remaining point; a stop
 * with unknown coordinates reuses the previous position.
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

// Positions depend only on the feed, so compute each shape once per loaded index. Keyed by
// the index object itself, so a refreshed feed starts a new cache and the old one is freed.
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
 *
 * Returns the shape's points from the boarding stop to the exit stop; a two-point straight
 * line between the stops when both land on the same shape point (e.g. at a terminal); or
 * null when no shape of that route serves both stops in that order.
 */
export function pathBetweenStops(idx: GtfsIndex, route: string, boardStop: string, exitStop: string): Coord[] | null {
  let best: { shapeId: string; from: number; to: number; span: number } | null = null;
  for (const shape of idx.shapesByRoute.get(route) ?? []) {
    const stops = idx.stopsByShape.get(shape.id);
    if (!stops) continue;
    // A stop can appear twice on a looping shape: try each boarding occurrence with the next exit after it.
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

// The parts of a trip-planner segment this file reads. Keys can be numbers or strings.
type Segment = { type?: string; route?: { key?: unknown }; from?: { stop?: { key?: unknown } }; to?: { stop?: { key?: unknown } } };
const stopKey = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

/**
 * Attach `path: [[lat, lng], ...]` to each ride. The boarding stop comes from the
 * segment before the ride (walk or transfer) and the exit stop from the one after it.
 * Rides without a match get no path; the app then draws a straight line.
 *
 * Never throws and never drops a plan: without an index (feed still loading) plans are
 * returned unchanged, and a ride that fails to match is returned as it was.
 */
export function attachPaths(plans: unknown[], idx: GtfsIndex | null): unknown[] {
  if (!idx) return plans;
  return plans.map((plan) => {
    const segments = (plan as { segments?: Segment[] } | null)?.segments;
    if (!Array.isArray(segments)) return plan;
    return { ...(plan as object), segments: segments.map((ride, i) => {
      if (ride?.type !== 'ride' || ride.route?.key == null) return ride;
      // A ride directly after another ride (no transfer between) has no known boarding stop.
      const board = stopKey(ride.from?.stop?.key) ?? (segments[i - 1]?.type !== 'ride' ? stopKey(segments[i - 1]?.to?.stop?.key) : undefined);
      const exit = stopKey(ride.to?.stop?.key) ?? (segments[i + 1]?.type !== 'ride' ? stopKey(segments[i + 1]?.from?.stop?.key) : undefined);
      if (!board || !exit) return ride;
      try {
        const path = pathBetweenStops(idx, String(ride.route.key), board, exit);
        // 5 decimals is about 1 m, plenty for drawing, and keeps the response small.
        return path ? { ...ride, path: path.map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5)]) } : ride;
      } catch { return ride; }
    }) };
  });
}
