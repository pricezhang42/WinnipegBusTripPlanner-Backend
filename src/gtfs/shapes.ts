import type { Coord, Shape } from './loader.js';

export type ShapeMatch = { points: Coord[]; shapeId: string; score: number };

/**
 * Squared Euclidean distance on raw degrees.
 * Fine for a small area like Winnipeg (no polar distortion concerns).
 */
function sqDist(a: Coord, b: Coord): number {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

function closestPointIndex(points: Coord[], target: Coord): { idx: number; dist: number } {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = sqDist(points[i], target);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: bestDist };
}

/**
 * Pick the best shape for this ride and return the polyline slice between origin and destination.
 *
 * Strategy:
 *   - For each candidate shape, find the nearest points to origin and destination.
 *   - Prefer a shape whose origin comes before destination in the sequence (directionally correct).
 *   - Among those, pick the one with the smallest combined distance to the two stops.
 *   - If no shape is directionally correct, fall back to the best reversed slice.
 *
 * Returns null when no shapes exist for this route.
 */
export function matchShape(
  shapes: Shape[] | undefined,
  origin: Coord,
  dest: Coord
): ShapeMatch | null {
  if (!shapes || shapes.length === 0) return null;

  let bestOriented: ShapeMatch | null = null;
  let bestAny: ShapeMatch | null = null;

  for (const shape of shapes) {
    const o = closestPointIndex(shape.points, origin);
    const d = closestPointIndex(shape.points, dest);
    const score = o.dist + d.dist;

    const oriented = o.idx <= d.idx;
    const slice = oriented
      ? shape.points.slice(o.idx, d.idx + 1)
      : shape.points.slice(d.idx, o.idx + 1).reverse();

    if (slice.length < 2) continue;

    const match: ShapeMatch = { points: slice, shapeId: shape.id, score };

    if (oriented) {
      if (!bestOriented || score < bestOriented.score) bestOriented = match;
    }
    if (!bestAny || score < bestAny.score) bestAny = match;
  }

  return bestOriented ?? bestAny;
}
