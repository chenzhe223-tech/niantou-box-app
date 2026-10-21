# NianBox AI Creation v3 — Implementation Contract

## Goal
Upgrade NianBox from idea capture into a practical, privacy-conscious path from idea to a verifiable first product. Preserve the existing local-first app and add capabilities incrementally.

## Existing architecture verified in repository
- React 19 + TypeScript + Vite; typecheck, Vitest, production build are enforced by the Pages workflow.
- IndexedDB is the local-first source of truth. New ideas are saved locally before optional cloud work.
- Optional account/sync service is Cloudflare Workers + D1; AI keys stay server-side.
- Existing AI endpoint pattern includes `/ai/classify`, `/ai/abstract`, and `/ai/poster`.
- Backup v2 includes ideas, projects, works, and work images; v1 backups remain importable.
- The app already has a localStorage handoff queue for Skills explicitly captured from the DAVYLAB AI Brief. Import removes an item only after the IndexedDB write succeeds or a duplicate is confirmed.
- Existing cloud sync and telemetry databases are intentionally separate.

## Upgrade principles
1. Do not rewrite the app shell, local storage, sync engine, or backup format unless a separately tested migration is justified.
2. Never send idea text to an AI provider without a clear user action and an explicit disclosure of the recipient and data being sent.
3. Never include idea text, prompts, model responses, tokens, or API keys in telemetry or routine logs.
4. Keep local save and export available when AI, network, or the cloud service is unavailable.
5. Do not claim a Skill is safe or usable based only on popularity or its listing; distinguish metadata checks from source review and execution.
6. Do not claim end-to-end encryption for cloud AI analysis if selected plaintext is sent to a cloud model. A strict encrypted-sync mode must explain that cloud analysis requires a separate, explicit disclosure/consent path.
7. Preserve the current three separate concepts: a locally stored idea, a cloud-synced user record, and a work/image asset. Do not silently change their sync semantics.

## MVP sequence
### P0 — Baseline and contracts
- Record the current main SHA and latest deployment workflow result.
- Inspect current cloud Worker route conventions, request limits, auth checks, model provider adapter, and tests.
- Locate the actual DAVYLAB AI Brief repository and its published data contract before implementing a live integration.
- Confirm the current route map and user-facing design system before adding a page or action.

### P1 — Idea analysis and three plans
- User explicitly chooses “分析这个念头” from an existing idea or drafts a new idea first.
- Return structured sections: understanding, target user/problem, assumptions, evidence gaps, risks, and three materially different implementation paths:
  A. free validation/prototype;
  B. lowest-cost practical MVP;
  C. paid/commercial architecture.
- Each plan includes architecture, tasks, estimated schedule, cost assumptions/range, risks, and acceptance checks. Mark estimates as estimates and cite any externally sourced facts.
- AI failure must not modify or lose the source idea. Store results only when the user chooses to save them.

### P2 — AI trend and Skill matching
- Consume a versioned, read-only feed from the verified AI Brief data source; do not scrape or couple to the rendered webpage if a structured feed exists.
- Each match must include source title, canonical URL, publication date, retrieval/verification timestamp, relevance explanation, compatibility, cost notes, and trust caveats.
- Skill trust review considers repository/license, activity, dependencies, permissions, network access, and source review status. Popularity is not a safety verdict.
- Keep the existing explicit Skill capture queue backwards compatible.

### P3 — Build handoff and verification
- Generate editable, platform-neutral task packs and tailored prompts for supported coding assistants.
- Acceptance criteria must be testable; report which checks are automated and which still require manual confirmation.
- Auto-edit/deploy, billing, and multi-agent orchestration are out of scope until the core idea-to-plan loop is validated.

## Required regression checks
- Create, edit, soft-delete, restore, and permanently delete ideas.
- Project links and source idea relations remain intact.
- Backup v1 import still works; backup v2 round-trips ideas, projects, works, and images.
- Local save works offline and does not depend on AI.
- Sync remains scoped to the authenticated user; existing account-isolation tests remain passing.
- AI endpoint rejects unauthenticated requests where required, validates input size, handles provider errors, and does not log idea content.
- Pages workflow must pass typecheck, tests, and production build before deployment.

## Current status
This document defines the implementation contract on an isolated feature branch. It is not evidence that the new product features have been implemented or deployed.
