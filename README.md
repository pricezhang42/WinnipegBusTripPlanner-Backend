# BusTripPlanner Backend

Proxy + enrichment layer for the [Winnipeg Bus Trip Planner](https://github.com/pricezhang42/BusTripPlanner) mobile app. Hides upstream API keys from the client, batches N+1 calls, and serves bus-route polylines from the Winnipeg Transit GTFS feed.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe |
| GET | `/api/geocode?q=<text>` | Mapbox geocoding autocomplete (Canada, biased to Winnipeg) |
| GET | `/api/plans?origin=&destination=&date=&time=&mode=` | Winnipeg Transit trip-planner + shelter info for every stop in the response, merged into one payload |
| GET | `/api/route-shape?route=<key>&from=<lat,lng>&to=<lat,lng>` | Polyline for a bus route, sliced to the segment between two stops. Powered by the GTFS `shapes.txt` feed. |

### `/api/plans` response shape

```json
{
  "plans": [ /* unchanged Winnipeg Transit trip-planner plans array */ ],
  "shelters": {
    "10064": "Heated Shelter",
    "10073": "Unsheltered"
  }
}
```

`shelters` maps `stop.key` → shelter type. One of `Heated Shelter`, `Unheated Shelter`, `Unsheltered`.

### `/api/route-shape` response shape

Success:
```json
{
  "route": "BLUE",
  "shapeId": "3393",
  "points": [[49.8813, -97.1991], [49.8812, -97.1991], ...]
}
```

Miss:
```json
{ "points": null, "reason": "no_shapes_for_route" | "no_match", "route": "..." }
```

Clients should fall back to drawing a straight line between the two stops when `points` is null.

## Setup

```bash
cp .env.example .env
# Fill in MAPBOX_TOKEN and WT_API_KEY
npm install
npm run dev
```

Server runs on `http://localhost:8787` by default.

On startup the GTFS feed (`https://gtfs.winnipegtransit.com/google_transit.zip`, ~4 MB) is downloaded, parsed, and indexed in memory. Indexing takes a few seconds. The feed is re-downloaded every `GTFS_REFRESH_HOURS` (default 24).

## Connecting the mobile client

Android emulator — `10.0.2.2` maps to the host's localhost:

```ts
export const BACKEND_BASE_URL = 'http://10.0.2.2:8787';
```

Physical device on the same Wi-Fi — use your machine's LAN IP (e.g. `http://192.168.1.42:8787`).

Production — deploy this service somewhere publicly reachable over HTTPS, then set `BACKEND_BASE_URL` to that origin.

## Rate limits

Each endpoint has a per-IP budget (60-second sliding window):

| Endpoint | Limit | Reason |
|---|---|---|
| `/api/geocode` | 120 req/min | High (debounced typing, multiple searches) |
| `/api/plans` | 40 req/min | Medium (one call per "Go" tap, plus retries) |
| `/api/route-shape` | 240 req/min | Cheap to serve; called per ride segment |

IPs are taken from `Fly-Client-IP` (Fly.io) or the first hop of `X-Forwarded-For`. Over-limit requests get `429 Too Many Requests` with a `Retry-After` header. Limits are in-memory (per instance) — if you scale out, move the buckets to a shared store.

## Deployment

### Fly.io (recommended)

One-time setup:

```bash
# Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth login

# From the backend repo root. This reads fly.toml; adjust the app name in fly.toml first
# (or pass --name). It will create the app without deploying.
fly launch --copy-config --no-deploy

# Set upstream API credentials (these become Fly secrets — never committed).
fly secrets set MAPBOX_TOKEN=pk.xxx WT_API_KEY=xxx
```

Deploy:

```bash
fly deploy
```

Verify:

```bash
curl https://<your-app>.fly.dev/healthz
curl "https://<your-app>.fly.dev/api/route-shape?route=BLUE&from=49.88,-97.19&to=49.90,-97.14"
fly logs    # should show "[gtfs] indexed 71 routes" within ~3 s of startup
```

Then update the mobile client:

```bash
cd ../BusTripPlanner
EXPO_PUBLIC_BACKEND_URL=https://<your-app>.fly.dev npx expo run:android --variant release
```

### VM sizing

`fly.toml` defaults to `shared-cpu-1x` with 256 MB RAM and `min_machines_running = 1` (always warm, no cold-start GTFS reloads). Drop to `min_machines_running = 0` to let the instance sleep when idle — saves cost but adds ~2 s to the first request after idle (the GTFS feed re-downloads on wake).

### Other hosts

The code is vanilla Node + Hono; it runs on any Node 20+ host:

- **Render / Railway** — auto-detect Node, run `npm run build && npm start`. Set env vars in the dashboard.
- **Cloudflare Workers** — requires code changes: swap `@hono/node-server` for the Workers adapter, replace the `setInterval` GTFS refresh with a Cron Trigger, move the GTFS index into KV (no persistent memory across invocations).
- **VPS** — run behind a reverse proxy (nginx / Caddy) with TLS, keep alive with systemd or PM2.

Whatever host you pick, set `MAPBOX_TOKEN`, `WT_API_KEY`, and (optionally) `CORS_ORIGINS` as environment variables / secrets — never commit real values.

## Caches

- **Geocode**: 10-minute in-memory cache keyed by lowercased query
- **Stop features (shelter)**: 7-day in-memory cache keyed by stop key — stops don't gain or lose shelters often
- **GTFS index**: held in memory for the lifetime of the process, refreshed every `GTFS_REFRESH_HOURS`

All caches are process-local. If you scale out to multiple instances, hit rates drop but correctness is unaffected.
