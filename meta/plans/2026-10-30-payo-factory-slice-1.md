---
date: 2026-10-30
title: Payo step 4 — factory slice 1 on fakes
status: draft
---

## Scope

Implement roadmap step 4: FetchTicket → Plan → PlanReview ⇄ Revise → Approval → Approved, with escalation and explicit resume. Deliver plain library commands and tests using fake tickets, workspaces and agents. The user accepted three phases, fixed review lenses, and request-changes that re-reviews the edited plan without a separate feedback message.

## Current State

- `docs/payo/implementation-roadmap.md:68` defines the scope and exit criteria; `docs/payo/engine-design.md` supplies the state diagram and durability rules.
- `payo/modules/factory/src/index.ts:1` is empty. Its package already depends on kernel and contracts.
- `payo/packages/kernel/src/agent-step.ts:46` runs bounded attempts with output validation and one retry. Its failure gates currently allow retry/abandon (`:287`); factory must reconcile these gates before advancing.
- `payo/packages/kernel/src/fanout.ts:47` collects checked/unchecked results. A fulfilled task returning a failed StepResult still needs conversion to unchecked by factory policy.
- `payo/packages/kernel/src/run-log.ts:15` serializes event writes, but does not serialize command decisions and filesystem effects.
- `payo/packages/kernel/src/run.ts:84` marks interrupted attempts and gates unfinished steps on recovery. It does not resume work automatically.
- `payo/packages/kernel/src/state.ts:185` deduplicates artifacts by hash. Factory history must read ordered events, not infer version order from RunState.artifacts.
- `payo/packages/kernel/src/state.ts:66` rejects run completion with running steps/attempts or open gates.
- `skills/review-plan/references/lenses.md:1` defines plan lenses. `pi/workflows/swarm.js:52` supplies verification rules and classifications, not the applicable lens catalog.
- `payo/test/boundaries.test.ts` and `payo/biome.json` prohibit module-to-adapter imports, including module tests. Composition tests belong under apps/server, which already depends on the fake runner and SQLite adapter.

## Design Decisions

### Ownership and persistence

Keep TicketSource and Workspace interfaces in kernel and their data schemas in contracts, so later adapters do not import factory. Keep factory decisions, projections and role instructions in factory. Reuse RunStore, RunLog, runAgentStep, jsonEnvelope and the shared Limiter; add no generic workflow framework or new event union member.

Persist factory checkpoints as JSON artifacts with kind `factory-checkpoint-v1`. Record their artifact events in the same RunLog batch as the corresponding gate/step transition. Each checkpoint contains an increasing revision, stage, cycle, round, ticket/workspace references, current plan reference, last agent plan reference, question answers, review reference, and optional approval metric reference. Rebuild by reading the last matching artifact.recorded event in sequence and validating its bytes. Artifact writes precede the event batch; an unreferenced blob after a failed commit is harmless. Include revision in checkpoint bytes so repeated logical states remain distinguishable.

Use a short-lived step per factory operation, including ticket/workspace acquisition. Before external work, commit a checkpoint with a durable in-flight operation marker identifying its stage and owned step IDs; clear it only in the batch that commits the operation's result and next checkpoint. On open, after kernel recovery, an uncleared marker means the operation is incomplete even if all its steps already finished. Create a factory-owned recovery step and resume gate if one is not already open, and expose the run as blocked without replaying work. Resume closes the owned recovery and interrupted gates, finishes any remaining owned running steps, and restarts from the durable stage with fresh step/attempt IDs; completed checkpoints are not replayed. TicketSource.get is read-only; Workspace.create must be idempotent for a run, and remove must tolerate an absent workspace.

### Review policy

Use these seven fixed lenses: architecture, security, test coverage, code quality, correctness, simplicity, compatibility. Preserve their briefs from the plan lens catalog in `roles.ts`; no selector agent. Record the chosen set in effective run configuration.

Verifier verdicts use BLOCKER, NON-BLOCKER, STALE, INVALID, SPECULATIVE. Only BLOCKER findings with severity P0/P1 prevent convergence; NON-BLOCKER explicitly means outside this slice. Preserve other verdicts for inspection. Require a verdict covering every input finding exactly once (merged findings list all source IDs), with no unknown IDs; INVALID requires counter-evidence. A missing or failed lens blocks convergence independently of verifier output.

A cycle has up to three review rounds. Blocking findings in rounds 1–2 trigger revision; blocking findings in round 3 escalate without a fourth automatic round. Unreconciled findings from the reviser escalate immediately. Failed lenses or failed planner/verifier/reviser steps also pause for intervention rather than repeatedly burning review rounds. Explicit resume or requestChanges starts a new cycle at round 1; retain all prior cycles and versions.

### Human edits and commands

Expose `start(deps, input)`, `answer(handle, input)`, `approve(handle)`, `requestChanges(handle, {signal})`, `resume(handle, {signal})` and `openFactory(deps, runId)` from factory. All return `Promise<FactoryHandle>`; openFactory never launches agents. The handle owns one RunLog, the current checkpoint and a command-in-progress guard. Concurrent commands reject as busy; agent fan-out writes share the existing log. Step 5 must keep one handle per run. expectedSeq remains the defense against a second process.

`FactoryDeps` contains store, runner, limiter, tickets, workspace, dataDir and roleSources. `StartInput` contains runId, ticketKey, repo, baseBranch, per-role model/timeout configuration and signal; subsequent commands take a signal through their input where they launch agents. `answer` takes questionId and nonblank text. RoleSources supplies each role's repo-relative skill path, resolved git SHA and skill content with the referenced resources needed by the role. Composition must obtain the content from that exact git revision, rejecting missing or mismatched sources; tests provide fixture content and SHAs, and live resolution belongs to step 6 composition. At start, store the content as immutable artifacts and freeze their references, paths and SHAs in the run configuration. Each attempt uses those artifact bytes as instructions and inputs, not files in the target workspace, so later checkout changes cannot alter a run or falsify its provenance.

The working copy is `<dataDir>/runs/<runId>/plan.md`. Factory uses Node filesystem functions directly in `plans.ts`; there is no filesystem abstraction solely for tests. Validate runId as a safe single path segment before any filesystem operation, reject symlink run directories/files, and write through a sibling temporary file plus rename. Tests use temporary directories. Read the working copy once per command; the snapshotted bytes are the command's input. Reject missing/unreadable files without changing gates or state.

Questions have stable IDs. Answer records are authoritative, separate from editable prose. Append a generated answer section when taking a human snapshot, preserving the user's other text. Reject malformed or duplicated generated-section delimiters rather than deleting ambiguous content. Revision retains answered question IDs and answers; new questions start unanswered, and removed questions are retained in history but no longer block approval. Never infer answers from arbitrary prose edits.

Approve snapshots the working copy, adds recorded answers, rejects any unanswered current question, and records the final artifact and quality metric before ending the run. Human approval can accept edits without another agent review, as the design specifies; requestChanges explicitly re-reviews edits. The PR strategy in the human-approved markdown is authoritative; the planner's structured strategy remains provenance, not an executable instruction for later slices.

## Implementation progress

- [x] Phase 1 — contracts, review decisions, ordered checkpoint and plan artifacts, working-copy helpers, seams, and fixtures.
- [x] Phase 2 — planning and review loop.
- [x] Phase 3 — human approval and complete flow.

Phase 1 verification: Node 24.11.1; focused tests and full Vitest suite (236 tests), Biome, and TypeScript passed using the installed workspace binaries. The pnpm shim did not select the pinned version in the sandbox. Inspected a fixture checkpoint, version, markdown and relative role path. Actual role configuration is created in Phase 2, so verify its recorded provenance and paths there.

Phase 2 verification: focused role and flow tests and the full workspace checks passed on Node 24.11.1 using the installed workspace binaries (249 tests, Biome and TypeScript). Inspected the three-round fixture checkpoint and structured review artifacts; role paths and SHAs are recorded in effective configuration and role bytes are snapshotted. The pnpm shim limitation from Phase 1 remains; no live agent or adapter was used.

Phase 3 verification: focused metrics, flow and SQLite persistence tests and the full workspace checks passed on Node 24.11.1 using the installed workspace binaries (263 tests, Biome and TypeScript). The pnpm shim limitation remains. Inspected the approved fixture markdown, replacement diff and original agent version by hash. SQLite recovery tests cover a completed planner with an uncommitted result and multiple interrupted review attempts. Approval also checks for unrelated running work before workspace cleanup.

## Phase 1 — Contracts and factory foundations

### Overview

Define validated role envelopes and durable factory state, then establish ticket/workspace seams and artifact persistence. No agent workflow launches yet.

### Changes

- Add `payo/packages/contracts/src/factory.ts`, export it from contracts `index.ts`. Define Ticket `{key,title,description,url: string|null}`; OpenQuestion `{id,question}`; PlanOutput `{markdown,prStrategy:[{id,title,phases:string[]}],openQuestions:OpenQuestion[]}` with nonempty markdown/strategy and unique IDs. Define Finding `{id,severity:P0|P1|P2,title,path,line,evidence,consequence,suggestedFix}`; ReviewOutput `{findings:Finding[]}`; VerifiedOutput `{verdicts:[{sourceIds:string[],classification,severity,reason,counterEvidence:string|null}]}`; RevisionOutput `{plan:PlanOutput,unreconciledFindingIds:string[]}`. Validate references against actual inputs in factory, in addition to shape validation.
- In that file define FactoryStage (the seven stages in Scope), FactoryCheckpoint with the fields and in-flight operation marker in Persistence, and PlanVersion `{number,source:agent|human|answer,markdown:ArtifactRef,plan:PlanOutput,answers:Record<string,string>}`. Store plan version metadata as JSON with kind `factory-plan-version-v1`; the markdown itself is a separate text/markdown artifact. References in checkpoints point to these metadata artifacts. Nullable fields are explicit until their stage supplies them.
- Add `payo/packages/kernel/src/workspace.ts`: `TicketSource.get(key:string):Promise<Ticket>` and `Workspace.create(runId:string,repo:string,base:string):Promise<string>`, `remove(path:string):Promise<void>`. Export through kernel `index.ts`.
- Add `payo/modules/factory/src/state.ts`: load/validate checkpoints from ordered events; `decideReview` maps verified output, unchecked lenses and round to Approval/Revise/Escalated. Add `artifacts.ts` for storing plan/checkpoint JSON and batching artifact events; do not replace the existing store implementation.
- Add `payo/modules/factory/src/plans.ts` for path validation, safe working-copy reads/writes and answer rendering. Add `types.ts` for FactoryDeps, StartInput and FactoryHandle. Export the public types through factory `index.ts`.
- Add `payo/apps/server/src/factory-fixtures.ts` with in-memory TicketSource and Workspace implementations and scripted envelope builders for composition tests. Use existing createFakeRunner there; no new adapter package or boundary exception.

### Tests first

- Unit: `packages/contracts/src/factory.test.ts`: valid envelopes; empty plan/strategy; duplicate question/finding/PR IDs; invalid severity/classification and malformed checkpoint fields.
- Unit: `modules/factory/src/state.test.ts`: convergence only for complete coverage and no P0/P1 BLOCKER; round-three escalation; invalid/missing verdict references rejected; preserve version order even when markdown hashes repeat.
- Filesystem integration: `modules/factory/src/plans.test.ts`: traversal/symlinks rejected; missing working copy fails; answers preserve user text and render once; ambiguous delimiters fail; old immutable artifacts remain unchanged.

### Success criteria

- Automated, from repo root: `rtk proxy pnpm -C payo exec vitest run packages/contracts/src/factory.test.ts modules/factory/src/state.test.ts modules/factory/src/plans.test.ts`; then `rtk proxy pnpm -C payo check`.
- Manual: inspect one fixture checkpoint and referenced plan version; confirm human-readable markdown and no absolute skill paths in recorded role configuration.

### What we're NOT doing

No adapter implementations, schema migrations, extra storage tables, generic workflow event schema or lens selector.

## Phase 2 — Planning and review loop

### Overview

Run a fake ticket to Approval or Escalated, with durable checkpoints, bounded review cycles and explicit recovery.

### Changes

- Add `payo/modules/factory/src/roles.ts`: render planner/reviser instructions from create-plan and reviewer/verifier instructions from review-plan using the recorded immutable role sources. Supply the snapshotted skill content and required resources directly to each attempt; do not rely on `renderInstructions`'s path-only pointer resolving in the target workspace. Override interactive behavior: read-only tools, no user conversations or nested agents, JSON-only envelope, engine-owned artifacts. All roles receive ticket and relevant version/review artifacts; no previous session is reused.
- Add `payo/modules/factory/src/review.ts`: call runAgentStep per lens through fanOut, sharing the supplied Limiter. Treat any non-succeeded StepResult as unchecked. Run verifier over successful reports and explicit unchecked lens IDs. Validate complete verdict coverage before deciding convergence. Persist reports, verdicts and unchecked coverage.
- Add `payo/modules/factory/src/commands.ts`: implement start, openFactory and resume; acquire ticket/workspace, record effective config, run planner, review and revise with fresh IDs. Save each successful agent plan before the next transition, and expose working copies at Approval and Escalated.
- Reconcile kernel failure gates explicitly: resolve underlying retry/abandon gates with `retry` only on authorized resume, and interrupted gates with `retry`; finish remaining interrupted steps as failed before starting replacements. Factory escalation gets its own step/gate allowing resume. Resume resolves only gates owned by the interrupted factory operation, atomically with its checkpoint; unrelated open gates reject advancement.
- For interrupted FetchTicket/Plan, resume the recorded stage; for review/revision escalation with a plan, snapshot the current working copy and return to PlanReview in a new cycle. Do not overwrite an existing edited working copy when opening/recovering a run. An absent file can be reconstructed from the recorded plan only through explicit resume.
- Catch acquisition failures and cancellation and persist Escalated with a reason and resumable stage. Never mark failed or cancelled work clean. Workspace remains available while paused; release at Approved in phase 3.
- Export these functions from `payo/modules/factory/src/index.ts`. Add `payo/apps/server/src/factory-flow.test.ts` for fake composition. Keep server main and CLI unchanged.

### Tests first

- Unit: `modules/factory/src/roles.test.ts`: read-only spec, recorded SHA, correct contract and artifact inputs; plan lenses rather than diff lenses. Verify a workspace without skill files uses the snapshot, and changing the source before resume does not change attempt instructions or recorded provenance.
- Component: `apps/server/src/factory-flow.test.ts`: clean first review; P1 then revision then clean; P2/non-blockers permit Approval; three blocking rounds escalate; unresolved revision escalates immediately; failed lens cannot converge even if verifier says clean; malformed verifier references use output-validation retry and then gate.
- Component: same file: planner/agent failure and cancellation pause; resume starts fresh attempts, clears owned gates and increments cycle; duplicate command rejects; openFactory rehydrates without agent calls. Reuse existing kernel tests for timeout and generic invalid-then-valid mechanics instead of duplicating that matrix.

### Success criteria

- Automated: `rtk proxy pnpm -C payo exec vitest run modules/factory/src/roles.test.ts apps/server/src/factory-flow.test.ts`; then `rtk proxy pnpm -C payo check`.
- Manual: inspect a three-round fixture's checkpoints and reports; confirm each decision is explained by structured output, not prose heuristics.

### What we're NOT doing

No automatic retries of unchecked review rounds, no live LLM, no HTTP, no CLI commands, no automatic replay on restart.

## Phase 3 — Human approval and complete flow

### Overview

Finish the public command surface and verify durable edited-plan approval through the real store with fake external services.

### Changes

- Implement answer, approve and requestChanges in `modules/factory/src/commands.ts`. Allow answer at Approval and Escalated; require a known current question and nonblank response. Answer persists a new version and updates the generated working-copy answer section without launching agents. Approval remains gated until all current questions are answered. Reject commands at incompatible stages and after Approved.
- requestChanges snapshots edits and answers, resolves the approval gate and launches a new review cycle. It accepts no free-text feedback parameter. Revised outputs carry forward answers by stable question ID; semantic question changes must use a new ID and are covered by role instructions and fixtures.
- Add `modules/factory/src/metrics.ts`: produce an exact, deterministic line replacement diff between last agent markdown and approved markdown by removing common prefix/suffix and recording the removed/added middle arrays, prefix line count and both hashes. Store as `factory-approval-diff-v1` JSON with changed boolean and replaced line counts. This is a reconstructable single-hunk diff, not a minimal edit-distance metric; label counts accordingly and document that limit in a `shortcut:` comment. No dependency solely for diff rendering.
- Approval stores final plan/version and diff artifacts, then removes the workspace and atomically resolves approval gate, finishes its step, checkpoints Approved and records run.ended. If cleanup fails, retain Approval and artifacts for an explicit retry; Workspace.remove must be idempotent. Keep plan working copy and immutable artifacts after completion. Do not delete the working copy on cleanup or reopen.
- Add `payo/apps/server/src/factory-persistence.test.ts`: wire createSqliteRunStore with fake sources/runner, temporary data dir and real working-copy files. Reconstruct handle after close/reopen at gates and interrupted operations.
- Update `docs/payo/implementation-roadmap.md` step 4 with the fixed lenses, cycle/reset rules and edited-file-only requestChanges decision. Do not mark later steps complete. Update the fake runner's test-wiring comment to include step 4.

### Tests first

- Unit: `modules/factory/src/metrics.test.ts`: unchanged, insertion/deletion, trailing newline and multi-region edits; applying the recorded replacement reconstructs approved bytes exactly.
- Component, extend `apps/server/src/factory-flow.test.ts`: unanswered question rejects approval without gate changes; answer then approve; unknown/blank answer rejected; edits survive answer; requestChanges snapshots exact edits and invokes review; repeated answer replaces prior answer; new revision questions block approval; approved run rejects mutation; workspace cleanup failure remains retryable.
- Integration: `apps/server/src/factory-persistence.test.ts`: ticket → Approval → edit/answer → Approved against SQLite; reopen Approval with answers and edited file preserved; interrupted planner requires explicit resume; reopen Escalated then resume; failure between artifact write and event batch does not advance state; missing/ambiguous working copy leaves the gate open. Inject a crash after a successful agent step finishes but before its result checkpoint, then reopen and verify it is blocked until explicit resume. Interrupt multiple review lenses, reopen and verify resume clears all owned gates and running steps, while an unrelated open gate prevents advancement. Assert no running steps or open gates remain after Approved.
- Keep module policy tests fast; SQLite verifies persistence and filesystem boundaries only. No new HTTP/CLI end-to-end harness before step 5.

### Success criteria

- Automated: `rtk proxy pnpm -C payo exec vitest run modules/factory/src/metrics.test.ts apps/server/src/factory-flow.test.ts apps/server/src/factory-persistence.test.ts`; then `rtk proxy pnpm -C payo check`.
- Manual: inspect final fixture markdown and diff artifact, confirm the question answer and human edit are present, and confirm the original agent version is still readable by hash.

### What we're NOT doing

No editor launcher, UI, implementation, extra repositories, real Jira/git/Pi adapters, feedback-message reviser command, or automatic execution of the approved PR strategy.

## Risks & Mitigations

- Checkpoint/event consistency → batch transition events with checkpoint references; validate checkpoint artifacts on read; retain an in-flight marker until result commit and gate it on reopen, including after a step already finished; test interrupted operation boundaries and orphan blobs.
- Working file and event log are not one transaction → immutable snapshots are authoritative; never overwrite an existing edited file during reopen; report failed writes and retain gates. Document the bytes actually snapshotted by each command. External editor writes during a command are outside the single-writer guarantee; the user should save before invoking commands.
- Concurrent commands → one handle and busy guard per run, plus expectedSeq rejection. Multi-process command ownership remains outside this slice; step 5 supplies the single local host.
- Incorrect verifier omissions → validate source-ID coverage, classification and severity before convergence; missing lenses remain unchecked regardless of verdict prose.
- Fixed lenses miss specialized concerns → record exact coverage; validate on the real-ticket corpus in step 7 before adding selection logic.
- Question identity is semantic → require new IDs when meaning changes and retain answer provenance; live role quality must be evaluated in step 7.
- Cleanup interrupted after removal → idempotent Workspace.remove permits explicit approval retry; retained artifacts and working copy avoid plan loss.
- Compatibility/rollback → no existing event/schema migration. New checkpoint kinds coexist with old runs. Reverting factory code leaves its runs inspectable as generic logs/artifacts, but cannot resume them; preserve their data and restore the matching factory version to continue.

## PR Strategy

Three ordered PRs, one per phase. Phase 1 adds independently tested contracts/persistence helpers; phase 2 delivers a runnable flow to a gate; phase 3 delivers the full accepted command surface and durable approval. Each depends on the preceding PR. No deployment or data migration is needed.

## Plan validation

All roadmap step 4 requirements map to the three phases above. Commands and schema names are shared across phases. Implementation must run each phase's checks on Node 24 and the existing pnpm workspace; this planning change does not claim those tests have been implemented or run.
