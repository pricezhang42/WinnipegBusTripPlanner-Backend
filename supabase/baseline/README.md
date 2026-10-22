# Production baseline review

Tracking: https://github.com/pricezhang42/WinnipegBusTripPlanner-Custom/issues/21

Status: **production SQL/Auth audit and initial hosted QA verification completed
October 20, 2026; production baseline ledger reconciliation pending**. No production
migration history has been marked applied and no production schema/data changes
have been performed by the management tools. QA has its own recorded migrations.

Verified TLS succeeded after configuring the locally downloaded production root
certificate. The private report is `.database/production-audit-1792481066902.json`.
Its SHA-256 is `5765158b3f06410222947493a61188087ada5baf15f75f8fb43d4962011586b0`;
catalog SHA-256 is `41888739e068cd312537cba3b09efbe0ae02ba1f854e56ee3f47eed2237aee86`.
Production runs PostgreSQL **17.6**. No application/Auth rows were read or copied.

## Findings and migration evidence

`supabase_migrations.schema_migrations` does **not** exist. The application tables
already exist, so replaying the original CREATE TABLE migrations would fail.
The deployment wrapper correctly blocks that case. No versions were marked applied.

| Migration | Observed production state |
| --- | --- |
| `202609250001` | All three tables, required types/nullability/defaults, JSON object checks, primary/Auth foreign keys, recent-history index, RLS and ownership policies present; expected authenticated table grants present. The history function has since been replaced as expected by the next migration. |
| `202609260001` | Non-null history `trip_key`, unique `(user_id, trip_key)`, helper signature/body and replacement history function signature/body match. Both functions use an empty search path; only `record_planned_trip` is SECURITY DEFINER. The catalog confirms final schema, not historical row cleanup or past execution. |
| `202609260002` | Authenticated DELETE grant and `delete_own_history` ownership policy present. |
| `202610200001` | Same deletion-repair effects present; the catalog cannot establish which of the two deletion scripts was actually run. |
| `202610200002` | New, unapplied correction prepared after this audit: remove explicit anon/PUBLIC EXECUTE on the two app functions. |

The two automatic findings are explicit **anon EXECUTE** grants on
`record_planned_trip` and `trip_point_key`. PUBLIC is already revoked. Existing
migrations revoke PUBLIC but do not revoke explicit anon privileges granted by
the hosted default ACLs. The history function checks `auth.uid()` before writing;
this finding alone is not evidence that anonymous callers can write history.
The new migration removes the unnecessary access without altering platform-wide
defaults. It has **not** been applied to production.

No non-internal table triggers were found. Production also has a
`public.rls_auto_enable()` event-trigger function outside the app migrations; its
ownership/configuration and the related event trigger need platform review before
claiming full project parity. Platform extensions are pg_stat_statements 1.11,
pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1 and uuid-ossp 1.1.

Remaining: review/reconcile the production baseline ledger explicitly and review
platform settings outside this audit's scope. The SQL catalog review does not
approve deployment or certify full hosted-project parity.

## Hosted QA verification

Dedicated QA project: `dvxkygiqnvvghkmqxhvk`, PostgreSQL **17.11** (same major as
production). It began without application tables or a migration ledger. All five
migrations were applied successfully through the pinned Supabase CLI; the ledger
now lists all five, with no pending/unknown versions and no application-contract
findings. No production accounts/data were copied.

QA audit: `.database/qa-audit-1792482663876.json`, SHA-256
`35abf379a9c3e03f52c6b312f5a631fcaa6fbea74a0edcd2fad442305b4b9f92`.
Verification report: `.database/qa-verification-11cb53a9-b564-402e-873c-a19426b5d38c.json`,
SHA-256 `221a2129f53ebc4d39b1a3601b69ba52e870f0fe764f3b9314b32a0139f5a887`.
QA catalog SHA-256:
`b598f576cc2d70edd760c910717466c7c9aa2360afc69f82dbe62631d8c862ef`.
Local promotion evidence expires after 24 hours and must be regenerated for later
deployment; committed hashes are historical evidence, not deployment credentials.

The backend ran separately on local port 18787 with QA URL/public key only. Live
checks passed for favorites/deduplication, ownership forgery and cross-account RLS,
history deletion, ten distinct trips, replanning order, and concurrent writes.
Both generated accounts and their saved rows were removed successfully before the
passing report was written. The temporary backend was stopped afterward.

Production/QA catalog comparison differs only in `functions`/`functionGrants`:
production retains the extra `rls_auto_enable` platform function and the app anon
grants corrected in QA. Other exported catalog sections match. Full platform
event-trigger/provider/SMTP/Storage/network parity is not established.

Production Auth configuration was read through the Management API: site URL
`http://localhost:3000`, callback `bustripplanner://auth/callback`, email signup and
confirmation enabled, signup allowed, minimum password length 6. QA successfully
received the versioned `qa-auth.json` settings: development site URL on port 8081,
an empty redirect allowlist (the app has no email-link screen), and minimum password length 8. These
are documented QA-specific differences; production Auth was not modified.

`qa-auth.json` also sets a 6-digit email OTP and a Confirm signup template that
shows only `{{ .Token }}` with no link: the app confirms signup with `verifyOtp`
type `email`. The Reset Password template also shows only `{{ .Token }}`: the app
resets passwords with `verifyOtp` type `recovery`. Neither email has a link, so no
callback URLs are allowlisted.
Production needs the same settings applied in the Dashboard (Authentication →
Providers → Email → Email OTP Length, and Authentication → Email Templates →
Confirm signup and Reset Password).

Initial creation and the live integration path are verified. The destructive
remote-reset command, persistent manual seed workflow, populated-schema upgrades,
and emulator email/recovery flows have not been exercised in this run.

## Repository inventory

The original four migrations define the application's three public tables, ownership policies,
grants, two SQL/PLpgSQL functions and distinct-trip history behavior. Their byte
hashes are in `../migrations.lock.json`. Existing SQL files were historically
applied manually in the Dashboard, so file presence is not proof of remote state.

The user supplied this production metadata on October 20, 2026:

- `has_table_privilege('authenticated','public.trip_history','DELETE') = false`
- Only the own-history SELECT policy was present on `trip_history`.

The repeatable permission repair is in migration
`202610200001_restore_history_delete_policy.sql` (app PR #20). The user was given
repair SQL. The new audit now confirms the grant and ownership policy are present;
it does not prove which deletion migration was executed. Ledger reconciliation
must describe observed equivalent effects rather than invent execution history.

## Audit and review procedure

1. Set `PRODUCTION_DATABASE_URL` in ignored `.env.connections.local`.
2. Run `npm run db -- audit --database production`. Review the private JSON catalog under
   `.database/`. It contains metadata/function definitions but no table rows.
3. Compare tables/columns/defaults/constraints/indexes, ownership policies and
   grants, function bodies/security/search_path, triggers, default privileges,
   extensions and migration versions against Git. The automatic findings are a
   focused application check, not a complete PostgreSQL diff or baseline approval.
4. Inventory Auth settings with `npm run db -- auth-audit --database production` if a scoped
   `SUPABASE_ACCESS_TOKEN` is available; otherwise record them manually in the
   Dashboard. SMTP/provider secrets are not copied or exported by these tools.
5. Document each migration's actual effects and whether they exist. For missing
   changes, apply a reviewed migration; for existing manually applied changes,
   record only individually verified versions in Supabase's migration history.
6. Commit a **redacted review summary**, not the raw catalog or credentials, here
   once the audit is complete. Include PostgreSQL major version, approved
   migration versions, unresolved differences, and the SHA-256 of the reviewed
   private report. A file/hash alone does not establish baseline correctness.

Supabase CLI's `migration repair --status applied <version>` updates the ledger
without running SQL. It must not be used to hide missing schema/policy changes.
The wrapper deliberately never invokes repair or auto-approves a baseline.

Production is not ready for migration deployment until this review is complete.
