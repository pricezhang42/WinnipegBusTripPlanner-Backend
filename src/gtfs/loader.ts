import JSZip from 'jszip';

const GTFS_URL = 'https://gtfs.winnipegtransit.com/google_transit.zip';

export type Coord = { lat: number; lng: number };
export type Shape = { id: string; points: Coord[] };

export interface GtfsIndex {
  /** routeKey (route_id / route_short_name, normalized to string) -> shapes for that route */
  shapesByRoute: Map<string, Shape[]>;
  feedDate?: string;
  loadedAt: number;
}

let current: GtfsIndex | null = null;
let inFlight: Promise<GtfsIndex> | null = null;

export function getGtfsIndex(): GtfsIndex | null {
  return current;
}

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

  const [routesCsv, tripsCsv, shapesCsv, feedInfoCsv] = await Promise.all([
    readText('routes.txt'),
    readText('trips.txt'),
    readText('shapes.txt'),
    zip.file('feed_info.txt')?.async('string') ?? Promise.resolve(''),
  ]);

  // Parse routes (we accept any routeKey that shows up in trips; we mostly read routes.txt for sanity).
  const routeIds = new Set<string>();
  for (const row of parseCsv(routesCsv)) {
    const id = row.route_id;
    if (id) routeIds.add(id);
  }

  // Parse trips → routeId -> set of shapeIds
  const shapeIdsByRoute = new Map<string, Set<string>>();
  for (const row of parseCsv(tripsCsv)) {
    const routeId = row.route_id;
    const shapeId = row.shape_id;
    if (!routeId || !shapeId) continue;
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

  let feedDate: string | undefined;
  if (feedInfoCsv) {
    const first = parseCsv(feedInfoCsv)[0];
    feedDate = first?.feed_start_date ?? first?.feed_version;
  }

  console.log(
    `[gtfs] indexed ${shapesByRoute.size} routes, ${pointsByShape.size} shapes in ${Date.now() - t0} ms`
  );

  return {
    shapesByRoute,
    feedDate,
    loadedAt: Date.now(),
  };
}

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
  setInterval(refresh, intervalMs).unref();
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
