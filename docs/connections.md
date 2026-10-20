# Independent backend connections

Tracking: [app issue #25](https://github.com/pricezhang42/WinnipegBusTripPlanner-Custom/issues/25).

This repository owns SQL migrations and database management. Files were moved
without changing migration versions or SQL hashes. The app repository no longer
ships those tools or their development dependencies. No database changes happen
when selecting a profile, installing dependencies, or running unit tests.

Use Node 22+. Run `npm ci`, copy `.env.connections.example` to
`.env.connections.local` if it does not exist, and keep the local file ignored
with permissions `chmod 600 .env.connections.local`. The existing local operator
settings and recovery artifacts were copied from the app checkout; originals were
retained for recovery. Certificates still use their absolute paths. Old app
`db:*` commands were removed. qa1 is the existing hosted QA project; qa2 is an
unprovisioned placeholder, not an alias for qa1.

## Runtime and deployment

Database blocks define `<NAME>_SUPABASE_URL` and
`<NAME>_SUPABASE_PUBLISHABLE_KEY`. Server blocks define runtime overrides such as
`<NAME>_PORT`, `<NAME>_CORS_ORIGINS`, `<NAME>_WT_API_KEY`, `<NAME>_MAPBOX_TOKEN`
and deployment target `<NAME>_FLY_APP`. Unprefixed runtime defaults can remain
in `.env` or process environment. Process environment overrides local files.
Database names/project references/kind are registered in `supabase/environments.json`.

Choose server and database independently:

```sh
npm run dev -- --server local --database qa1
npm run dev -- --server local --database production --print
npm run start -- --server local --database qa2
npm run deploy -- --server qa1 --database production --print
npm run deploy -- --server qa1 --database production
```

`--print` validates configuration and prints only selected public metadata. It does
not start the API, stage secrets, deploy or connect to a database. qa1/qa2 server
blocks need their Fly app names and desired runtime settings filled first. Local
default port is 18787; Fly servers should use port 8787 to match `fly.toml`.

Deploy uses the selected existing Fly app, stages only the chosen runtime values
through `fly secrets import --stage` on stdin, then runs `fly deploy --app ...`.
Install/authenticate flyctl and provision the app separately. It never runs
migrations. If staging succeeds but deployment fails, the target app retains staged
secrets: review/retry that target before another deployment. A runtime setting
not configured locally is not removed from existing Fly secrets; explicitly manage
retired provider/path overrides with Fly's secret tools. Database passwords/admin
keys and unselected profile blocks are excluded from child API environments,
Docker context and deployed runtime values. Global upstream credentials can be
shared or overridden per server profile. Set server-specific values explicitly
when different deployments require different credentials.

Commands with no selectors retain the direct `.env`/host-environment runtime
workflow. Docker starts `dist/index.js` directly with hosting-provided variables;
it does not need local profile files, migrations, pg or the Supabase CLI.

The frontend chooses `--api` and `--auth` independently; no matching-name check
is imposed. Saved-data endpoints still validate users in the chosen database
project and forward their JWT with RLS. A user authenticated in another Supabase
project cannot access those endpoints. Independent configuration does not add
cross-project user mapping or replace the current security model.

## Database tools

`npm run db -- <command> --database <name>` selects an explicit registered
database. Public runtime settings alone cannot run migrations: operator commands
need `<NAME>_DATABASE_URL` and `<NAME>_DATABASE_CA_FILE`. TLS verification remains
enabled. Migration manifest checks are unchanged.

```sh
npm run db:check
npm run db -- status --database qa1
npm run db -- audit --database production
npm run db -- migrate --database qa1
npm run db -- migrate --database qa1 --apply --confirm-ref dvxkygiqnvvghkmqxhvk
npm run db -- test --database qa1 --api local
npm run db -- compare --qa-database qa1
npm run db -- migrate --database production --qa-database qa1
```

The test's `--api local` chooses `LOCAL_API_URL` independently of the database.
The server must accept that database's fixture-account tokens for tests to pass.
Passing promotion evidence is stored separately as `.database/qa1-verification.json`,
`.database/qa2-verification.json`, etc. Production apply also requires `--apply`,
its exact `--confirm-ref` and an explicit `--qa-database`; evidence must match the
selected project's reference, migration hashes, schema and PostgreSQL major, and
be no older than 24 hours. No QA evidence is inferred from a server name.

Register a second hosted QA database after creating it in Supabase:

```sh
npm run db -- register --database qa2 --project-ref YOUR_20_CHARACTER_REF
```

Then fill its own URL, public/admin keys, database URI and CA file in the local
profile. Registry references must be distinct. Only profiles marked `kind: qa`
can rebuild, seed, clean fixture users, change hosted Auth settings or receive
production refreshes. Renaming production or giving a QA profile its project
reference does not bypass these checks.

Read [hosted database management](hosted-database-management.md) for the full flow,
including the one-time production ledger reconciliation. See
[exact data refresh](exact-production-to-qa-copy.md) before replacing QA data.
