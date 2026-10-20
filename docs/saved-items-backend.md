# Saved items through the backend

Issue: https://github.com/pricezhang42/WinnipegBusTripPlanner-Custom/issues/17

The app signs in and refreshes sessions with Supabase Auth. Favorites and history
use the backend `/api/me/*` endpoints. The backend verifies each bearer access
token with `auth.getUser(token)` and creates a separate Supabase client for that
request, using the publishable key plus the same user token. Queries explicitly
filter by the verified user ID; PostgreSQL RLS remains enabled. No service-role
key, refresh token, database password, or client-supplied user ID is used.

## Setup and rollout

1. Follow the [versioned migration workflow](hosted-database-management.md) in
   this repository, including the production baseline review when applicable.
2. Configure named server/database blocks and start with
   `npm run dev -- --server local --database qa1`. For existing deployments,
   direct `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` remain supported.
3. Configure the app with independently chosen API/Auth profiles, for example
   `npm run android -- --api local --auth qa1`. Physical phones need a reachable
   LAN/HTTPS API profile. Saved-data requests require the selected Auth project
   to be compatible with the database project's user tokens; names are not coupled.
4. Set the server's CORS origins to the actual web origin. Preflight supports
   Authorization, Content-Type and DELETE.
5. Run checks, then deploy and verify the backend before releasing the app.
   Profile selection does not automatically deploy or apply migrations. See
   [connection/deployment commands](connections.md).

Old app builds remain compatible with the existing Supabase tables and function.
The new app has no fallback to direct table access if the backend is unavailable.
Unauthenticated trip planning and geocoding remain public.

## API contract

All paths below start with `/api/me`; all require `Authorization: Bearer <access-token>`.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/saved-items` | `{locations: Location[], favorites: SavedTrip[], history: SavedTrip[]}` |
| POST | `/favorite-locations` | `{location: Location}` |
| DELETE | `/favorite-locations/:key` | URL-encoded exact coordinate key |
| POST | `/favorite-trips` | `{origin: Location, destination: Location}` |
| DELETE | `/favorite-trips/:key` | URL-encoded exact origin/destination key |
| POST | `/trip-history` | `{origin: Location, destination: Location}` |
| DELETE | `/trip-history/:id` | Positive database history ID |

`Location` is `{id, place_name, geometry: {coordinates: [longitude, latitude]}}`.
`SavedTrip` contains origin, destination, created_at, trip_key, and (for history)
id. User IDs are excluded from list responses. Writes return 204, including
repeated deletion of absent items. History deletion returns removed IDs internally;
when none are returned, the backend checks whether the owned row is still visible.
If it remains, it returns 403 rather than reporting success. Favorite saves upsert existing keys. Names are
limited to 2048 characters, IDs to 512, and request bodies to 16 KiB. Coordinates
must be finite and within longitude/latitude bounds. Unexpected top-level fields,
including user_id, are rejected. Additional geocoder properties are stripped.

Favorites retain exact coordinate identities (`lon,lat` and
`originLon,originLat>destinationLon,destinationLat`). History still uses the
SQL function's four-decimal coordinate keys. It locks per user, upserts a
replanned trip to the top, and trims to 10 distinct trips atomically.
`record_planned_trip` is SECURITY DEFINER: its explicit auth.uid() check, per-user
queries, empty search_path and restricted execute grants remain essential.

Failures return `{error: {code, message}}` for saved-data validation, auth, and
service errors: 400 invalid input, 401 invalid/missing credentials, 403 blocked history deletion, 413 oversized
body, 503 authentication/database unavailable. The existing IP limiter allows
120 requests/minute/instance and returns its standard 429 `{error, retryAfter}`
response with Retry-After. Saved-data responses use Cache-Control: no-store.
Saved-item request URLs (which contain coordinate keys), tokens and payloads are
not logged by the application.

## Session and failure behavior

The API client gets the current session before each request and checks it against
the initiating account. A 401 can refresh the session once and retry with the
new access token. Concurrent rejected requests share the refresh. No network,
service-error, or timeout retry is performed automatically for writes because the
original write may have succeeded. A request times out after 25 seconds; backend
Supabase calls have 8-second timeouts and automatic database retries are disabled.

The hook hides personal lists immediately on account changes, cancels reads, and
uses account epochs plus request generations to reject stale results, including
sign-out and sign-in to the same account. Pending writes cannot refresh another
account's lists or clear that account's busy state. A history-save failure reports
that the trip was found but history could not be saved; it does not discard plans.

## Verification

App:

```sh
npx jest --runInBand --watchAll=false
npx tsc --noEmit
```

The existing Map/nap-alarm TypeScript errors are unrelated to this migration.
The existing StyledText test has no committed snapshot, so a full CI-mode Jest
run fails that snapshot check. The other 15 suites (51 tests) pass in CI mode;
the four focused saved-data suites contain 18 passing tests. No unrelated
snapshot is added by this migration.
Backend:

```sh
npm run typecheck
npm run build
node --import tsx --test src/*.test.ts src/gtfs/*.test.ts
```

The backend unit tests exercise the actual Supabase client against a simulated
Auth/Data API. They verify token forwarding, ownership filters, validation,
concurrency and response behavior; they do not establish live database RLS.

For live API/RLS verification, the backend includes `npm run check:saved-items`.
Supply `SAVED_ITEMS_TEST_BACKEND_URL`, two valid access tokens as
`SAVED_ITEMS_TEST_TOKEN_A` and `SAVED_ITEMS_TEST_TOKEN_B`, the backend Supabase
settings, and explicitly set `SAVED_ITEMS_TEST_DISPOSABLE=1`. Use two empty,
disposable accounts on a test project with the three migrations applied.
The script refuses nonempty accounts before writing. It checks cross-account
access through the backend and direct Data API, ownership forgery, duplicate
favorites, the 10-trip limit and replanning order, then removes its fixtures.
Do not commit tokens or put them in shell command history.

This architecture routes the app through the backend but does not disable the
Supabase Data API. Authenticated users can still call exposed tables/functions,
subject to database policies, grants and constraints. It does not make backend
validation a database-wide invariant or change the RLS boundary.


## History entry remains after Delete

A Supabase DELETE can affect zero rows without an error when no applicable RLS
DELETE policy exists. Earlier backend code treated that response as success.
The backend now verifies zero-row history deletes and reports
`history_delete_not_allowed` (403) when the user's visible row survives.
A missing DELETE grant (Postgres code 42501) is reported the same way. An absent
or another user's ID still returns 204 without revealing its existence.

Inspect the target project's metadata in the Supabase SQL Editor (read-only):

```sql
select
  has_table_privilege('authenticated', 'public.trip_history', 'DELETE') as delete_granted,
  (select jsonb_agg(jsonb_build_object('command', cmd, 'roles', roles, 'condition', qual))
   from pg_policies
   where schemaname = 'public' and tablename = 'trip_history') as policies;
```

The authenticated role needs DELETE permission and an applicable policy such as
`delete_own_history` with `user_id = auth.uid()` for DELETE. Apply
`supabase/migrations/202610200001_restore_history_delete_policy.sql` to repair
those specific permissions. It can be rerun without deleting any history rows,
uses the existing ownership rule, and does not disable RLS. Then retry deleting
one chosen entry in the app and refresh the list. Deploy/restart the updated
backend and reload the app for the improved error handling.

The migration file is prepared in Git; creating it does not apply it to a hosted
project. Inspecting or applying it requires database-admin access, not the
publishable key used by the backend.
