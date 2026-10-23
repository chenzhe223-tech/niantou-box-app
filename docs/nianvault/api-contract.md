# NianVault API contract (proposed)

Status: design contract; endpoints are not considered live until implemented and verified against the deployed Worker.

Base path: `/v1/vault`. Authentication must reuse the authenticated NianBox account/session. Every operation scopes all database reads and writes to the authenticated server-derived `user_id`; never trust a client-provided owner ID.

## Endpoints

- `GET /health` — service health, no private data.
- `GET /thoughts?cursor=&limit=&category=&status=&q=` — paginated owner-only list.
- `GET /thoughts/:id` — retrieve one thought.
- `POST /thoughts` — create/queue archive; requires `Idempotency-Key`.
- `PATCH /thoughts/:id` — update with `If-Match` or `expected_version`.
- `DELETE /thoughts/:id` — soft-delete tombstone; do not remove Git history.
- `POST /thoughts/:id/restore` — restore if the expected version matches.
- `GET /sync/status` — queue counts and last verified archive time.
- `POST /sync/retry` — retry eligible failed jobs for the current user only.
- `GET /export` — owner-only portable export, rate-limited and audited.

## Response rules

- `201` new record accepted; `200` read/update; `202` queued but not yet archived.
- `401` missing/expired session; `403` revoked client or insufficient scope.
- `409` stale version or conflicting update, with current version and a safe conflict code.
- `422` invalid schema; `429` rate limit; `503` GitHub service unavailable while durable work remains queued.
- A response may say `archive_status: archived` only after a GitHub commit is confirmed and the canonical file is verified.
- Never log or echo the full request body.

## Version and idempotency

Each record has a stable ID and monotonic integer version. Each mutation has a stable `operation_id`. Replaying the same operation ID returns the existing result. A write with a stale expected version returns 409; clients must reconcile rather than overwrite silently.

## GitHub write protocol

1. Validate owner session, schema, limits, and operation id.
2. Persist the queue job in D1 before acknowledging acceptance.
3. Read the current canonical path and blob SHA.
4. Compare the expected version / payload hash against the latest head.
5. Create a commit using Git Data API or Contents API with current SHA.
6. Verify the returned commit and file content hash.
7. Mark job archived and update the entity head in D1.
8. On timeout after a possible commit, read back the target path and compare the payload hash before retrying.

## Security

GitHub credential exists only as a Worker secret. Do not place it in browser bundles, public app config, telemetry, or logs. Enforce JSON content type, request size limits, allowed CORS origins, rate limits, and authorization on every route. Private GitHub storage is not end-to-end encryption.
