---
date: 2026-11-03
title: Payo execution UI
status: draft
---

## Current state

An operator can execute one PR unit from an approved plan through the CLI. The server creates a separate run. The web console already lists it, but opens the planning workspace and directs every gate to Plan Review. The goal is to complete the same local workflow in the browser, from selecting the PR through inspecting its result.

- `payo/apps/web/src/app/App.tsx:268` mounts a workspace keyed by run ID. `payo/apps/web/src/features/run-workspace/RunWorkspace.tsx:18` defaults to Swarm, and line 161 mounts Plan Review even when the operator selects Activity.
- `payo/packages/contracts/src/api.ts:109` exposes optional execution details on the run summary. `payo/modules/factory/src/execution-read-model.ts:23` projects the current checkpoint, completed phase receipts, latest check and review reports, and warnings for damaged artifacts. The latest reports may belong to a previous phase.
- `payo/modules/factory/src/read-model.ts:73` already reads the checkpoint’s structured plan version and validates its Markdown. `payo/packages/contracts/src/api.ts:138` exposes the Markdown and questions through the review endpoint. The PR units are present in the stored version but absent from that response.
- `payo/modules/factory/src/execution.ts:135` rejects unknown or empty PR units. Lines 161–197 read the approved snapshot and require an ended, approved planning run. `payo/apps/server/src/http.test.ts:659` covers durable acceptance and repeat launches.
- `payo/modules/factory/src/execution.ts:2335` raises an execution-specific gate. The web planning gate controls recognize a different kind in `payo/apps/web/src/features/plan-review/GateActions.tsx:22`.

## Design decisions

Use the existing run URL, summary query, authenticated HTTP client, and event stream. Planning runs keep their existing views. Execution runs open on Execution with Activity alongside it. The execution page can render its summary even when event history is unavailable.

Show summary-level check and review evidence. Label the reports “Latest checks” and “Latest review”, show unchecked lenses by name, and surface artifact warnings alongside available data. For an empty checks array say “No check results available”: the summary cannot distinguish a missing report from an empty one. A null review gets an explicit empty state. The browser neither infers success from empty arrays nor reconstructs engine state from event text. Latest reports may predate the current phase or final scope; do not present them as evidence for either. Label review round and unresolved count as current checkpoint values, separate from the latest report’s findings.

The launch form belongs in the approved plan’s Decision view. Give that view a discoverable “Implement a PR” entry from the approved workspace header. The operator makes a separate launch decision after approval. Display the selected PR, phase order, and base before submission, with a short explanation that execution writes to a local worktree.

Paths below are repository-relative. Run verification commands from the repository root.

## Phase 1 — Follow an existing execution

Implementation note: checkpoint round and unresolved count are unavailable when the summary has no review report. The UI labels them unavailable in that case.

**Overview.** A CLI-created execution is recognizable in the run list and opens directly on live progress. This gives the launch form a usable destination.

**Tests first.** Extend the web component tests in `payo/apps/web/src/features/run-workspace/RunWorkspace.test.tsx` and `payo/apps/web/src/features/runs/RunList.test.tsx`. Cover a planning and execution run sharing the same work item, opening the source run, switching to Activity without requesting planning review, and receiving a changed checkpoint. Exercise preparation before a manifest exists, phase 2 of 2, empty checks, missing review evidence with a warning, and the transition to final scope while latest reports still belong to the prior phase. Verify those reports are not attributed to final verification or the current checkpoint round. Keep existing planning navigation and stream tests green.

**Changes.**

- [x] Pass `onSelectRun: (runId: string) => void` from `navigateToRun` in `payo/apps/web/src/app/App.tsx` to `RunWorkspace.tsx`. In the latter, choose views by `run.data.execution`, using the existing keyed mount to reset selection. Render the shared header, connection state and Activity timeline. Only planning runs mount the planning stage strip and Plan Review.
- [x] Add `payo/apps/web/src/features/run-workspace/ExecutionView.tsx`, taking the execution summary and source navigation callback. Display PR ID, source link, stage, status detail, completed phase titles and commits, check names/statuses, current checkpoint round and unresolved count, latest review finding count, unchecked lenses, and artifact issues. Use a one-based phase number only for a known in-range phase. Show final scope as current progress, separately from latest reports whose scope is unknown. Preserve selectable, wrapping commit and path text.
- [x] In `payo/apps/web/src/features/runs/RunList.tsx`, distinguish execution rows and compact entries using the PR ID alongside the work item. Reuse the current grouping and URL selection.
- [x] In `payo/apps/web/src/features/run-workspace/useRunActivity.ts`, include execution checkpoint artifact events in the existing debounced summary refresh. Preserve immediate end-of-run refresh and reconnect/replay behavior. Test that a burst of checkpoints coalesces and ordinary attempt output still causes no summary request.

**Automated.** [x] `pnpm -C payo exec vitest run --project web src/features/run-workspace/RunWorkspace.test.tsx src/features/runs/RunList.test.tsx`

**Manual.** [ ] Open a CLI-started execution, refresh its URL, switch to Activity and back, then follow its source. Verify that the parent opens its planning workspace and long identifiers remain readable in a narrow window.

## Phase 2 — Launch one approved PR unit

**Overview.** Let the operator choose a PR from the immutable approved strategy, optionally override the base, and navigate to the execution ID accepted by the server.

**Tests first.** Extend the core projection tests in `payo/modules/factory/src/read-model.test.ts` for an approved snapshot with multiple PR units, original ordering, an empty phase list, and unavailable artifacts. Verify the field is absent before approval. In `payo/apps/web/src/features/plan-review/PlanReview.test.tsx`, cover selection, pending state, successful navigation, and an actionable server rejection with inputs preserved. Extend `payo/apps/web/src/features/plan-review/api.test.ts` for default and explicit bases. Use the existing HTTP duplicate-acceptance test for server semantics.

**Changes.**

- [x] In `payo/packages/contracts/src/api.ts`, add `prStrategy: PlanOutput.shape.prStrategy.optional()` to the available plan branch of `RunReview`. In `projectPlan` in `payo/modules/factory/src/read-model.ts`, project `version.plan.prStrategy` from the verified snapshot only for an ended, approved run. Keep the unavailable plan branch and older responses readable.
- [x] In `payo/apps/web/src/features/plan-review/api.ts`, add `implementRun(token: string, runId: string, input: ImplementRequest)` using `getJson`, `ImplementRequest.parse`, and `RunIdResponse.parse` against the existing POST implement route.
- [x] In `RunWorkspace.tsx`, add the approved planning header action to open Decision. Pass `onSelectRun` through `PlanReview.tsx` to a new `payo/apps/web/src/features/plan-review/ImplementPrForm.tsx`. Render it for an approved source with an available strategy, independently of the planning review report. Explain unavailable choices if an approved snapshot lacks strategy. Show phase-less units as ineligible. Never derive IDs or phase order from Markdown.
- [x] In the form, use a labeled PR selector, ordered phase preview, optional base input and explicit launch button. Omit blank base after trimming, allowing server defaults. Disable submission while pending. On acceptance invalidate the run list and navigate to the exact returned ID, including a reused execution. Surface the server message for missing checks, model configuration or conflicting base. Keep the form available for correction or retry.

**Automated.** [x] `pnpm -C payo exec vitest run --project core modules/factory/src/read-model.test.ts apps/server/src/http.test.ts` and `pnpm -C payo exec vitest run --project web src/features/plan-review src/features/run-workspace/RunWorkspace.test.tsx`

**Manual.** [ ] With dev fakes and a configured execution check, approve a plan, choose a PR and start it. Return to the source and repeat with the same base. Verify the same execution URL opens and the source stays approved.

## Phase 3 — Resume a gated execution and inspect its result

**Overview.** Show why work stopped and when the engine permits resume. At completion give the operator the local branch, worktree and commit needed to inspect the result.

**Tests first.** Extend `RunWorkspace.test.tsx` with a resumable execution gate, a gate without resume permission, a rejected resume that leaves the gate visible, and a refreshed summary after successful resume. Cover a reviewed completion with all result fields and partial data with missing fields. Reuse the server restart/resume integration coverage in `payo/apps/server/src/e2e.test.ts:426`.

**Changes.**

- [x] In `RunWorkspace.tsx` and `ExecutionView.tsx`, route execution gate attention to Execution. Supply the open execution gate, show its reason and enable Resume only on an active run when that gate allows the command. Use the existing `resumeRun(token, runId)` client. Disable repeats while pending, surface server errors, and refresh the run summary after settlement. The refreshed summary controls whether the gate remains visible.
- [x] In `ExecutionView.tsx`, show retained branch and worktree when available, including at escalation. Group them with the final result commit for an ended, reviewed execution. Keep phase receipt commits separate. Missing values stay visibly unavailable.
- [x] Update the execution and recovery sections of `docs/payo/usage.md` with the browser path from approved plan to retained result and the existing fake interruption rehearsal.

**Automated.** [x] `pnpm -C payo check` and `pnpm -C payo web:build`

**Manual.** [ ] Use the documented `execution-interruption` dev-fake scenario. Stop the server during phase two, restart with the same data directory, inspect the gate, and resume in the browser. Confirm phase one stays complete and the reviewed result shows the same commit as CLI status. Check keyboard operation and narrow-screen layout for launch, resume, and source navigation.

## Risks and mitigations

- Human Markdown edits may diverge from structured PR metadata. Show the pinned strategy used by the engine and its ordered phases before launch. Preserve server-side conflict messages.
- A checkpoint may precede its manifest, reports or receipts. Render the fields independently and distinguish unavailable evidence from a passing check or reviewed result.
- A stale browser may present a gate that has already closed. Keep the server authoritative, report rejection and refresh the summary before another attempt.

## Scope boundaries

This version excludes individual finding text, check output, diff browsing, editing execution configuration, automatic chaining, and GitHub PR operations. It introduces one optional read-model field and uses existing persisted data and command endpoints. The three phases can ship in order without a data migration.
