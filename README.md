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

## Deployment

The code is a vanilla Node + Hono server. It runs on any Node 20+ host:

- **Fly.io / Render / Railway** — `npm run build && npm start`
- **Cloudflare Workers** — swap `@hono/node-server` for the Workers adapter and replace the `setInterval` GTFS refresh with a Cron Trigger
- **VPS** — run behind a reverse proxy (nginx / Caddy) with TLS

Whatever host you pick, set `MAPBOX_TOKEN`, `WT_API_KEY`, and `CORS_ORIGINS` as environment variables.

## Caches

- **Geocode**: 10-minute in-memory cache keyed by lowercased query
- **Stop features (shelter)**: 7-day in-memory cache keyed by stop key — stops don't gain or lose shelters often
- **GTFS index**: held in memory for the lifetime of the process, refreshed every `GTFS_REFRESH_HOURS`

All caches are process-local. If you scale out to multiple instances, hit rates drop but correctness is unaffected.
