/**
 * Loads Winnipeg Transit's GTFS feed and keeps a small in-memory index for drawing routes.
 *
 * Flow:
 *   google_transit.zip
 *     trips.txt       -> which shapes each route uses, and one sample trip per shape
 *     shapes.txt      -> each shape's line, as ordered lat/lng points
 *     stop_times.txt  -> the ordered stop list of each sample trip = the shape's stops
 *     stops.txt       -> where each stop is
 *   -> GtfsIndex (this file) -> paths.ts cuts a ride's line between its two stops
 *   -> attached to each ride as `path` in /api/plans.
 *
 * The feed is downloaded at startup and re-downloaded every GTFS_REFRESH_HOURS (default 24).
 * Nothing is written to disk. Timetables in stop_times.txt are not used; only stop order is.
 */
import JSZip from 'jszip';

const GTFS_URL = 'https://gtfs.winnipegtransit.com/google_transit.zip';

export type Coord = { lat: number; lng: number };
/** One drawn line of a route (a direction or branch), points in driving order. */
export type Shape = { id: string; points: Coord[] };

/** Everything the backend keeps from the feed. Replaced as a whole on each refresh. */
export interface GtfsIndex {
  /** routeKey (route_id / route_short_name, normalized to string) -> shapes for that route */
  shapesByRoute: Map<string, Shape[]>;
  /** shapeId -> ordered stop_ids served along that shape (every trip on a shape shares one stop list) */
  stopsByShape: Map<string, string[]>;
  /** stop_id -> GTFS stop coordinates */
  stopCoords: Map<string, Coord>;
  /** feed_start_date (or feed_version) from feed_info.txt, when present */
  feedDate?: string;
  /** when this index was built (ms since epoch) */
  loadedAt: number;
}

// The index in use, and a pending first load so concurrent callers share one download.
let current: GtfsIndex | null = null;
let inFlight: Promise<GtfsIndex> | null = null;

/** The loaded index, or null before the first load finishes (callers then skip drawing). */
export function getGtfsIndex(): GtfsIndex | null {
  return current;
}

/** The loaded index, loading it first if needed. Used by the legacy /api/route-shape. */
export async function ensureGtfsIndex(): Promise<GtfsIndex> {
  if (current) return current;
  if (inFlight) return inFlight;
  inFlight = loadGtfs()
    .then((idx) => {
      current = idx;
      return idx;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Download the feed and build a fresh index (about 1.7 s; peak memory ~135 MB, ~8 MB kept). */
async function loadGtfs(): Promise<GtfsIndex> {
  console.log('[gtfs] downloading', GTFS_URL);
  const t0 = Date.now();
  const res = await fetch(GTFS_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[gtfs] downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0} ms`);

  const zip = await JSZip.loadAsync(buf);

  const readText = async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (!file) throw new Error(`GTFS bundle missing ${name}`);
    return file.async('string');
  };

  const [routesCsv, tripsCsv, shapesCsv, stopsCsv, stopTimesCsv, feedInfoCsv] = await Promise.all([
    readText('routes.txt'),
    readText('trips.txt'),
    readText('shapes.txt'),
    readText('stops.txt'),
    readText('stop_times.txt'),
    zip.file('feed_info.txt')?.async('string') ?? Promise.resolve(''),
  ]);

  // Parse routes. Not used below (any route that appears in trips.txt is accepted); kept as a sanity read.
  const routeIds = new Set<string>();
  for (const row of parseCsv(routesCsv)) {
    const id = row.route_id;
    if (id) routeIds.add(id);
  }

  // Parse trips → routeId -> set of shapeIds, plus one representative trip per shape.
  // Every trip on a shape stops at the same stops in the same order (true for all 294
  // shapes in the Sept 2026 feed), so one trip per shape is enough to learn its stop list.
  // Route IDs here (e.g. "BLUE", "F8") match the Winnipeg Transit API's route keys.
  const shapeIdsByRoute = new Map<string, Set<string>>();
  const shapeByTrip = new Map<string, string>();
  const representedShapes = new Set<string>();
  for (const row of parseCsv(tripsCsv)) {
    const routeId = row.route_id;
    const shapeId = row.shape_id;
    if (!routeId || !shapeId) continue;
    if (row.trip_id && !representedShapes.has(shapeId)) {
      representedShapes.add(shapeId);
      shapeByTrip.set(row.trip_id, shapeId);
    }
    let set = shapeIdsByRoute.get(routeId);
    if (!set) {
      set = new Set<string>();
      shapeIdsByRoute.set(routeId, set);
    }
    set.add(shapeId);
  }

  // Parse shapes → shapeId -> ordered points
  // shape_pt_sequence is 1-based; we sort to be safe.
  const pointsByShape = new Map<string, Array<{ seq: number; lat: number; lng: number }>>();
  for (const row of parseCsv(shapesCsv)) {
    const id = row.shape_id;
    const lat = Number(row.shape_pt_lat);
    const lng = Number(row.shape_pt_lon);
    const seq = Number(row.shape_pt_sequence);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    let arr = pointsByShape.get(id);
    if (!arr) {
      arr = [];
      pointsByShape.set(id, arr);
    }
    arr.push({ seq, lat, lng });
  }
  for (const pts of pointsByShape.values()) {
    pts.sort((a, b) => a.seq - b.seq);
  }

  // Group the finished lines by route; shapes with fewer than 2 points can't be drawn.
  const shapesByRoute = new Map<string, Shape[]>();
  for (const [routeId, shapeIds] of shapeIdsByRoute) {
    const shapes: Shape[] = [];
    for (const sid of shapeIds) {
      const pts = pointsByShape.get(sid);
      if (!pts || pts.length < 2) continue;
      shapes.push({ id: sid, points: pts.map((p) => ({ lat: p.lat, lng: p.lng })) });
    }
    if (shapes.length > 0) shapesByRoute.set(routeId, shapes);
  }

  // Stop IDs in these files are the same numbers the trip planner uses for stops (e.g. 10638).
  const stopsByShape = stopListsByShape(stopTimesCsv, shapeByTrip);
  const stopCoords = new Map<string, Coord>();
  for (const row of parseCsv(stopsCsv)) {
    const lat = Number(row.stop_lat);
    const lng = Number(row.stop_lon);
    if (row.stop_id && Number.isFinite(lat) && Number.isFinite(lng)) stopCoords.set(row.stop_id, { lat, lng });
  }

  let feedDate: string | undefined;
  if (feedInfoCsv) {
    const first = parseCsv(feedInfoCsv)[0];
    feedDate = first?.feed_start_date ?? first?.feed_version;
  }

  console.log(
    `[gtfs] indexed ${shapesByRoute.size} routes, ${pointsByShape.size} shapes, ${stopsByShape.size} stop lists, ${stopCoords.size} stops in ${Date.now() - t0} ms`
  );

  return {
    shapesByRoute,
    stopsByShape,
    stopCoords,
    feedDate,
    loadedAt: Date.now(),
  };
}

/**
 * Load the feed now, then reload it every GTFS_REFRESH_HOURS (default 24, minimum 1).
 * A failed refresh is logged and the previous index keeps serving.
 */
export async function startGtfsRefreshLoop(): Promise<void> {
  const hours = Math.max(1, Number(process.env.GTFS_REFRESH_HOURS ?? 24));
  const intervalMs = hours * 60 * 60 * 1000;

  const refresh = async () => {
    try {
      const idx = await loadGtfs();
      current = idx;
    } catch (err) {
      console.warn('[gtfs] refresh failed:', err instanceof Error ? err.message : err);
    }
  };

  await refresh();
  setInterval(refresh, intervalMs).unref(); // unref: the timer alone doesn't keep the process alive
}

/**
 * shapeId -> its stops in order, read from stop_times.txt for the sample trips only.
 *
 * stop_times.txt is the largest file (~15 MB, one row per stop per trip). Scan it line by
 * line and keep only the representative trip of each shape, instead of building an
 * object per row. Its columns are plain IDs, times and integers, so no quoted fields are
 * expected. Rows are sorted by stop_sequence because the file isn't guaranteed to be.
 * Throws if the required columns are missing.
 */
export function stopListsByShape(text: string, shapeByTrip: Map<string, string>): Map<string, string[]> {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n');
  const header = lines[0].replace('\r', '').split(',');
  const [tripCol, stopCol, seqCol] = ['trip_id', 'stop_id', 'stop_sequence'].map((name) => header.indexOf(name));
  if (tripCol < 0 || stopCol < 0 || seqCol < 0) throw new Error('GTFS stop_times.txt missing required columns');
  const rows = new Map<string, Array<[number, string]>>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].replace('\r', '').split(',');
    const shapeId = shapeByTrip.get(cells[tripCol]);
    if (!shapeId) continue;
    let list = rows.get(shapeId);
    if (!list) rows.set(shapeId, (list = []));
    list.push([Number(cells[seqCol]), cells[stopCol]]);
  }
  const out = new Map<string, string[]>();
  for (const [shapeId, list] of rows) out.set(shapeId, list.sort((a, b) => a[0] - b[0]).map(([, stop]) => stop));
  return out;
}

/**
 * Minimal CSV parser. Handles double-quoted fields with embedded commas or quotes.
 * Returns an array of row objects keyed by the header.
 * GTFS files are UTF-8, LF or CRLF line-terminated, and follow RFC 4180-ish rules.
 */
function parseCsv(text: string): Record<string, string>[] {
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else if (c === '\r') {
        // Ignore; LF handles end of row.
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue;
    const obj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = r[j] ?? '';
    }
    out.push(obj);
  }
  return out;
}
