# NianVault security, recovery, and rollout

## Personal-only authorization

- One personal owner account is the data owner.
- Each authorized client has a revocable identity/credential; scopes initially allow read, create, update, soft-delete/archive, and restore.
- The server derives owner ID from the authenticated session, never from request JSON.
- Revocation must invalidate the client immediately or within the documented session expiry.
- Keep GitHub credentials in Cloudflare Worker Secrets, scoped to the single private NianVault repository with minimum contents access.

## Privacy

GitHub private repositories are not zero-knowledge storage. Worker and GitHub can process plaintext. Do not send thought bodies to telemetry or logs. Avoid secrets and personal data in file paths, commit messages, labels, and audit events.

## Archive semantics

- Local IndexedDB and current D1 sync continue working if GitHub is down.
- D1 queue acceptance is not archival success.
- Retriable errors use bounded exponential backoff with jitter and a maximum-attempt policy; exhausted jobs remain inspectable and manually retryable.
- Never silently overwrite a newer record. A stale version becomes a conflict.
- Soft delete is represented as a tombstone/canonical document update. Git history is retained.
- A hard-delete request is a separate high-risk procedure requiring repository history rewrite and backup review; it is not part of the MVP.

## No-backfill rule

The rollout must persist an explicit `enabled_at` and `activation_seq` per owner before enqueueing any events. Only mutations generated after that cursor are eligible. Do not query existing `ideas` rows to seed the queue. Do not use a one-time full sync as an archive source.

If the current sync path cannot distinguish new post-activation mutations, add a server-generated mutation event ID at write time and use it as the eligibility boundary. Client timestamps alone are not a reliable cursor.

## Recovery

1. Keep D1 jobs durable until verified archive completion.
2. Rebuild derived indexes from canonical GitHub JSON files.
3. Restore a prior canonical file version by creating a new commit, never force-push as a normal recovery action.
4. Test repository restore and index rebuild in a disposable test repository before production.
5. Rotate GitHub credentials immediately if leakage is suspected.

## Release gate

Do not enable production archival until: private repository exists; Worker secret is configured; schema migration is deployed; API tests pass; a test record is created, read, updated, soft-deleted, restored and verified in GitHub; cross-device reads pass; no historical record was queued; and rollback instructions have been rehearsed.
