---
date: 2026-11-02
title: Prompt-driven plan revisions and version history
status: draft
---

## Implementation progress

- [x] Implement factory operations, version readers, server and CLI commands, and web controls.
- [x] Run the automated phase suites, `pnpm check`, and `pnpm web:build`.
- [ ] Complete the phase-specific crash-boundary and compatibility scenarios listed below.
- [ ] Manual browser and narrow-viewport verification (browser access host unavailable during implementation).
- [ ] Manual interrupted-update and rollback-recovery rehearsal.

## Current State

- The factory stores numbered immutable `PlanVersion` artifacts with the full structured plan, markdown reference, source and answers; events preserve their order (`payo/packages/contracts/src/factory.ts:141`, `payo/modules/factory/src/artifacts.ts:42`).
- At approval, `plan.md` is the editable working copy. `requestChanges` snapshots it and reruns review; approval ends the run and removes the workspace (`payo/modules/factory/src/commands.ts:662`, `payo/modules/factory/src/commands.ts:703`).
- The reviser receives the current plan and review through artifacts and returns a structured revision; failed work escalates and can be resumed (`payo/modules/factory/src/commands.ts:204`, `payo/modules/factory/src/commands.ts:535`).
- The CLI talks to the server; the web approval screen reads the working plan and checks gate state before commands (`payo/apps/server/src/http.ts:201`, `payo/apps/web/src/features/plan-review/PlanReview.tsx:123`).

## Design Decisions

- Prompt updates and restores are available only at an approval gate. History and comparison remain readable after approval. The existing manual edit and request-changes workflow remains available.
- Reuse immutable plan versions. A restore creates a new version containing the selected version's structured plan and answers, then runs a fresh review; it never rewrites history. The current working copy is first saved as a human version if it differs from the current snapshot, including before a restore.
- A prompt revision uses the current working copy and current answers as input, saves the prompt as a private artifact, generates a new structured plan, and runs a fresh review. A successful revision is not approval. Preserve stable question IDs and retain existing answers by ID; newly introduced questions remain unanswered.
- Compare any two saved versions. Extract the line comparison used by `approvalDiff` in `payo/modules/factory/src/metrics.ts` into a browser-safe shared export, keeping hashing in the factory metric. Unchanged prefix/suffix are omitted and the middle is shown as removed and added lines. It can include unchanged lines between separate edits; label the comparison accordingly. This avoids adding a diff dependency.
- Reject a command when its expected current version or working-copy content no longer matches. Preserve any edits made while an agent runs: detect a changed working file before replacing it, retain both the agent result and the file, and escalate for explicit recovery. No silent overwrite.

## Risks & Mitigations

- **Interrupted update loses its result or instructions** → persist the operation and its progress through result installation and review. On resume, distinguish work that still needs generation from a saved result that still needs installation; do not reinterpret the old working copy as the result.
- **External editor changes race with commands** → compare the expected content at command acceptance and again before replacing the working copy; on conflict preserve the file and saved versions and escalate. Filesystem checks cannot provide an atomic compare-and-swap against an external editor, so document the remaining narrow race and test the detectable cases.
- **Old data or stale review becomes misleading** → default new checkpoint fields for existing runs; clear the previous review when beginning a revision or restore and review the resulting version before raising approval.
- **Review changes answers or question meaning** → restore answers with the selected version, pass current answers into the agent, retain IDs only when question meaning is unchanged, and require answers for new questions before approval.

## Phase 1: Engine revisions and restores

### Overview

Make revisions and restores durable factory operations using the existing artifacts and approval gate.

### Changes

- In `payo/packages/contracts/src/factory.ts`, add a nullable `pendingPlanUpdate` checkpoint field with a backward-compatible default. Store its `kind` (`prompt` or `restore`), base plan reference, expected working-copy hash, prompt artifact reference or selected version number, and enough progress and result references to recover installation and review. Add `restore` to `PlanVersion.source`, while accepting all existing version records.
- In `payo/modules/factory/src/commands.ts`, add `updatePlan(handle, { prompt, expectedVersion, expectedWorkingCopyHash, signal })` and `restorePlan(handle, { version, expectedVersion, expectedWorkingCopyHash, signal })`. Validate a nonblank prompt, existing version and approval gate under the existing busy guard. Snapshot changed working markdown with answers as a human version before either operation; atomically record the pending operation, gate resolution and checkpoint before background execution.
- Extend the `Revise` path and `payo/modules/factory/src/roles.ts` so prompt revisions supply the saved prompt, base version and answers as agent inputs, without treating old review findings as requirements. Validate the structured revision as usual, persist an agent version, clear pending state and run `PlanReview` with a fresh review. Keep the existing review-driven revision path intact.
- For restore, save the selected structured plan and answers as a new `restore` version, clear the prior review and run `PlanReview`. Never mutate the historical artifact. Both operations start a new cycle with round 1. Keep the pending operation until its result is installed and its review completes; checkpoint its result reference before installation. On resume, retry generation only if no result was saved; otherwise install the saved result if the working file still matches the expected base, recognize an already-installed result, or raise a recovery gate on conflict. Resume an interrupted review against the installed result rather than snapshotting an old file. Recovery after a working-copy conflict snapshots the current file before rerunning review.
- Protect every working-copy write during these operations, including escalation, review-driven revisions and the final approval write. Track the last installed content hash as the expected working copy across subsequent writes. Check it immediately before replacement; if it changed, retain the current file and saved result and raise a recovery gate instead of overwriting. Keep the documented narrow external-editor race in mind.
- In `payo/modules/factory/src/read-model.ts` and `index.ts`, export `readPlanVersions` and `readPlanVersion`: enumerate recorded versions in order, validate their artifact contents and return the number, source, markdown, structured questions and answers. Return a clear not-found error for an unknown version and do not silently skip corrupt artifacts.

### Tests

Write tests first using the existing fake runner and persistence fixtures in `payo/apps/server/src/factory-flow.test.ts` and `factory-persistence.test.ts`:

- **Unit:** legacy checkpoints parse with no pending operation; version enumeration preserves order and duplicate markdown; missing/corrupt version artifacts fail explicitly.
- **Compatibility:** exercise the documented rollback restriction and any migration chosen for a current restore version against the previous schema; verify history remains intact.
- **Integration:** a prompt sees the latest working copy and answers, saves a new agent version and returns through fresh review; blank prompt, wrong gate and stale expected version/hash leave state unchanged.
- **Integration:** restoring an older version preserves the previous working copy, restores its questions and answers, appends a new version and reruns review; unknown version leaves the gate unchanged.
- **Integration:** interruption before/during generation resumes with the original prompt; agent failure and external edits during generation preserve the working file and permit recovery. Exercise existing review-driven revisions and manual request-changes to prevent regressions.
- **Integration:** interrupt prompt updates and restores around result checkpointing, file installation and review; resume the correct saved result without replacing external edits. Cover edits during failed generation and during review, plus a new update and restore from a high-round approval gate.

### Success criteria

- **Automated:** from `payo/`, `pnpm exec vitest run modules/factory/src/state.test.ts modules/factory/src/read-model.test.ts apps/server/src/factory-flow.test.ts apps/server/src/factory-persistence.test.ts` and `pnpm check` pass.
- **Manual:** at an approval gate, submit a revision, interrupt and resume it, then restore an earlier version and confirm each returns to review with history intact.

### What we're NOT doing

Reopening approved runs, automatic approval, deleting history, or changing the manual editor workflow.

## Phase 2: Server and CLI

Implementation note: `payo/README.md` does not exist; usage documentation lives in `docs/payo/usage.md`.

### Overview

Expose the engine operations and saved versions to both clients, with a textual comparison in the CLI.

### Changes

- In `payo/packages/contracts/src/api.ts` and its exports, define validated requests for prompt revision and restore containing `expectedVersion` and `expectedWorkingCopyHash`; define version-list and version-detail responses including markdown, questions and answers. Add the current saved version number and working-copy hash to the available plan projection in `RunReview`. Export the browser-safe line comparison from a shared package and wire the CLI and web workspace dependencies; keep the existing factory metric's hashes and behavior.
- In `payo/apps/server/src/composition.ts` and `http.ts`, add authenticated `GET /runs/:id/plan-versions`, `GET /runs/:id/plan-versions/:number`, `POST /runs/:id/plan-update`, and `POST /runs/:id/plan-restore`. Return validation errors for invalid input, 404 for an unknown version, and 409 for stale state or a closed gate. Ensure the operation is durably accepted before returning 202; schedule only the subsequent agent/review work, and retain existing request-changes behavior.
- In `payo/apps/cli/src/args.ts`, `client.ts`, and `index.ts`, add `payo plan-update <run-id> <prompt...>`, `payo plan-versions <run-id>`, `payo plan-show <run-id> <version>`, `payo plan-diff <run-id> <from> <to>`, and `payo plan-restore <run-id> <version>`. The update and restore commands fetch current review state and submit its version and hash; a conflict tells the user to inspect and retry. Diff prints labeled removed and added lines using the shared `approvalDiff` behavior.
- Update `payo/README.md` with usage, the approval-gate restriction, version and restore semantics, and the coarse diff limitation.

### Tests

Write tests first in the existing `payo/apps/cli/src/args.test.ts`, `client.test.ts`, and server HTTP/flow tests:

- **Unit:** parse nonblank prompts and positive version numbers; format equal and changed versions; reject missing arguments and malformed responses.
- **Integration:** authenticated version reads and commands validate input, report missing versions and stale state, and keep old request-changes clients working. A 202 response follows durable acceptance.
- **End-to-end:** extend `payo/apps/server/src/e2e.test.ts` with one CLI prompt → history → diff → restore flow, verifying the final approval gate and retained versions.

### Success criteria

- **Automated:** from `payo/`, `pnpm exec vitest run apps/cli/src/args.test.ts apps/cli/src/client.test.ts apps/server/src/e2e.test.ts` and `pnpm check` pass.
- **Manual:** run the five new CLI commands on an approval-gated run and inspect the two labeled sides of a diff; verify an approved run rejects update and restore.

### What we're NOT doing

Arbitrary artifact access, history deletion, or a separate version database.

## Phase 3: Web app

### Overview

Add prompt revisions and history controls to the existing plan review screen.

### Changes

- In `payo/apps/web/src/features/plan-review/api.ts`, add typed clients for the four version/update endpoints. In `PlanReview.tsx` and `GateActions.tsx`, add an accessible labeled prompt form at approval, disable submission for blank text or pending work, and submit the freshly fetched version and working-copy hash. Preserve the existing manual request-changes action.
- Add a version history section to `PlanReview.tsx`: list version numbers and sources, select a version to display its saved markdown, select two versions to compare as labeled removed/added lines, and restore a selected version at approval. Clearly distinguish saved versions from the current editable working copy. Confirm restore before submission and explain it creates a new version and triggers review.
- Invalidate run, review and history queries after acceptance and on conflicts; retain the user's prompt on errors and show actionable pending, conflict and failure states. Follow existing activity updates in `payo/apps/web/src/features/run-workspace/useRunActivity.ts` so the screen refreshes when review finishes.
- Reconcile local answer drafts when the saved version or answers change. Preserve unsaved text only if it is clearly marked as unsaved, and never show it as the saved answer; approval must reflect the restored server answers.

### Tests

Write tests first in `payo/apps/web/src/features/plan-review/api.test.ts` and `PlanReview.test.tsx`:

- **Unit/component:** prompt validation, pending/error states, stale gate conflict and retained prompt; versions render in order, selection shows saved markdown, and equal/changed comparisons display correctly.
- **Component:** restore confirmation sends the selected version and current concurrency values, refreshes history, and is unavailable after approval; existing manual request-changes and approval controls still work.
- **Component:** save an answer, restore a version with a different answer to the same question, and verify the displayed saved answer and approval use the restored value; any retained draft is clearly unsaved.

### Success criteria

- **Automated:** from `payo/`, `pnpm exec vitest run apps/web/src/features/plan-review/PlanReview.test.tsx apps/web/src/features/plan-review/api.test.ts`, `pnpm check`, and `pnpm web:build` pass.
- **Manual:** in the browser submit a prompt, observe progress and the new reviewed plan, compare two versions, restore an older one and verify review runs again. Check keyboard access and a narrow viewport.

### What we're NOT doing

Inline manual editing, an interactive merge editor, or reopening completed runs.

## PR Strategy

1. Phase 1 supplies the engine and persistence behavior with its tests; existing clients remain compatible.
2. Phase 2 depends on Phase 1 and delivers a usable server and CLI workflow.
3. Phase 3 depends on Phase 2 and adds the web interface. Each PR is independently reviewable; new fields are optional when reading old records. Client phases can be reverted independently, but the old engine cannot parse a current `restore` version. Do not roll back the engine while a new pending operation is active or after a restore version becomes current. Retain artifacts and use a forward fix, or first use a tested migration that creates an old-schema-compatible current version and checkpoint without deleting history. Verify this restriction and recovery procedure before an engine rollback.
