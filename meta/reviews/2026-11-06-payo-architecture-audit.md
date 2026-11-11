# Payo architecture audit: focused file splits

Audited 2026-11-06 against the current working tree, including uncommitted changes. Report only; no implementation changes.

Start with factory execution, then server composition, then planning commands. File length identifies candidates; ownership and dependency direction determine the split.

## Implementation follow-up

PA-01 and PA-02 were applied after this audit:

- Execution and planning implementations now live in focused `execution/` and `planning/` modules. The original entry files retain their public exports. Commit intent and reconciliation stay together.
- `domain/` owns execution transitions, validation decisions, resume eligibility/stage, plan approval, and phase-outline policy. Checkpoint loading moved to artifact persistence. Review reuses the execution checkpoint writer.
- Server composition retains construction and process lifecycle; `run-application.ts` owns commands and recovery, and `run-summary.ts` owns summary projection. Execution gate availability is projected by the factory.
- Added pure policy tests and factory domain/import-cycle checks. Public contracts and durable event formats are unchanged.
- Validation: full `pnpm -C payo check` passed with 845 tests passing and one live test skipped, including both TypeScript checks. After the final checkpoint-helper consolidation, TypeScript and 45 focused execution/review/boundary tests passed again. Four existing CSS lint warnings remain.

Optional UI and adapter file splits below remain outside these two architectural fixes. No live planning or implementation run was started.

## Scope and standard

Payo is a domain service: approved plans are immutable, execution pins an approved version, phase advancement requires receipts, and review/repair budgets control progression. A functional domain layer already exists in `execution-state.ts`, `phase-outline.ts`, and parts of `state.ts`; it is incomplete and mixed with application code. No class-based rewrite is necessary.

The composition root exists in `apps/server/src/composition.ts`, bootstrapped by `main.ts`. Configuration is loaded through server/config and packages/config; runtime factory dependencies mostly arrive through explicit ports.

Declared rules, `docs/payo/engine-design.md:50`: “kernel imports only contracts”; line 51: “Modules import kernel and contracts, never another module or an adapter.” Lines 52–57 require server-only adapter wiring and named package imports. These are enforced. The documented microkernel layout explains the package organization; it does not explicitly waive the target standard's internal domain/application separation. No explicit ADR waiving that separation was found.

## Confirmed findings

### PA-01 — Separate factory policy from orchestration before splitting stages

- **P2, high confidence; responsibilities.** Contracts: L2 and S1. Effort: medium, incremental.
- Locations: `payo/modules/factory/src/execution.ts:969`, `:2103`, `:2128`; `payo/modules/factory/src/commands.ts:987`; `payo/modules/factory/src/state.ts:40`.
- Evidence: `validatePhase` combines check execution and checkpoint writes with `if (cycle === MAX_VALIDATION_CYCLES)` decisions. Resume derives its next stage directly in the async command. Approval checks `current.plan.openQuestions.some(...)` alongside working-copy reads, workspace removal, and persistence. Meanwhile `execution-state.ts:169` already owns the pure implementation-review decision. `state.ts` mixes `decideReview` with `loadCheckpoint` storage access.
- Consequence: changing validation-budget, approval, or resume policy requires navigating orchestration and persistence, and policy ownership is split between state modules and command implementations. Moving chunks into smaller files without separating policy preserves this coupling.
- Counterevidence: there is an existing domain layer; this is not a claim that all rules are missing. Public handles return detached snapshots, and `applyExecutionCheckpoint` protects revision and receipt progression. No bypass or current data corruption was established.
- Smallest correction: move pure eligibility, validation-outcome, and resume-stage decisions into factory-owned domain modules; move checkpoint loading into the existing artifact/application persistence code. Application functions load evidence, ask the policy, and persist the result. Keep existing public exports and event formats.
- Verification tier: execution implementation and its state/handle contracts read in full; planning approval/update and state boundaries inspected directly.

Suggested execution organization, introduced gradually:

```text
factory/src/
  execution/
    domain/       checkpoint transitions, validation decisions, resume policy
    application/
      lifecycle.ts     accept/find/open execution
      run.ts           stage dispatcher
      prepare.ts       workspace and manifest preparation
      implement.ts     writer invocation and evidence capture
      validate.ts      checks, review and repair orchestration
      commit.ts        durable intent, reconciliation, phase/final completion
      resume.ts        inspect retained work and apply resume decision
      checkpoint.ts    the shared validated persistence operation
```

These are cohesive destinations, not a requirement to create every file in one change. Start with policy and commit recovery. Keep commit intent creation and reconciliation together. Keep checkpoint/event ordering in one owner; do not give each extracted stage its own persistence convention. Existing roles, artifacts, and review modules remain reusable.

Planning follows the same principle: split the 1,060-line `commands.ts` into lifecycle, planning loop, plan updates, and approval use cases only after isolating the corresponding decisions. Keep planning and execution within the factory package; they do not need new workspace packages or services.

### PA-02 — The server composition root also implements the application facade

- **P2, high confidence; responsibilities.** Contracts: D2 and L2. Effort: small to medium.
- Locations: `payo/apps/server/src/composition.ts:129`, `:286`, `:401`; factory-side contracts in `execution-handle.ts` and `types.ts`.
- Evidence: `createComposition` constructs SQLite/adapters/limiter and also defines `summaryOf`, command methods, execution deduplication, query sorting, and asynchronous dispatch. Summary projection contains `gate.kind === "execution-escalation" && executionSummary?.planIssues?.length ? [] : [...gate.allowedCommands]`.
- Consequence: changing available execution commands or run-list projection edits the process wiring module. Factory resume eligibility and the server's advertised command eligibility have separate ownership, so a future change must keep both aligned.
- Counterevidence: there is a real, discoverable composition root; lifecycle ownership and shutdown tracking belong there. `assertExecutionResumable` still enforces backend safety. This is not a missing-root or bypass finding.
- Smallest correction: extract a server run application facade with injected dependencies and a separate run-summary projection. Let factory expose execution command eligibility alongside its execution read model. Keep adapter construction, process shutdown, and resource ownership in composition. Preserve the existing `Composition` API for HTTP callers.
- Verification tier: complete composition and factory state/handle contracts inspected; exact resume and summary conditions checked.

## Smaller-file opportunities outside the architecture findings

These stay inside an existing owner and are code-quality refactors, not additional boundary violations. Suggested names are destinations, not new abstractions.

| Current file | Lines | Useful split | Priority |
|---|---:|---|---|
| `modules/factory/src/execution.ts` | 2,402 | Policy first; lifecycle, phase work, commit/recovery, resume | First, PA-01 |
| `apps/server/src/composition.ts` | 515 | Wiring/lifecycle versus run application facade and summaries | Second, PA-02 |
| `modules/factory/src/commands.ts` | 1,060 | Planning loop, plan-update commands, approval, lifecycle | Third, PA-01 |
| `apps/web/src/features/settings/SettingsPage.tsx` | 844 | `settings-form.ts` for document/form conversion and validation; local field components | Low-risk cleanup |
| `apps/web/src/features/plan-review/PlanReview.tsx` | 680 | A feature-local query/command hook; question and revision presentation components | After settings |
| `adapters/git/src/execution.ts` | 897 | Worktree ownership/path handling; snapshot/diff capture; commit operations | After deeper adapter review |
| `adapters/runner-pi/src/index.ts` | 606 | Pi record mapping; subprocess lifecycle; doctor probe | After deeper adapter review |

For settings, retain checks and implementer fields when building the saved document. For plan review, preserve refresh-before-command, conflict handling, cache invalidation, and drafts. For Git and Pi, retain every containment check, ownership check, cancellation path, and process-group cleanup. Those adapter recommendations are based on structural inspection, not a complete behavior review.

Leave `http.ts` alone initially: its route branches are largely transport validation and delegation. Its 504 lines are weaker evidence for a refactor than the responsibilities above. Do not create a generic workflow framework, generic form engine, or shared `utils` directory.

## Evidence and explicitly sound boundaries

- Named production package graph is acyclic: server → factory/kernel/config/adapters/contracts; factory → kernel/contracts; adapters → kernel/contracts; kernel/config → contracts; web → contracts; CLI → config/contracts. No production relative-import cycles were found by the literal-import scan. Computed imports were not resolved.
- Factory imports 14 kernel and 22 contracts references; it imports no adapter package. Server is the wiring hub. Adapters do not import one another in the inspected graph.
- Factory has 32 TypeScript source/test files and only one nested source directory, `infrastructure/`. Server has 26 source/test files with a flat source directory. Web has 53 source/test files and already groups connection, runs, settings, plan review, and run workspace by feature.
- Public factory handles clone state and expose read-only log access (`types.ts:72`, `execution-handle.ts:39`). Splitting files must preserve that ownership boundary.
- The filesystem boundary test keeps direct factory filesystem imports in infrastructure. Planning I/O is injected through `FactoryDeps.readPlan/writePlan`.
- Co-change over the available last twelve months: server/factory/contracts each appear in seven Payo commits and co-change in all seven. Kernel and runner-pi co-change in six. This is too little, too broad a history to prove a god module. Sampled `c601174` spans 29 files and multiple unrelated improvements; no finding relies on co-change alone.
- Vocabulary is coherent: plan version, approval gate, execution manifest, phase receipt, findings, and repair occur in both implementation and design documents. No terminology violation was established in the focused paths.

## Enforcement gaps

The package and web feature rules are useful but do not enforce the proposed factory policy/application boundary. After extraction, extend existing boundary checks to forbid domain imports of application/infrastructure, filesystem/process APIs, or server code; permit only pure domain dependencies. Add a literal-import cycle check and assert the chosen factory folder layout. No new dependency is necessary for these small checks.

The web checker explicitly permits imports such as `@web/features/runs/api.ts`; it does not enforce package-root-only interfaces between features. Whether these features should become bounded contexts was not established, so this is an unresolved design question, not an S5 finding.

## Validation and coverage

- `pnpm -C payo exec vitest run test/boundaries.test.ts`: **46 passed**.
- `pnpm -C payo exec vitest run test/web-boundaries.test.ts`: **19 passed**.
- `pnpm -C payo exec biome lint .`: **passed**, four existing reduced-motion CSS warnings; no fixes applied.

| Area | Boundaries | Responsibilities | Structure |
|---|---|---|---|
| Factory execution/state/handles | Checked | Checked in depth | Checked |
| Factory planning | Imports and state/handle boundaries checked | Approval/update sampled; remaining loop unverified | Checked |
| Server | Package edges and composition checked | Composition checked; routes sampled | Checked |
| Web | Package and feature checkers passed | Settings/plan-review sampled; other features unverified | Checked |
| Git/Pi adapters | Package edges checked | Function structure sampled; behavior unverified | Checked |
| Other adapters, kernel, contracts, config, CLI | Package graph/checker checked | Unverified beyond cited contracts | Inventory only |

This is a focused large-file/ownership audit, not certification of every Payo invariant. Security, performance, test strategy, and a full tactical-DDD/value-object audit were not performed. No full functional suite or live execution was run because no implementation changed. During extraction, the main risk is changing durable checkpoint/event ordering or losing recovery validation; retain existing recovery tests and add pure policy tests where those rules become independently callable.
