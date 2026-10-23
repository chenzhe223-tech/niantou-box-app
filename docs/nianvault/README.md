# NianVault — integration plan

NianVault is the personal, multi-device archive for new thoughts created after activation; subsequent edits and soft-deletes of those new thoughts are also synced. This directory documents the first integration slice inside NianBox; it is not the standalone NianVault repository.

## Verified baseline

- The NianBox cloud Worker is `server/cloud-worker.js`.
- Existing D1 schema is `server/cloud-schema.sql`; idea rows use `(user_id, id)`, JSON `doc`, `updated_at`, `deleted_at`, and per-user sync `seq`.
- Existing sync endpoints are `GET /sync/pull` and `POST /sync/push`.
- Existing idea model is `src/types/idea.ts`. Categories are `life | app | skill | web | other`; statuses are `inbox | research | ready | building | done | paused`.
- The current cloud deployment is driven by `.github/workflows/deploy-cloud.yml` and `server/deploy-cloud.mjs`.

## Non-negotiable product constraints

1. Personal-owned data only. All client platforms act as authorized clients of the same account.
2. Authorized clients may read, create, update, soft-delete/archive, and restore records.
3. No historical backfill. Only thoughts created after an explicit enablement cursor are eligible. Edits and soft-deletes of those eligible thoughts are synced; pre-existing thoughts remain out of scope.
4. NianBox local IndexedDB and existing D1 sync remain operational if GitHub is unavailable.
5. D1 queue status is not proof of GitHub archival. Only a verified GitHub commit can set `archived`.
6. GitHub credentials must exist only in Worker secrets. Never expose them to the browser or Vite build.
7. A private GitHub repository is not end-to-end encryption; Worker and GitHub may process plaintext.
8. Existing NianBox records, schema, routes, and UI must remain backward-compatible.

## Target architecture

Clients → NianBox Cloud Worker → D1 durable archive queue → GitHub Contents/Git Data API → private NianVault repository.

D1 remains the operational sync and queue database. GitHub stores canonical versioned JSON snapshots. A queue worker retries transient failures with bounded exponential backoff and jitter. Use stable record IDs and idempotency keys; detect stale updates using expected versions and Git blob SHA.

## Repository layout target

```
nianvault/
  README.md
  schema/thought.schema.json
  schema/project.schema.json
  index/manifest.json
  thoughts/<stable-id>.json
  projects/<stable-id>.json
  docs/{api-contract,security,recovery}.md
  .github/workflows/validate-vault.yml
```

This target layout is not proof that the standalone repository exists. The current integration branch is staged in NianBox until repository creation is available.

## Rollout

1. Confirm production Worker and D1 health; record existing tests/build baseline.
2. Create the private standalone repository and seed it with the schema and docs.
3. Add the D1 archive queue using a migration, never destructive schema replacement.
4. Add Worker routes with strict authentication, input validation, rate limiting, and owner scoping.
5. Use a durable queue / scheduled processor to write GitHub commits.
6. Enable only after an explicit activation cursor is stored; never scan all existing ideas.
7. Validate real multi-device behavior and failure recovery before calling it delivered.

## Release gates

- No historical records are backfilled.
- Every operation is scoped to authenticated `user_id`.
- Duplicate delivery is idempotent.
- Conflicts return a clear 409 response; they never silently overwrite newer content.
- GitHub failure leaves durable pending work and never reports `archived`.
- CI validates schema, types, tests, build, and integration behavior.
