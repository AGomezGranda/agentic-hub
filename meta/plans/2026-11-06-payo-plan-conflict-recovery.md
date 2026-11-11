---
date: 2026-11-06
title: Payo plan conflict display and correction
status: complete
---

## Current State

ExecutionView renders the entire gate reason as one paragraph and offers Resume for plan conflicts. `assertExecutionResumable` rejects these conflicts. `PlanReview` and `assertChangeable` permit plan revision only at an open approval gate. Approved plans remain immutable; prompt planning runs already support review, approval, and a new implementation.

## Design Decisions

- Project plan issues from saved execution reports, including existing paused runs; share the backend conflict classification with Resume validation.
- Display issue cards with Expected, Found, Impact, and Decision sections when the existing report labels are present. Preserve unstructured text and full reports.
- Resolve through a new prompt planning run containing the approved plan, PR strategy, saved answers, issue, and operator decision. Reuse the source repository and base branch. Review and approval are required before a replacement execution is started using the existing implementation form.
- The original execution remains paused and its workspace remains available. No edits transfer automatically. Do not change an existing approved plan or its pinned execution.

## Phase 1 — Explain conflicts

- [x] Add focused factory tests proving an implementer plan issue projects its report and blocks Resume, including after reopening.
- [x] Add optional `planIssues` to ExecutionSummary, share classification in execution-state.ts, project current issues in execution-read-model.ts, and remove unavailable resume commands in server summaries.
- [x] Add issue cards to ExecutionView with a complete fallback for reports that do not follow the label format. Test labelled and unstructured reports.

## Phase 2 — Correct and approve

- [x] Add focused UI tests before implementation: empty decision, correction context, successful navigation, failed submission retaining the draft, unavailable/stale source state, and no automatic execution.
- [x] Add a correction form to ExecutionView using existing getRun/getRunReview/startRun APIs. Fetch fresh execution/source state before submission, require an unchanged conflict and approved source, and preserve the operator draft on failure.
- [x] Pass the original plan, PR strategy, saved answers, full issues and operator decision into the new prompt run. Explain review, approval, and replacement execution next steps plus retained-work limitations.
- [x] Run focused factory/UI tests, Biome on touched files, both TypeScript checks, and the web build. Run the broader check once focused verification is green.

## Risks & Mitigations

- Historical reports lack structure: use existing text labels only when recognised and retain all original text.
- State can change while a form is open: reread and compare the execution conflict before creating a correction run.
- A replacement starts from its chosen base, not the old edits: state this before submission and include the retained workspace location as reference in the correction context.
- Prompt content includes saved answers already accessible to this run: keep this in planning context rather than displaying answers in issue cards.

## Verification

Automated: `pnpm -C payo exec vitest run modules/factory/src/execution.test.ts apps/web/src/features/run-workspace/ExecutionPlanIssues.test.tsx`; `pnpm -C payo check`; `pnpm -C payo web:build`.

Manual: open a paused plan-conflict execution; confirm labelled issue cards, full report, correction form, retained-work notice, and navigation to a planning run. Corrected plan must go through normal review and approval before implementation.

Results: `pnpm -C payo check` passed with 830 tests passing and one live test skipped; four existing reduced-motion CSS lint warnings remain. `pnpm -C payo web:build` passed with its bundle-size warning. Focused component tests passed again after simplifying the ExecutionView integration. Browser visual QA could not run because the browser access host is unavailable. No live planning/implementation run was started during verification.

## Non-goals

No replacement of plan-history APIs, in-place reapproval, workspace transfer, automatic approval, automatic implementation, or changes to agent output contracts.
