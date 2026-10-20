# Exact production-to-QA data refresh

Tracking: [issue #23](https://github.com/pricezhang42/WinnipegBusTripPlanner-Custom/issues/23).
Run from this backend repository. Choose the destination independently with `--database qa1` or `--database qa2`. See [connection profiles](connections.md).

Status: **runner implemented; native archive/restore fixture rehearsal passed**.
The metadata preview, hosted QA temporary-fixture SQL checks and a native
archive/repeat/failure/recovery rehearsal on disposable QA schemas have run. No
production data has been exported and no real QA users/data have been replaced.
`npm run db -- seed --database qa1` remains a separate synthetic-fixture workflow.

The first runner supports PostgreSQL 17, matching managed Auth versions, the
three app tables and all Auth table data with email/password accounts. Populated
MFA factors, SSO/OAuth/passkey/SCIM feature tables, phone/non-email identities,
encrypted material, nonempty legacy Auth instance configuration, Storage/Vault
or scheduled/external-operation data stop the
apply path before replacement. It never silently removes unsupported records to
claim success. This is not a complete Supabase platform clone.

## Outcome and boundary

The user requested original accounts and passwords, without anonymization. A
successful refresh preserves user UUIDs and existing password hashes, so the
same email/password credentials work against QA. It preserves the associated
favorites and history, including keys, original row IDs, timestamps and JSON
values. Passwords are never recovered as plaintext or reset through the Admin
API. Supabase supports transferring Auth users and their password hashes through
its database migration workflow; see the [Auth migration guide](https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects).

This is a copy of **data into the versioned QA application schema**, with an
explicit Auth migration compatibility check. It does not roll QA back to
production's older function permissions. The environments keep separate signing
keys, API keys, service configuration and Auth callback URLs. Production remains
read-only throughout. Existing QA users and their saved data are replaced only
by an explicitly acknowledged refresh.

Source: `rshgohxdntjglnqilyls`; destination: `dvxkygiqnvvghkmqxhvk`.
The runner must derive these from `supabase/environments.json` and the existing
verified-TLS connection helpers, not whichever project a CLI last linked to.

| Data or state | Intended treatment |
| --- | --- |
| `public.favorite_locations`, `favorite_trips`, `trip_history` | Copy every row and original ownership/value. Restore identity/sequence behavior without ID collisions. |
| Auth users, identities and related Auth data | Preserve original records and hashes through a compatible logical restore. Inventory all Auth tables before choosing a complete restore set. Do not copy just `auth.users`. |
| Auth sessions, refresh tokens, MFA, OAuth/SSO and encrypted fields | Explicit preflight/review item. A reduced set is not an exact copy. If compatible restoration cannot be established, stop and report the missing scope. Do not silently discard or transform it. |
| Auth service migration bookkeeping | Compare source/target managed schema versions and restore data using a supported route. Never replace bookkeeping to conceal incompatible tables. |
| `supabase_migrations` | Retain QA's application migration ledger. Production currently has no ledger; copying that absence would lose QA's migration tracking. |
| Public schema definitions, RLS, grants and functions | Keep migration-managed QA definitions and the QA-only permission correction. Data restore must not import production DDL/default privileges. |
| Additional schemas, Vault, Storage, replication and integrations | Inventory and classify before execution. Include dependencies deliberately or declare the run unsupported; app-table parity alone is not a full-project clone. Storage file bytes need their own transfer when present. |
| Project keys, URLs, SMTP/provider secrets and callback settings | Remain QA-specific. Do not copy the production signing secret to preserve existing mobile sessions. |

The operator should sign out and obtain a fresh QA session after copying.
Keeping separate project signing keys means a production access token is not a
QA login. Existing password compatibility and existing-session compatibility
are separate requirements. Copying refresh/session records and encrypted Auth
state requires explicit review; it must not be assumed safe or functional just
because a table restore succeeded.

## Operator commands

Run in the backend repository. Native PostgreSQL 17 clients (`pg_dump`, `pg_restore`,
`psql`) are required; no local database or Supabase instance is started. They
were installed on this Mac and configured in ignored `.env.connections.local`
during implementation. On another machine, install them if absent:

```sh
brew install libpq@17
```

Set `DATABASE_PG_BIN` in ignored `.env.connections.local` to the `bin` directory
under `brew --prefix libpq@17` (normally `/opt/homebrew/opt/libpq@17/bin` on Apple
Silicon). The [Homebrew formula](https://formulae.brew.sh/formula/libpq%4017)
provides these clients. Other operating systems can install PostgreSQL 17 clients
on PATH. Existing production/QA connection URLs and certificate paths are reused.

```sh
# Metadata/preflight plan; no export or destination writes.
npm run db:refresh -- --database qa1

# Only after reviewing the preview and rehearsing backup/restore:
# stop QA app/Auth traffic and all QA seed/test/migration jobs first.
npm run db:refresh -- --database qa1 \
  --apply \
  --confirm-source rshgohxdntjglnqilyls \
  --confirm-ref dvxkygiqnvvghkmqxhvk \
  --replace-qa-data \
  --qa-quiesced \
  --copy-auth-state
```

`--qa-quiesced` is an operator acknowledgement, not an API traffic switch. The
runner cannot pause Supabase's hosted Auth service. Refresh/recovery processes
coordinate through a QA session advisory lock; ordinary app traffic and existing
seed/test/migration commands do not take that lock and must be stopped manually.
`--copy-auth-state` explicitly acknowledges copying original sessions, refresh
and one-time-token data as part of the exact Auth data set. These artifacts must
receive the same restricted access as production. QA keeps its own signing keys.

The selected relation-size bound is 256 MiB (including indexes); larger datasets
stop before export. Native processes have a 180-second timeout. The schema and
old QA row/sequence state are rechecked under exclusive table locks before
`TRUNCATE ... RESTRICT`. Foreign keys remain enabled: archive table data is ordered
parent-before-child. Cycles, custom table triggers or foreign keys crossing the
copy boundary are blockers. No privileged trigger disabling is attempted.

Temporary-fixture SQL check (no real Auth/app data read or replaced):

```sh
npm run db:refresh:sql:test -- --database qa1
```

Full native fixture rehearsal (creates uniquely named disposable QA schemas
with synthetic bcrypt hashes and saved rows, then removes them and its files):

```sh
npm run db:refresh:rehearse -- --database qa1
```

The native rehearsal uses source/destination fixture schemas in QA, with a
test-only mapping to the logical Auth/app names. It exercises real archives,
TOC ordering, COPY, verification, repeats, failed-transaction behavior and
explicit recovery. It does not exercise Supabase Auth login or replace real
managed Auth rows. Its schema cleanup is restricted to its generated UUID names.

After a successful real refresh, sign in to QA locally with an original account's
password, then start the QA backend and run `npm run db -- test --database qa1 --api local`. The refresh command
does not issue passing promotion evidence or claim that original-password login
was tested merely because a password hash was copied.

## Recovery and artifact cleanup

Each apply prints a UUID identifying `.database/refresh-UUID/`. The directory
contains `status.json`, a protected manifest, source/QA archives, rendered data
SQL and verification material. Runtime `.pgpass` files are removed on normal
completion/failure; after an OS/process crash, treat any surviving passfiles as
secrets and remove them after review.

If the status is `needs-recovery-review`, keep QA offline. Table restore runs in
one `psql --single-transaction` operation, but PostgreSQL `setval` is **not
transactional** and a dropped connection can leave commit outcome uncertain.
There is no automatic assumption that rollback restored everything. Explicitly
recover the previous QA rows and sequence state from that run:

```sh
npm run db:refresh -- --database qa1 \
  --recover RUN_UUID \
  --apply --confirm-ref dvxkygiqnvvghkmqxhvk \
  --replace-qa-data --qa-quiesced --copy-auth-state
```

Recovery connects only to registered QA, verifies backup checksums/private file
permissions and requires unchanged schema/ledger. It restores and verifies old
rows/sequences without changing migration history. A changed schema or broken
backup requires manual recovery review, not a force flag.

Review login/API results and choose the backup retention window. When that
window closes, explicitly remove one completed/recovered run's private exports:

```sh
npm run db:refresh -- --database qa1 --cleanup RUN_UUID \
  --apply --confirm-ref dvxkygiqnvvghkmqxhvk
```

Cleanup makes no database connection and rejects an active/uncertain run or
symlinked artifacts. Failed runs before replacement may also be cleaned up. No
automatic cleanup deletes a backup still needed for recovery.

The default preview lists references, schema compatibility, selected tables,
dependencies, required tools and unresolved blockers. It must not print rows,
emails, metadata payloads, hashes, reset/session tokens or connection strings.
Preview must not export real rows. Any row counts needed during execution stay
in private verification artifacts rather than raw SQL logs.

The implementation must reject production as destination, equal references,
missing confirmations and connection URLs that do not identify the registered
project. Existing verified-TLS validation applies to both connections. There is
no generic `--force`, linked-project fallback or production reset path.

## Implementation sequence

1. **Preflight without data export.** Check tools and actual server/managed Auth
   versions. Compare columns/types/defaults/generated fields, constraints,
   triggers, sequences, extensions and grants needed for the restore. Inspect
   metadata for additional dependencies, integrations and encryption requirements.
   Detect unreviewed foreign keys outside the selected tables. Refuse an
   unsupported combination before changing QA. PostgreSQL 17.6/17.11 major
   compatibility alone does not prove Auth service compatibility.
2. **Native logical restore.** The implementation uses
   `pg_dump --format=custom --data-only` with an exported read-only snapshot,
   `pg_restore` with an allowlisted/reordered table-data TOC and `psql` with
   `ON_ERROR_STOP` in a single destination transaction. The
   [Supabase logical backup/restore workflow](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
   is the reference for data-only migration. Auth tables are selected explicitly;
   this avoids relying on implicit CLI managed-schema exclusions. Auth service
   bookkeeping and the application migration ledger are not in the dump. Native
   tools preserve original COPY values; JavaScript does not decode/re-encode
   user/password rows.
3. **Prepare recovery.** Stop QA app/backend access and concurrent seed/test/
   migration jobs; establish a single refresh lock. Take a protected, validated
   QA backup and record its schema/ledger versions. A backup is not proven
   recoverable merely because its file exists: rehearse restoration on disposable
   hosted infrastructure before relying on this workflow.
4. **Export a consistent production snapshot.** The export connection is
   read-only. Keep all related tables in the same logical snapshot so changing
   favorites/history/users cannot produce mismatched ownership. Do not change
   production Auth settings, triggers, grants, sequences, schema or ledger.
   Sequence allocation state is not MVCC table data: record and handle its
   high-water marks explicitly rather than claiming a perfect snapshot of counters.
5. **Replace destination data.** Validate the recovery artifact before removal.
   Quiesce QA Auth/API access and use a bounded transaction/lock strategy.
   Restore the chosen complete dependency set into QA's compatible schema.
   Do not use unbounded `TRUNCATE ... CASCADE`, broad schema drops or migration
   resets. Identity inserts, trigger handling, encryption and sequence recovery
   must follow the chosen tested restore mechanism. If that mechanism requires
   temporarily suppressing triggers, explicitly validate referential integrity
   afterward and restore the original settings on every exit path.
6. **Verify before releasing QA.** Compare source-snapshot and destination row
   counts and stable content digests, ownership links, nullability, FK integrity,
   original password hashes and restored next-ID behavior. Avoid JavaScript
   number/date conversions that lose bigint precision or timestamp fractions.
   Treat password hashes and low-entropy data digests as sensitive values; print
   only pass/fail summaries. Verify QA schema and migration ledger are unchanged.
7. **Authenticate and test.** An account owner enters their existing password
   locally against the QA endpoint; never request it in chat or save it in an
   artifact. Verify confirmed/unconfirmed and email/password behavior explicitly.
   OAuth/SSO/MFA need compatible QA provider settings/encryption and dedicated
   checks before claiming those flows work. Run `npm run db -- test --database qa1 --api local` using its own new
   temporary accounts; it must not write to or clean up cloned accounts.
8. **Finalize or recover.** Invalidate pre-refresh QA promotion evidence before
   any data replacement. Write new evidence only after verified restoration,
   live tests and owned-fixture cleanup. On failure, keep QA unavailable until
   the transaction is rolled back or its validated backup is restored. Report
   whether rollback succeeded; never claim atomic recovery for nontransactional
   sequence/tool side effects. Release the lock and reopen QA only after checks.

## Artifact handling

Artifacts can contain the original emails, location history, password hashes,
MFA material and tokens. Store them only in an ignored `.database/` run directory
with mode 0700 and files mode 0600, outside the Metro graph. Record source/target
references, snapshot time, selected schemas, tool versions and protected backup
checksums. Never commit/upload those artifacts, attach them to the PR, expose
them through the mobile build or publish them through CI.

Define an operator-chosen retention period and a cleanup command. Delete source
exports after successful verification according to that policy; keep the QA
recovery artifact until its rollback window closes. No secrets belong in process
arguments or unredacted error logs. Existing secret redaction must be reviewed
for errors containing SQL/data, not only environment-variable values.

Copying database data does not send signup emails by itself, but restored cron,
webhooks, queues and integrations can have external effects. Keep such services
disabled or pointed at QA before exposing restored data. Do not reset passwords
or trigger real-user emails as an automated validation shortcut.

## Rehearsal and remaining acceptance evidence

Before a real refresh, exercise the runner on disposable hosted source/target
fixtures containing password users, identities, favorites/history, high identity
values and existing target data. Verify:

- Reversed/equal targets, missing acknowledgements, invalid TLS and incompatible
  Auth schema/encryption stop before destination mutation.
- Source stays read-only; copied rows preserve UUIDs, hashes and exact values.
- Mid-restore failure, FK mismatch and verification failure produce a tested
  rollback/recovery path; secrets do not appear in diagnostics.
- Repeated refresh replaces the intended QA set without duplicate identities,
  orphaned ownership or sequence collisions, while retaining QA schema/ledger.
- QA original-password login works; source tokens/keys are not used as QA login.
- Original cloned users survive the existing temporary-account test cleanup.

Completed during this PR: 34 offline tool tests, including
guards/orchestration/recovery-failure tests;
read-only metadata preview against the registered production and QA projects;
SQL verification on transaction-local QA fixtures, including password-hash
mismatch, FK enforcement, microsecond timestamps and IDs above JavaScript's
safe integer range. Those fixture objects were rolled back. A real native
PostgreSQL 17.11 archive/restore rehearsal also passed on disposable hosted QA
fixtures: original bcrypt hashes and row values, parent-before-child COPY,
repeat refresh, failed table transaction with nontransactional sequence effects,
and explicit restoration of previous rows/sequences. The fixtures and rehearsal
artifacts were removed afterward. Read-only preview now reports all client tools
available and no structural blockers for the registered projects.

Pending: operator review and explicit execution of a real production export/QA
replacement, data-dependent feature/encryption checks for that source snapshot,
and login against real restored managed Auth accounts. No original user's
password has been requested or tested. These remain separate from passing
synthetic-fixture checks; PR #24 does not claim a real copy has happened.

Offline CI tests validate guards, artifact handling, planning and failure paths.
CI must not receive production rows, password hashes or credentials. Live rehearsal
and the first production-to-QA run remain explicit operator steps after review.

For comparison, Supabase's [Restore to a new project](https://supabase.com/docs/guides/platform/clone-project)
is a separate full database cloning option with its own plan/backup requirements.
It creates a new project, so it is not an automatic refresh of our existing QA
project and does not replace the compatibility/configuration review above.
