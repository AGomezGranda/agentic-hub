# Plan Review: Payo approved-plan execution through the core engine and CLI

**Date:** 2026-11-02
**Target:** meta/plans/2026-11-02-payo-plan-execution.md
**Review:** 1
**Verdict:** REVISE

## Assessment

This is a strong, unusually well-grounded plan. Every file:line anchor in Current State checks out, the proposed layering matches the existing hexagonal boundaries, and the safety model (engine-owned checks and commits, immutable snapshots, fresh contexts, retained worktrees) is coherent. The baseline is green: the Phase 1 test command, `tsc`, `biome`, and the full core suite all pass. The plan is not ready to implement yet because a few cross-phase seams are contradictory or unspecified, and one shared-config change silently destroys operator settings through the existing web surface.

## Coverage

- **Reviewed:** Correctness, Architecture & Patterns, Test Coverage, Plan Mechanics, Security/Safety, Data & Compatibility. Performance was skipped: this slice has no hot path or data-processing workload, and its latency is dominated by external agents and subprocess checks.
- **Verified:** all Current State anchors; all named existing files/symbols; the Phase 1 automated commands; `tsc`; `biome`; targeted tests (13 files, 172 tests); full core suite (40 files passed, 1 skipped; 567 tests passed, 1 skipped).
- **Not verified:** real Pi process-group behaviour, real Git commit-hook behaviour, and model quality. Those are explicitly manual/empirical in the plan.
- **Previous reviews:** none for this plan.

## Cross-Cutting Themes

- **Compatibility with existing surfaces.** The plan adds fields to `PayoConfigDocument` and `roles` that the supported web Settings page reconstructs from a partial form. The plan's automated gates exclude `apps/web`, so the resulting config loss would not be caught.
- **Cross-phase seams.** Phase 1 is described as independently green, but `beginExecution` needs execution role snapshots that Phase 2 introduces. The final-repair path is described correctly in prose but contradicted by the flow diagram.
- **Deterministic claims that lack a structured contract.** Prerequisite checking and nested-instruction discovery are described as engine behaviour but have no data shape or algorithm in the plan; the current plan schema cannot express the former.

## Findings

### Critical

- **[API/Compatibility] Phase 1 config + Phase 2 roles — web Settings save silently deletes new execution config.**
  `PayoConfigDocument` is the document the web Settings page loads and saves (`payo/apps/web/src/features/settings/SettingsPage.tsx:598-750`). On save, `buildCandidate` reconstructs `execution` as `{ max_concurrent_agents }` only (`:724`) and iterates the hard-coded `ROLES = ["planner", "reviewer", "verifier", "reviser"]` list (`:11`, `:739-750`). Adding `execution.checks` and `roles.implementer` therefore means any operator who edits and saves settings loses those values, after which `implement` is rejected for missing checks or a missing implementer model. The plan's success criteria exclude web (`payo/vitest.config.ts` excludes `apps/web/**`; `payo/tsconfig.json` excludes `apps/web`), so no gate catches this. Fix: preserve the loaded `execution.checks` and `roles.implementer` when the form does not expose them (or expose them), add a SettingsPage test that a save round-trips both, and add the web test/build to the phase gate or explicitly verify the preservation another way. This is a one-field preservation fix, not web feature work.

### Major

- **[Plan Mechanics/Correctness] Phase 1 `beginExecution` cannot be implemented as specified without the Phase 2 execution roles.**
  Phase 1 adds `beginExecution` and says `ExecutionRunConfig` stores "role artifacts/provenance" (`meta/plans/2026-11-02-payo-plan-execution.md:351-360`). Phase 2 is where `execution-roles.ts` defines `execution-preparer`/`implementer` and where the separate execution role loader is added (`:448-457`). There is no Phase 1 source for the execution role snapshots, so Phase 1 is either wired with planning roles under execution names or left with a placeholder. Fix: make the role-snapshot seam explicit in Phase 1 (for example, `beginExecution` accepts an already-snapshotted execution role map from the caller/composition, with Phase 1 tests using a fake map), or move the execution-role definitions into Phase 1. Add a Phase 1 test asserting the stored config contains the expected execution role artifacts.

- **[Correctness] Prerequisite checking has no contract in `ExecutionManifest`.**
  The plan says preparation checks that "prerequisites named in the approved plan are present in the selected base" and rejects PR-list order as a dependency signal (`:120-125`). Phase 4 tests then require missing named prerequisites to gate preparation while an independent later PR is not rejected (`:648-651`). But `ExecutionManifest` is defined with only selected PR ID, ordered phases, and `issues[]` (`:171-178`), and the approved plan schema has no dependency field (`payo/packages/contracts/src/factory.ts:46-53`). A model reading markdown is not a deterministic check, and "present in the selected base" has no defined subject (branch ancestry? files? markers?). Fix: add an explicit prerequisites shape to `ExecutionManifest` (for example `{description, ref?}` or `{description, paths?}`), define the engine check (ancestry of a ref, presence of named paths, or an operator-provided predicate), and test both the gate and the independent-PR case with that shape. Otherwise, remove the deterministic prerequisite claim from Phase 4.

- **[Correctness/Test Coverage] "Applicable nested repository instructions" has no discovery rule and no test.**
  The plan requires reading repository instructions at the execution base for root and applicable nested scopes, recording them as artifacts, and passing them explicitly (`:196-201`). Pi disables automatic context-file loading, so the engine must do the discovery. "Applicable" is left undefined: the preparer's phase record has only excerpts and acceptance criteria, and the writer has not edited yet, so changed-file scope is unknown. There is also no test in the phase lists for root+nested instruction loading, only a conformance-reviewer sentence. Fix: load a bounded set of instruction files at the base into a path→content artifact, define which filenames/scopes are recognized, pass the map to the writer and conformance reviewer, and add a fixture repo test with a root file and a nested file. If the intent is for the model to discover them, say so and give it `find`/`ls` explicitly; do not claim the engine reads "applicable" scopes without a rule.

- **[Security/Safety] The kernel's bounded cleanup can still release the limiter before a write child's process group exits.**
  The plan correctly states that the minimum hardening is process-group termination and waiting for exit before another writer/check starts (`:302-306`, `:440-447`). But `streamAttempt` currently awaits runner cleanup for at most one second and then proceeds (`payo/packages/kernel/src/agent-step.ts:292-301`; the Pi adapter uses a 2s kill grace, `payo/adapters/runner-pi/src/index.ts:44`). Changing only the Pi runner's `finally` is not enough: the kernel's `Promise.race` can time out first, release the limiter, and allow the next writer while a descendant is still alive. Fix: for write specs, await runner cleanup without the 1s cap (or with a write-specific bound greater than the kill grace and an explicit failure if it is exceeded), and add a test that a slow-dying fake descendant blocks the next writer/check. The existing manual stop-the-server check is necessary but not sufficient.

- **[Compatibility] Phase 1 makes new rubric files required at startup for every existing target repository.**
  `loadRoleSources` reads all configured role resources from the target repo at the configured base and throws if any are missing (`payo/apps/server/src/role-sources.ts:54-95`). Phase 1 adds eight required files (`:328-337`) and says missing resources must fail role readiness visibly. Any existing target repo that has only the three current skill files will therefore fail planning startup after Phase 1, before the Phase 4 documentation update. `docs/payo/usage.md:15-17,100` still states the old requirement. Fix: either load the new rubrics from the Payo skill source rather than the target repo, or make Phase 1 include the migration/documentation change and an actionable doctor error. Add a compatibility test: a repo with the old skill set fails with a message that names the missing rubric, and the documented upgrade path makes it pass.

- **[Correctness/Plan Mechanics] The execution-flow diagram contradicts the final-repair prose.**
  The prose says "Final repair returns to final checks/review, not to phase advancement" and that final repairs have their own bounded cycles and evidence (`:166-167`, `:613-617`). The diagram routes final-review findings through `H → E → F → G → I`, which is the phase check/review path, then `I` records a phase receipt and returns to `J` (`:145-164`). That replays the last phase's review and receipt and mixes the phase budget with the final budget. Fix: draw a separate final-scope loop (final repair → final checks → full PR diff review → final verifier → final result commit → `reviewed`) and state that it does not write another `PhaseReceipt` or consume a phase cycle. Add a test that a final repair consumes only the final budget and does not duplicate the last phase receipt.

- **[Plan Mechanics/Correctness] `implementer` role configuration conflicts with the existing all-roles startup assertion.**
  The plan says to add only `implementer` to configurable roles and that a missing implementer model blocks implementation acceptance only (`:452-457`). Existing code requires a model for every entry in `PAYO_ROLES` at real-mode startup (`payo/packages/config/src/index.ts:17`, `payo/apps/server/src/config.ts:90`). If `implementer` is added to `PAYO_ROLES`, every existing real-mode config fails startup, contradicting "legacy planning config remains valid." If it is not added, the plan does not say how the role is resolved or typed. Fix: keep a planning-role set for startup validation and resolve an optional execution-role set separately; validate `implementer` at execution acceptance. Test both: startup without `[roles.implementer]` succeeds, and `implement` returns an actionable rejection.

### Minor

- **[Architecture] The Git-adapter bullet assigns checkpoint persistence to the adapter.**
  Phase 2's `createExecutionWorkspace` bullet says "Store prepare/commit intent in the execution checkpoint before performing the operation" (`:428-434`). Intent persistence is factory orchestration; a Git adapter that touches execution checkpoints would violate the ownership table and the adapter boundary. Reword so the factory records intent and the adapter takes a branch/idempotency key, or move that sentence to the factory lifecycle changes.

- **[Code Quality/Correctness] Snapshotting `QUALITY_EXPECTATIONS` into role content leaves the original Git SHA as the role-spec SHA.**
  `snapshotRole` stores `source` with `sha` and `content` (`payo/modules/factory/src/roles.ts:19-36`), and `roleSpec` records `roleSpecSha: source.sha` (`:71`). If `snapshotRole` appends new instructions to `content`, the recorded SHA no longer describes the snapshotted instructions. The content-addressed role artifact still identifies the bytes, so this is an audit clarity issue rather than a runtime failure. Fix: store the addendum as a separate `RoleSource` field (rendered by `roleSpec`, snapshotted by `snapshotRole`), or record a composed content hash alongside the source SHA.

- **[Test Coverage] Phase 1's automated gate is a subset of the affected suite.**
  The Phase 1 command runs `packages/contracts/src packages/config/src modules/factory/src` plus two server tests (`:398`). Changes to `snapshotRole`/`roleSpec` also affect `apps/server/src/factory-flow.test.ts` and persistence fixtures. The full core suite is fast (about 9 seconds in this working tree), so the phase gate should run `--project core` like Phases 2-4. This removes the chance of a green Phase 1 that breaks a server test.

- **[Test Coverage] Several designed branches have no listed test.**
  The plan has strong coverage, but these are absent from "Tests first": a check that modifies the snapshot and must be rerun (and the three-dirty-cycle escalation), a conflicting explicit `--base` when an execution already exists, a writer that runs `git commit`/changes HEAD and must be escalated, and the web config round-trip above. Add focused cases; they map directly to stated invariants rather than duplicating convergence tests.

- **[Plan Mechanics] `checked-unreviewed` has no named checkpoint/status field.**
  Phase 2 requires an `Escalated` checkpoint with reason `review-unavailable` and status detail `checked-unreviewed` (`:420-424`), but the Phase 1 `ExecutionCheckpoint` field list does not include an escalation/status-detail field (`:342-350`). Either name the field (or derive it deterministically from stage/scope/gate kind) and include it in `ExecutionSummary`, or drop the status-detail requirement.

- **[Plan Mechanics] `payo/<execution-id>` is ambiguous between branch name and worktree path.**
  The plan says "Create `payo/<execution-id>` in a dedicated worktree" (`:286`) while the existing worktree root is `<data_dir>/worktrees/<run-id>` (`payo/apps/server/src/adapters.ts:142`). Specify whether `payo/` is the branch prefix, the path, or both. The adapter tests already cover path escapes and collisions; the plan should state the expected layout so the test fixtures are unambiguous.

### Suggestions

- **[Security] No-push enforcement.** Prompts forbid pushing, but a writable `bash` agent with network access and credentials can still run `git push` or `gh`. The trust-boundary documentation is honest, but if "no GitHub publication" is a hard slice invariant, add a post-writer check of remote refs/reflog (or a no-network/no-credential environment for write sessions) and state the limit. If it is an accepted prompt-level guarantee, say so explicitly in the risks table.
- **[Performance] Bound diff/artifact size.** Check logs are capped at 1 MiB each, but the engine-captured diff passed to reviewers and the role instructions are not bounded. A large generated diff can exceed `GitExec`'s 16 MiB buffer or produce a very large artifact. Define a cap and truncation marker, as the plan already does for checks.
- **[Documentation] Phase 1 should update `payo/config.example.toml` and the usage requirements when it adds `execution.checks` and the new rubric dependency.** Phase 4's docs sweep is too late for an operator who upgrades Phase 1.

## Strengths

- Every Current State reference verified against the working tree; the plan is unusually honest about uncommitted state and does not claim HEAD.
- The dependency direction is sound: contracts hold shapes, kernel holds generic attempts/checks/workspace ports, factory holds execution policy, adapters stay infrastructure, and server/CLI remain composition/driving surfaces.
- The safety model is strong and concrete: engine-run checks, immutable workspace fingerprints, fresh contexts per attempt, engine-owned commits, commit-intent reconciliation, retained worktrees, and no force-removal path.
- The plan explicitly rejects a generic workflow framework, registry, DI container, and extra bounded context, and it names what is out of scope.
- The test-first list is detailed at the unit, integration, persistence, and end-to-end levels, and it correctly distinguishes deterministic orchestration tests from model-quality smoke evidence.
- The quality policy is proportionately stated: DDD/architecture and code-quality are mandatory, but the plan warns against inventing aggregates and layers for small changes.

## Recommended Changes

1. Fix the web Settings preservation of `execution.checks` and `roles.implementer`, and add a web test (addresses the Critical finding).
2. Add an explicit execution-role snapshot seam to Phase 1, or move execution role definitions earlier; remove the Phase 1/Phase 2 dependency (addresses Major `beginExecution`).
3. Define `ExecutionManifest.prerequisites` and the engine's deterministic presence check; update Phase 4 tests (addresses Major prerequisites).
4. Define repository-instruction discovery, pass a bounded path→content map, and test root+nested scopes (addresses Major nested instructions).
5. Remove the 1s cleanup race for write specs and add a next-writer/next-check blocking test (addresses Major process cleanup).
6. Decide how new rubrics reach existing target repos; add the migration/doc change and an actionable missing-resource test (addresses Major compatibility).
7. Split the final-repair flow from the phase loop and test the separate final budget/receipt behavior (addresses Major final-repair flow).
8. Separate planning-role startup validation from optional execution-role resolution; test startup and acceptance without an implementer model (addresses Major `implementer`).
9. Reword the Git-adapter intent sentence, clarify `payo/<execution-id>`, and name the `checked-unreviewed` field (addresses Minor mechanics).
10. Run the full core suite in Phase 1 and add the missing focused tests (addresses Minor test coverage).
