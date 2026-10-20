# Hosted database management

Run these commands from the backend repository. Start with
[connection profiles](connections.md) to configure the ignored `.env.local`.
No local Supabase instance is needed. Migration SQL lives in `supabase/migrations/`;
`supabase/migrations.lock.json` prevents editing/removing registered migrations.

## Production baseline

The reviewed production baseline is recorded in [the audit](../supabase/baseline/README.md).
Production's missing migration ledger must be reconciled before its first migration
deployment. Re-audit current production before marking anything applied:

```sh
npm run db -- audit --database production
```

The prior review found effects equivalent to versions 202609250001, 202609260001,
202609260002 and 202610200001. Migration 202610200002 was NOT applied. After
confirming that state is still current, record only the existing four versions:

```sh
node --input-type=module <<'JS'
import { loadSettings, target, supabase } from './scripts/database/core.mjs';
const settings = await loadSettings();
console.log(await supabase(['migration', 'repair', '--status', 'applied',
  '202609250001', '202609260001', '202609260002', '202610200001'],
  target(settings, 'production')));
JS
npm run db -- status --database production
```

Repair writes ledger metadata without rerunning those migrations. It is a manual,
reviewed baseline operation; deployment tools never automatically repair history
or replay old SQL over existing tables. It does not prove when old scripts ran.
Do not mark pending migration 202610200002 applied until its SQL actually runs.

## Schema development

1. Create a migration with `npx supabase migration new describe_change`; edit SQL
   for tables, backfills, grants and RLS. Keep existing migration files unchanged.
2. Run `npm run db:manifest`, `npm run db:check` and the tooling tests.
3. Preview and apply to the explicitly selected QA project:

   ```sh
   npm run db -- migrate --database qa1
   npm run db -- migrate --database qa1 --apply --confirm-ref dvxkygiqnvvghkmqxhvk
   npm run db -- audit --database qa1
   ```

4. Start a backend against that database, then test it in another terminal:

   ```sh
   npm run dev -- --server local --database qa1
   npm run db -- test --database qa1 --api local
   ```

   The live checker creates two tagged empty accounts, tests authenticated APIs,
   ownership isolation, deduplication, history pruning/deletion, then removes its
   own accounts. It requires QA's admin key, never the production admin key. It
   cannot certify future backfills or arbitrary schema changes; add relevant checks.
5. Test the frontend with independent API/Auth selection. Commit SQL, manifest,
   code and checks in a PR. Merging does not deploy or migrate any database.
6. After review and baseline reconciliation, deploy the same SQL to production:

   ```sh
   npm run db -- migrate --database production --qa-database qa1
   npm run db -- migrate --database production --qa-database qa1 --apply --confirm-ref rshgohxdntjglnqilyls
   npm run db -- audit --database production
   ```

   Production requires recent passing evidence from the selected QA project,
   exact migration hashes, unchanged QA schema and matching PostgreSQL major.

If QA was edited in the Dashboard, capture the exact changes as SQL first. Verify
all effects before reconciling its ledger; do not blindly run the same SQL twice.
Prefer additive nullable columns, backfills and later cleanup to keep older app
versions compatible. Deployment/rollback decisions remain separate from data refresh.

## QA lifecycle

Each command defaults to preview where documented; mutations require `--apply`
and the selected QA project's exact `--confirm-ref` (live tests create/remove their
own disposable fixtures as part of the command).

```sh
npm run db -- rebuild --database qa1
npm run db -- auth --database qa1
npm run db -- auth-audit --database production
npm run db -- seed --database qa1
npm run db -- cleanup --database qa1 --accounts .database/RUN_MANIFEST.json
npm run db -- compare --qa-database qa1
```

- Rebuild uses the hosted QA reset with seed disabled. Review before applying.
- Auth preview reads allowlisted hosted settings; apply is QA-only and uses the
  versioned `supabase/qa-auth.json`. `SUPABASE_ACCESS_TOKEN` is required.
- Seed creates persistent tagged synthetic accounts; credentials stay in a private
  ignored account manifest. Cleanup checks project/run ownership before deletion.
- Private reports/recovery files remain under ignored `.database/` with restrictive
  permissions. Do not upload or commit them.
- Production-to-QA data refresh includes original Auth accounts/password hashes;
  it has separate replacement/quiescence acknowledgements, compatibility checks,
  backup, recovery and cleanup. Follow [the full runbook](exact-production-to-qa-copy.md).
  Refresh before introducing schema differences, since selected table structures
  must match. Source access is read-only; only an explicitly registered QA can be replaced.

Tool prerequisites: Node 22+, `npm ci`; native PostgreSQL 17 clients are needed only
for exact refresh/recovery. Set `DATABASE_PG_BIN` when not on PATH. Database URLs
must use direct/session endpoints on port 5432 with verified TLS; use the CA from
Supabase's database settings. Do not weaken TLS or use transaction-pooler port 6543.
