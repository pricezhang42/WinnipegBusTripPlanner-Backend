# BusTripPlanner Backend

Proxy + enrichment layer for the [Winnipeg Bus Trip Planner](https://github.com/pricezhang42/BusTripPlanner) mobile app. Hides upstream API keys from the client, batches N+1 calls, and serves bus-route polylines from the Winnipeg Transit GTFS feed.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe |
| GET | `/api/geocode?q=<text>` | Mapbox geocoding autocomplete (Canada, biased to Winnipeg) |
| GET | `/api/plans?origin=&destination=&date=&time=&mode=` | Winnipeg Transit trip-planner + shelter info for every stop, with each ride's reliability and drawn line (`path`), merged into one payload |
| GET | `/api/route-shape?route=<key>&from=<lat,lng>&to=<lat,lng>` | **Legacy**, kept for app releases before September 27, 2026. Polyline by nearest-line coordinate matching. The current app uses `path` in `/api/plans` instead. |

### `/api/plans` response shape

```json
{
  "plans": [ /* Winnipeg Transit trip-planner plans; each ride segment also gets `reliability`, `passupReports`, `passupRisk` and, when matched, `path` */ ],
  "shelters": {
    "10064": "Heated Shelter",
    "10073": "Unsheltered"
  }
}
```

`shelters` maps `stop.key` → shelter type. One of `Heated Shelter`, `Unheated Shelter`, `Unsheltered`.

Each ride's `path` is `[[lat, lng], ...]` along the route's GTFS line from the boarding stop to the exit stop. The boarding stop is the `to.stop` of the segment before the ride (walk or transfer) and the exit stop is the `from.stop` of the segment after it. GTFS stop IDs are the same keys the Winnipeg Transit API uses, and every GTFS shape has one fixed stop list (from `stop_times.txt`). So the backend picks a shape of that route that serves the boarding stop and then the exit stop, in that order, and cuts its line between them. That determines direction and branch exactly, including loops. If two adjacent stops land on the same line point, the path is a straight line between them. A ride with no match has no `path`, and the app draws a straight line between its stops. Checked on 2,940 sampled stop pairs across every shape: all got a path.

### Historical reliability contract

Historical timing describes observed departures, not live predictions or arrivals.
`src/reliability.ts` resolves boarding context and orchestrates enrichment;
`src/reliabilityTime.ts` owns Winnipeg date conversion, two-hour windows and date
eligibility. Enrichment resolves each ride's boarding context once and passes it
to independent timing and report readers. The timing reader has no pass-up
policy dependency; the legacy nested category is attached only at the API
boundary for older clients. Both timing and report evidence match exact route, boarding stop,
normalized destination, weekday/weekend and even starting hour; seasons are pooled.
Variant IDs are resolved through `data/reliability-destinations.json`, a reviewed
same-route lookup generated from official variant metadata and validated against
historical destination keys. This handles mismatched display prefixes and missing
or additional branch text without fuzzy matching or stripping every `via` suffix.
Established exact-name fallbacks still work when metadata is absent.

Each ride gets independent timing, report evidence and category fields:

- `reliability`: `{status: "available", ...statistics, passupRisk, hour,
  windowMinutes, dayType, boardingStop, destination}` or
  `{status: "unavailable", reason}`. Statistics require 30 observations across
  5 dates, ordered finite quantiles, valid shares/intervals and valid coverage.
  The stored statistics are not recalculated by the API.
- `passupReports`: evidence-only schema-3 response, independent of timing sample
  minimums. Available fields are `reportCount`, `reportDates`, report
  `coverageStart`/`coverageEnd`, `recordedDepartures`, `departureDates`,
  `referenceCoverageStart`/`referenceCoverageEnd` and `profiles` keyed by
  `60m`, `100m`, `150m` (each with `reports` and `reportDates`). It also names
  `evidenceUnit: "unique-report-id"`, `groupTimeBasis: "reported-local-time"`,
  `referenceTimeBasis: "scheduled-local-time"` and
  `labelStatus: "approved"` and `policyVersion: "report-scheduled-visit-ratio-v1"`. Missing evidence returns
  `{status: "unavailable", reason}`. Missing groups are not zero-report groups.

- `passupRisk`: `{level, basis, policyVersion}` from the approved report policy,
  independently of timing. New clients prefer it over the nested legacy category.
  Missing/incompatible evidence produces an explicit Unknown with the reason in
  `basis`; it must not fall back to an older category.

Policy `report-scheduled-visit-ratio-v1` uses unique 150 m full-bus reports divided
by cleaned recorded visits in the corresponding scheduled-time group. The count
is not the full GTFS schedule. Reports are grouped by report time; reference
visits by scheduled time. Exact route/stop/destination/day type/two-hour grouping
is shared; seasons are pooled. There is no +50 penalty.

| Category | Rule after requiring 60 visits on 10 dates |
|---|---|
| Low | Ratio below 1%; zero reports need at least 120 visits |
| Medium | Ratio at least 1% and below 2.5%, reports on at least 2 dates |
| High | Ratio at least 2.5%, reports on at least 3 dates |
| Unknown | Insufficient evidence/persistence, incompatible data, or reports exceeding visits |

`src/passupReportRisk.ts` implements these rules. Report dates are counted, not
matched bus visits. Multiple IDs can describe one bus; report-only groups remain
valid evidence but cannot produce a category with a zero denominator. These are
descriptive categories, not probabilities. The 60 m and 100 m profiles remain
in the evidence for auditing; category agreement is not required.

`src/passupRisk.ts`, the existing visit-based files and
`reliability.passupRisk` remain for older clients during migration. They do not
feed the new report category. Existing departure statistics remain unchanged.

The installed evidence covers 72 routes and 93,609 groups: 70,428 Low, 161 Medium,
35 High, 22,985 Unknown. The artifact cutoff remains September 24, 2026. Complete
report manifests and route shards are included in `data/`; hosted deployment is
separate from this code/artifact update.

Timing reasons: `data_unavailable`, `route_without_history`,
`boarding_context_missing`, `data_outdated`, `historical_date_unsupported`,
`holiday_calendar_unsupported`, `insufficient_comparable_history`. Report evidence
also uses `incompatible_report_evidence`, `source_mismatch` and
`report_group_without_history`. Either enrichment can fail without blocking plans.
Trip dates on/before the cutoff are unsupported; artifact age and trip horizon
must be at most 30 days. The current holiday calendar supports 2026 only.

Artifacts default to `data/reliability.json`, `data/passup-risk.json` and
`data/passup-report-counts.json`. Override these with `RELIABILITY_DATA_PATH`,
`PASSUP_RISK_DATA_PATH` and `PASSUP_REPORT_DATA_PATH`. Install each manifest with
all referenced route shards, preserving relative paths, and restart the process:
manifests and shard caches do not reload automatically. Report evidence requires
schema 3, `stop-report-counts-v1`, `nearest-stop-report-time-v1`, the documented
time bases, `labelStatus: approved`, the exact supported policy definition and a
departure-source hash matching timing when timing provides one. Missing report
files produce unavailable evidence and an Unknown report category.

### SQLite reliability store

The same datasets can be served from one versioned SQLite file instead of the JSON
manifests and shards (issue #8). Set `RELIABILITY_STORE_PATH` to the file; when it
is set, the JSON paths above are ignored. Departures, report counts, legacy risk and
destination aliases are all in that one file, so a deployment cannot mix versions.
A store that is missing, corrupt or of another schema version makes every ride's
evidence `data_unavailable` (the plan itself is still returned); it never falls back
to JSON.

```bash
npm run reliability:store -- build            # data/ -> .reliability/reliability-<sha256>.sqlite
npm run reliability:store -- verify FILE      # every group in FILE equals data/
npm run reliability:parity -- FILE            # API output, ride by ride, JSON vs FILE
```

`build` validates every manifest with the backend's own loaders, rejects datasets
with different departure-source hashes, writes typed tables
(`departure_groups`, `passup_report_groups`, `passup_legacy_groups`, keyed by route,
boarding stop, destination, day type and window start hour), then re-reads every
group and requires an exact match before naming the file by its SHA-256. The same
inputs produce the same file on the same Node/SQLite version; across machines the
file hash can differ, so `build.inputSha256` identifies the data. `meta` holds each manifest without groups,
the destination lookup and `build` (`inputSha256` and row counts). Requires Node
22.13 or later (`node:sqlite`; Node prints an experimental-feature warning).

#### Publishing, deploying and rolling back a store

Store files live in GitHub Releases on this repository, not in git. The committed
`reliability-store.lock.json` pins one by SHA-256 and download URL.

```bash
npm run reliability:store -- build
npm run reliability:store -- publish .reliability/reliability-<sha>.sqlite   # the file build printed; needs gh auth
git add reliability-store.lock.json   # commit and open a PR: merging it publishes
```

`publish` re-verifies the file against `data/` (while the JSON is still committed),
creates release `reliability-<sha16>` with the file as its asset (re-running reuses
it; it is never marked as the latest release) and rewrites the lock. The Docker build
runs `scripts/fetch-reliability-store.mjs`, which downloads the pinned file to
`/app/reliability/reliability.sqlite` and fails the build on any hash mismatch; with
no lock file it does nothing. The store is served only on servers whose profile sets
`<SERVER>_RELIABILITY_STORE_PATH=/app/reliability/reliability.sqlite`, staged by
`npm run deploy`. To roll back, revert the lock commit and redeploy (every earlier
release stays downloadable); while the JSON is still bundled, removing that setting
and running `fly secrets unset RELIABILITY_STORE_PATH --app <app>` (deploys stage
settings as Fly secrets, which a later deploy does not remove) returns the server to
the JSON artifacts. Locally,
`node scripts/fetch-reliability-store.mjs` puts the pinned file at
`reliability/reliability.sqlite`.

Data builds and audits belong to the
[analysis repository](https://github.com/pricezhang42/Winnipeg-Transit-Data-Analysis/blob/main/HISTORICAL_DATA.md).
No database migration is needed. Check with `npm run build` and
`node --import tsx --test src/*.test.ts src/gtfs/*.test.ts`.

### Verify a running backend

A successful health probe alone does not prove the reliability features are
deployed. Run the read-only sample-trip contract check:

```bash
npm run check:reliability -- --base-url http://localhost:8787
npm run check:reliability -- --base-url https://bustripplanner-backend.fly.dev
```

The check uses Westbrook → Thatcher at 16:40 on today's Winnipeg date. Override
with `--date YYYY-MM-DD --time HH:MM` to reproduce a specific search. It checks
health and each ride's timing/report availability states, unavailable reasons,
category and policy version, returning a nonzero exit code for a missing or
incompatible contract. It reports available counts and unavailable timing reasons.
An unavailable estimate is valid when its reason is explicit; stale history,
unsupported dates and sparse groups must not masquerade as successful estimates.
The checker does not change or deploy anything and needs no private credentials.

### Destination metadata and refresh

`src/reliabilityDestinations.ts` resolves one canonical destination for both timing
and report evidence. The committed lookup covers the October 18 audit: 185
variants across 72 routes, correcting 59 mismatches across 26 routes. Entries are
scoped to a route and variant ID; the default display name and canonical name are
recorded as accepted aliases. Known IDs with unexpected new display text return
`destination_variant_changed` rather than borrowing another branch. Exact
route-prefix/bare-destination cases remain supported, including `to St. Norbert`.

Additional internal reasons are `destination_variant_route_mismatch`,
`destination_variant_unknown` and `destination_metadata_missing`. These appear in
the timing unavailable reason and independent report-risk basis. Metadata failure
never blocks trip plans. Missing history or insufficient samples stays unavailable
regardless of successful name resolution.

To refresh in a development checkout with installed dependencies:

```bash
npm run refresh:destinations
```

The command uses the local `WT_API_KEY` and the configured timing/report manifests
(`RELIABILITY_DATA_PATH`, `PASSUP_REPORT_DATA_PATH`, or their defaults in `data/`).
It reads declared variants from the Routes API, fetches default and long-usage variant
names with three route workers, filters wildcard siblings by exact declared ID,
and queries exact IDs when wildcard results omit them. Missing canonical names
may use an established exact display fallback only when it exists in same-route
history. Unsupported destinations, duplicate identities, source mismatches or API
failures abort before installation. A complete validated file is written atomically;
no partial network result replaces the lookup. Credentials/credential-bearing URLs
are not logged.

Review the resulting file and rerun tests before shipping it. Refresh alongside
historical artifacts and when route/variant definitions change; the source hash
records the departure data used for validation. It does not extend that data's
freshness cutoff. `RELIABILITY_DESTINATIONS_PATH` overrides the lookup location.
The server loads it once at startup and makes no destination-metadata calls per
ride; restart/redeploy after replacing it. The refresh tool runs in the checkout,
not the production image, which needs only the prebuilt lookup in `data/`.

Regression example: October 19 at 16:40, Westbrook → Thatcher, route 678 boarding
60185 resolves to `freedman terminal` and returns 37 observations/11 dates,
57% not on time. Route 679 resolves the same destination but retains its unavailable
state (2 reference visits/1 date). Valid branch names such as
`creek bend via burland` are preserved.

### `/api/route-shape` response shape (legacy)

Still served so older app builds keep drawing routes; remove it once those builds are retired.

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
cp .env.example .env.local
# Fill in MAPBOX_TOKEN, WT_API_KEY and the selected QA1 public connection settings
npm install
npm run dev
```

The example selects the local server on `http://localhost:18787` and database qa1. Set its publishable key in `.env.local`; CLI flags override either default independently.

On startup the GTFS feed (`https://gtfs.winnipegtransit.com/google_transit.zip`, ~4 MB) is downloaded, parsed, and indexed in memory: `shapes.txt`, `trips.txt`, `stops.txt`, and `stop_times.txt`. Only one stop list per shape is kept from `stop_times.txt`. Indexing takes about 1.7 s (+0.2 s for the stop lists). Retained memory is ~8 MB, and peak memory during load is ~135 MB (previously ~112 MB), within the 256 MB Fly machine. The feed is re-downloaded every `GTFS_REFRESH_HOURS` (default 24).

## Connecting the mobile client

Android emulator — `10.0.2.2` maps to the host's localhost:

```sh
# In the app repository:
npm run android -- --api local --auth qa1
```

Physical device on the same Wi-Fi — use your machine's LAN IP (e.g. `http://192.168.1.42:8787`).

Production — deploy this service somewhere publicly reachable over HTTPS, then set `BACKEND_BASE_URL` to that origin.

## Rate limits

Each endpoint has a per-IP budget (60-second sliding window):

| Endpoint | Limit | Reason |
|---|---|---|
| `/api/geocode` | 120 req/min | High (debounced typing, multiple searches) |
| `/api/plans` | 40 req/min | Medium (one call per "Go" tap, plus retries) |
| `/api/route-shape` | 240 req/min | Cheap to serve; called per ride segment by older app builds (legacy) |

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
cd ../WinnipegBusTripPlanner-Custom
npm run android -- --api production --auth production --variant release
```

### VM sizing

`fly.toml` defaults to `shared-cpu-1x` with 256 MB RAM and `min_machines_running = 1` (always warm, no cold-start GTFS reloads). Drop to `min_machines_running = 0` to let the instance sleep when idle — saves cost but adds ~2 s to the first request after idle (the GTFS feed re-downloads on wake).

### Other hosts

The code is vanilla Node + Hono; it runs on any Node 22+ host:

- **Render / Railway** — auto-detect Node, run `npm run build && npm start`. Set env vars in the dashboard.
- **Cloudflare Workers** — requires code changes: swap `@hono/node-server` for the Workers adapter, replace the `setInterval` GTFS refresh with a Cron Trigger, move the GTFS index into KV (no persistent memory across invocations).
- **VPS** — run behind a reverse proxy (nginx / Caddy) with TLS, keep alive with systemd or PM2.

Whatever host you pick, set `MAPBOX_TOKEN`, `WT_API_KEY`, and (optionally) `CORS_ORIGINS` as environment variables / secrets — never commit real values.

## Caches

- **Geocode**: 10-minute in-memory cache keyed by lowercased query
- **Stop features (shelter)**: 7-day in-memory cache keyed by stop key — stops don't gain or lose shelters often
- **GTFS index**: held in memory for the lifetime of the process, refreshed every `GTFS_REFRESH_HOURS`

All caches are process-local. If you scale out to multiple instances, hit rates drop but correctness is unaffected.

## Authenticated favorites and history

`/api/me/*` verifies the Supabase bearer access token with Auth and uses an
isolated client carrying the same user JWT for database queries. Keep RLS and
the SQL migrations in this repository. Set `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` to the app's project (publishable or legacy anon key;
never service-role). The Supabase dependency and Docker images require Node 22+.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/me/saved-items` | Favorite locations, favorite trips, latest 10 distinct trips |
| POST | `/api/me/favorite-locations` | Upsert `{location}` |
| DELETE | `/api/me/favorite-locations/:key` | Delete own URL-encoded coordinate key |
| POST | `/api/me/favorite-trips` | Upsert `{origin,destination}` |
| DELETE | `/api/me/favorite-trips/:key` | Delete own URL-encoded trip key |
| POST | `/api/me/trip-history` | Record `{origin,destination}` through atomic history RPC |
| DELETE | `/api/me/trip-history/:id` | Delete own history ID |

Writes return 204. History deletes verify that an owned row did not survive
a zero-row DELETE; a missing policy or DELETE grant returns
`history_delete_not_allowed` (403). Apply the migration in this repository
`202610200001_restore_history_delete_policy.sql` if those permissions need repair. Lists exclude user IDs. Errors are 400/401/403/413/503 with an
`error: {code,message}` envelope; the existing per-IP limiter returns standard
429 responses (120 requests/minute/instance). All saved responses use no-store.
Request logs omit `/api/me` paths because deletion keys contain coordinates.
Auth and database calls time out after 8 seconds; database retries are disabled.
CORS accepts bearer Authorization and DELETE. The public transit routes keep
their existing behavior.

Deploy these endpoints and configure Supabase before releasing the app update.
There is no new database schema migration or data conversion. The Data API stays
exposed under existing RLS/grants; routing mobile requests through this backend
does not prevent authenticated callers from using the Data API directly.

Checks:

```sh
npm run typecheck
npm run build
node --import tsx --test src/*.test.ts src/gtfs/*.test.ts
```

`npm run check:saved-items` is an opt-in live integration check. Set
`SAVED_ITEMS_TEST_BACKEND_URL`, `SAVED_ITEMS_TEST_TOKEN_A/B` (access tokens for two
empty disposable accounts), the Supabase settings, and
`SAVED_ITEMS_TEST_DISPOSABLE=1`. It verifies real RLS, cross-account isolation,
forged ownership, favorite deduplication and latest-10-distinct history, then
cleans its fixtures. It refuses nonempty accounts before writing. Use a test
project with all registered SQL migrations and do not commit tokens.

Detailed contract: [saved-data API](docs/saved-items-backend.md).

## Connection profiles and database ownership

This repository owns `supabase/migrations/` and `scripts/database/`. Configure
`.env.local` using [the example](.env.example), then
choose server/deployment and database separately:

```sh
npm run dev -- --server local --database qa1
npm run deploy -- --server qa1 --database production --print
npm run db -- status --database qa1
```

See [independent connections](docs/connections.md),
[hosted database management](docs/hosted-database-management.md) and
[exact production-to-QA refresh](docs/exact-production-to-qa-copy.md).
