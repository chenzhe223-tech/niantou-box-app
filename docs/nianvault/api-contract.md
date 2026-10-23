# NianVault API contract

Status: routes are implemented in the NianBox cloud Worker on this branch. They are not live until the PR is merged and the Cloudflare Worker is deployed with a private repository and secret.

Base path: `/vault`. Authentication reuses the existing NianBox bearer session. Every read/write is scoped to the server-derived `user_id`; clients must never choose the owner ID.

## Endpoints

- `GET /vault/status` — enablement, repository configuration, and queue counts.
- `POST /vault/enable` — explicitly enable archive; request must include `confirm_no_backfill: true`; verifies the configured repository is private.
- `GET /vault/thoughts?before_seq=&limit=&category=&status=&q=` — paginated owner-only listing of in-scope thoughts.
- `GET /vault/thoughts/:id` — read an eligible thought and its archive status.
- `POST /vault/thoughts` — create a thought; requires a stable `id` or `Idempotency-Key`.
- `PATCH /vault/thoughts/:id` — update with `expected_version` in the request body.
- `DELETE /vault/thoughts/:id` — soft-delete and archive a tombstone; Git history is retained.
- `POST /vault/thoughts/:id/restore` — restore if `expected_version` matches.
- `POST /vault/archive` — archive an eligible existing post-activation thought by ID.
- `POST /vault/retry` — retry a job by `operation_id`.
- `GET /health` — existing service health endpoint.

## No-backfill boundary

Only thoughts created after the explicit enablement time and activation sequence are in scope. Existing historical thoughts remain out of scope even if edited later. Edits and soft-deletes of an eligible post-activation thought are versioned and synchronized.

## Response and error rules

- `201` created; `200` read/update; `409` stale version, duplicate ID with different content, or historical record outside scope.
- `401` missing/expired session; `413` request/body limit; `422` invalid input; `429` retry/rate limiting; `503` archive service unavailable while durable work is retained.
- A response may say `archiveStatus: archived` only after the GitHub commit is confirmed.
- `pending`, `retrying`, `conflict`, and `failed` are not successful archive states.

## Version and idempotency

The D1 server sequence is used as the record version. A stale `expected_version` returns 409; clients must re-read and reconcile. Create requests require a stable record ID or `Idempotency-Key`. Archive job IDs include the record ID and version, so edits produce new jobs and retries of the same version are idempotent.

## GitHub write protocol

1. Authenticate and validate the request and record scope.
2. Persist the archive job in D1.
3. Read the canonical path and current GitHub blob SHA.
4. If the stored version is newer, mark conflict and never overwrite it.
5. Create/update the file using the current SHA.
6. Verify the returned commit and file SHA, then mark the job archived.
7. On transient failure, retain the job with bounded exponential backoff; scheduled processing retries due jobs.

## Security

GitHub credentials exist only as Worker secrets. Never place them in browser bundles, public app config, telemetry, or logs. The Worker validates repository privacy at enablement. A private repository is not end-to-end encryption; Worker and GitHub can process plaintext.
