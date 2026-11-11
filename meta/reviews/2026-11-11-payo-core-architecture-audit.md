# Payo core architecture and code-quality audit

Date: 11 November 2026. Reviewed the current working tree, including staged, unstaged, and untracked Payo changes. No implementation files changed.

## Implementation progress

- [x] A1: detach run-log state at its ownership boundaries.
- [x] C4: include the architecture standard and structure references in new role snapshots and review prompts.
- [ ] A2, A3, A4, A5, C1, C2, C3 and remaining enforcement gaps.

A3 still requires a decision on approximate telemetry versus exact monetary representation.

Continued research: [extended audit with eight additional findings](/Users/alvarogomez/code/python/agentic-hub/meta/reviews/2026-11-11-payo-core-architecture-follow-up.md).

The package boundaries are sound. The main correctness concern is mutable state escaping the kernel run log. The most useful simplifications are within factory execution: reuse existing artifact helpers, make review failures explicit, and separate checks and repair from the validation loop. Keep the current modular application; no new service, registry, DI container, or dependency is needed.

## Scope and standard

Deep scope: `payo/packages/kernel`, `payo/packages/contracts`, and `payo/modules/factory`. Inspected their incoming server composition/application edges and outgoing ports. Inventoried all Payo source files and package imports; adapter and frontend bodies were sampled, not comprehensively audited.

Payo is a **domain service**: approval requires answered questions, execution requires an approved immutable plan, phase progress requires accepted evidence and receipts, recovery preserves commit intent, and runs cannot end with running steps or open gates. The architecture standard's L/T/D/S rules apply to these domain and application responsibilities. Config and adapter packages are supporting integration libraries, not additional business contexts.

Domain policy exists in factory `domain/` and the kernel's pure run-state reducer. The server has a discoverable composition root: `main.ts` → `composition.ts`, with concrete adapters constructed in `adapters.ts`. CLI/web are separate clients. There is one workflow context today, so the top-level `packages/`, `modules/`, `adapters/`, and `apps/` layout is not evidence of cross-context shotgun surgery.

Declared rules in [engine-design.md](/Users/alvarogomez/code/python/agentic-hub/docs/payo/engine-design.md:50):

> `kernel` imports only `contracts`. It never imports a module or an adapter.
>
> Modules import `kernel` and `contracts`, never another module or an adapter.
>
> Adapters implement kernel ports. Only `apps/server` wires them in.
>
> Every layer, including `apps/server`, is barred from relative imports into another package; packages refer to each other by their `@payo` name.

Biome restricted imports and boundary tests enforce those package rules in CI. No formal ADR accepting a deviation from the audit standard was found in scope. The proposed long-term workbench architecture was treated as context, not as a mandate to implement future modules.

## Ranked findings

### A1 — P1: RunLog exposes the state that enforces its own invariants

**Responsibilities · T1 · high confidence · small effort.** [run-log.ts:19](/Users/alvarogomez/code/python/agentic-hub/payo/packages/kernel/src/run-log.ts:19): `current: () => current,`. The constructor also retains the supplied state at line 16, and `write()` returns the owned state at line 26. [RunState](/Users/alvarogomez/code/python/agentic-hub/payo/packages/kernel/src/state.ts:12) exposes mutable steps, attempts, gates, records, and config.

These are aliases to the state against which `commit()` validates the next event. A caller can mutate it without recording an event. An in-memory reproduction started a step, called `log.current().steps.clear()`, and successfully appended `run.ended`. Replaying the stored events then rejected the run because its step was still running. This breaks the event-log source-of-truth contract.

**Counterevidence:** inspected production callers only read these values. Factory and execution public handles already return detached snapshots. No current production misuse was observed, so this is not P0; those wrappers do not protect the exported kernel API or its injected collaborators.

**Smallest correction:** take ownership of a clone at construction and return detached snapshots from both `current()` and `write()`. Add readonly types as guidance. Readonly types alone, or freezing a `Map`, do not close runtime aliases. Add one regression that mutates all three exposed paths and verifies persisted history still replays.

**Verification:** full run-log, run/commit, reducer, factory handle wrappers, and production read callers; executable in-memory reproduction confirmed.

### A2 — P1: Agent-step orchestration owns concrete filesystem capture

**Boundaries · D1 · high confidence · medium effort.** [agent-step.ts:1](/Users/alvarogomez/code/python/agentic-hub/payo/packages/kernel/src/agent-step.ts:1): `import { mkdtemp, readFile, rm } from "node:fs/promises";`. The step lifecycle creates a temporary raw-log directory, supplies its path to the runner, reads it into the artifact store, and removes it. `AgentDeps` exposes store/log/limiter but no raw-capture capability.

The dependency graph obeys package rules while the application still depends directly on the machine's filesystem. Even an injected in-memory store and fake runner perform real temporary-directory I/O. Capture failures and cleanup lifecycle cannot be simulated through the supplied collaborators.

**Counterevidence:** raw logs are legitimately engine-owned evidence, most capture is best effort, and the runner itself is injected. The issue is concrete I/O ownership, not the existence of capture or the length of `agent-step.ts`. The clock inside `createMemoryRunStore` is adapter behavior and is not this defect.

**Smallest correction:** inject a narrow raw-log capture/lifecycle capability, implement its filesystem behavior at the infrastructure/composition boundary, and supply a memory fake in step tests. Preserve terminal-event ordering, writer cleanup, and best-effort capture semantics; keep attempt policy in the kernel.

**Verification:** full step implementation, runner and agent-spec contracts, composition dependency construction, and fake/raw-log test callers.

### A3 — P1 under the target standard: monetary totals use binary floating point

**Responsibilities · T3 · high confidence · medium effort for representation; small for an explicit design decision.** [primitives.ts:40](/Users/alvarogomez/code/python/agentic-hub/payo/packages/contracts/src/primitives.ts:40): `amount: z.number().finite().nonnegative(),`. [cost.ts:54](/Users/alvarogomez/code/python/agentic-hub/payo/packages/kernel/src/cost.ts:54): `const total = (previous?.amount ?? 0) + amount.amount;`. The cost test explicitly accepts tolerance when adding 0.1 and 0.2.

Totals have currency and basis but no exact monetary representation or precision contract. The supplied standard explicitly rates float money P1; this finding is a standard deviation, not evidence of a billing incident.

**Counterevidence:** [engine-design.md](/Users/alvarogomez/code/python/agentic-hub/docs/payo/engine-design.md:133) clearly calls these API-equivalent estimates rather than billing, and later disclaims invoice accuracy. Unknown/partial coverage and separate currency/basis buckets are handled deliberately. No ADR names and accepts the T3 deviation.

**Smallest correction:** decide explicitly whether these amounts remain approximate telemetry. If so, record a T3 deviation with precision and rounding bounds. Otherwise use a precise representation that supports fractional-cent token costs, normalize it at the runner boundary, and retain legacy-read compatibility. Simply rounding everything to cents would lose valid usage detail.

**Verification:** full cost contract and kernel projection, floating-point test, and documented cost semantics.

### C1 — P2: Review recovery behavior depends on message wording

**Code quality · typing/DRY · high confidence · small effort.** [validation.ts:211](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution/validation.ts:211): `const mutated = review.reason?.includes("mutated") === true;`. Another substring, `"budget exhausted"`, selects the persisted gate status.

The mutation substring decides whether check, diff, and review references are cleared. Existing failures in [execution-review.ts:86](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution-review.ts:86) and line 133 say the workspace “changed”, so they retain evidence references despite reporting stale or changed evidence. Editing explanatory prose can silently change recovery behavior.

**Counterevidence:** execution escalates and remains fail-closed; this is not proof of accepting a changed tree. The mutation integration test covers today's wording, not an explicit result contract.

**Smallest correction:** add a typed review-failure category or explicit evidence-invalidation field to `ImplementationReviewResult`. Use it for evidence and gate status; keep `reason` for display. Avoid adding a second independent failure state that can contradict the first.

**Verification:** full review and validation implementations, gate/checkpoint merge behavior, direct caller, and relevant mutation integration test.

### C2 — P2: Review duplicates existing execution artifact operations

**Code quality · DRY · high confidence · small effort.** [execution-review.ts:558](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution-review.ts:558): `async function receiptResultCommit(`. The same file has local artifact-recording and receipt-reading implementations alongside [execution/artifacts.ts](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution/artifacts.ts:12).

Checks and implementation derive the phase baseline through `phaseStartCommit`; review derives it independently. The former parses the complete `PhaseReceipt`, while the latter initially accepts any string `resultCommit`. JSON/text persistence and `artifact.recorded` emission are also repeated for the same execution-owned operations. Changes to receipt or recording rules have multiple update points.

**Counterevidence:** review subsequently parses all receipts, so this does not currently establish acceptance of corrupt receipts. The distinct phase/final input payloads have different purposes and should remain explicit.

**Smallest correction:** reuse `phaseStartCommit`, `readPhaseReceipts`, `storeJsonArtifact`, and `storeTextArtifact`; delete the redundant helpers. Preserve full validation and event ordering. This reduces code without creating an abstraction.

**Verification:** full review and existing artifact-helper files, plus implementation/check callers.

### A4 — P2: Some command eligibility policy remains in orchestration

**Responsibilities · L2 · high confidence · small effort.** [planning/updates.ts:178](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/planning/updates.ts:178) decides that answers are allowed only in `Approval` or `Escalated`, then validates question membership. [execution/lifecycle.ts:63](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution/lifecycle.ts:63), `export function selectedPr(plan: PlanOutput, prId: string)`, owns selected-PR eligibility and unresolved-phase rejection.

Those are pure domain decisions, but they sit beside artifact loading, writing, and lifecycle orchestration. The domain extraction is partial: approval eligibility and review convergence live in `domain/`, while answer and selected-PR eligibility remain elsewhere. Changing allowed answer stages or execution selection rules requires knowing which application file owns each exception.

**Counterevidence:** all paths remain within factory, and current commands do validate the rules. Dispatching a stage or handling an I/O failure is ordinary orchestration and is not itself an L2 violation.

**Smallest correction:** move these existing pure guards/selection functions into the appropriate domain files; leave artifact reads, checkpoints, and error-to-transport mapping in application code. Do not introduce aggregate classes or a generic state-machine framework to achieve this.

**Verification:** full planning updates, execution lifecycle, and planning/execution domain files, with approval and orchestration callers.

### C3 — P2: Validation combines the loop, check execution, and repair writing

**Code quality · SOLID/SRP · high confidence · medium effort, mostly moves.** [validation.ts:234](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution/validation.ts:234): `async function runCheckCycle(`; [line 398](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution/validation.ts:398): `async function repairScope(`.

The 584-line file owns the validation budget/review loop, configured-check execution and evidence capture, and repair-writer context/accounting/history protection. A check result contract change and a repair prompt change both require editing the loop's implementation file. These are independent operations with existing function seams.

**Counterevidence:** the loop should orchestrate both operations, and their workspace guards are essential. This is not a request for strategies or interfaces.

**Smallest correction:** move the existing operations to `execution/checks.ts` and `execution/repair.ts`, preserving signatures and behavior. Keep `validation.ts` focused on the loop. Reuse the current behavioral tests rather than adding tests that merely assert file placement.

**Verification:** full validation file and its sole production caller, checkpoint/workspace/artifact helpers, and representative integration cases.

### A5 — P2: Factory application files and tests have inconsistent homes

**Structure · S1/S4 · high confidence · medium effort, defer until related edits.** [index.ts](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/index.ts:1) exposes orchestration from both root files and flow subdirectories. Execution application work lives in `execution/`, `execution-review.ts`, `execution-roles.ts`, `execution-read-model.ts`, `prepare-execution.ts`, and `execution-artifacts.ts`. Planning has the same split between `planning/` and root review/read-model/role files.

`domain/` and `infrastructure/` are visible, but the application layer has no single predictable home. Several tests still mirror old paths: `execution-state.test.ts` tests `domain/execution.ts`, while `phase-outline.test.ts` tests `domain/phase-outline.ts`. A review-flow change requires searching root and nested implementations and historically named tests.

**Counterevidence:** root `execution.ts` and `commands.ts` are small public facades, not oversized implementations. The package root remains a useful stable API. No move across packages or new bounded context is warranted.

**Smallest correction:** finish the existing separation into `domain/`, `application/planning/`, `application/execution/`, and `infrastructure/`, preserving `index.ts`. Move flow-owned role, read-model, and artifact files with their flow. Mirror moved unit-test owners; keep broad workflow scenarios clearly identified as integration tests. Combine this with actual feature work rather than a repository-wide rename campaign.

**Verification:** complete factory source inventory and import graph, package exports, and moved implementation/test import pairs.

### C4 — P2: Architecture reviewer bundles omit the standard and structure lens

**Code quality · role-resource contract/DRY · high confidence · small effort.** [roles.ts:19](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/roles.ts:19) lists only `boundaries.md` and `responsibilities.md`. [execution-roles.ts:388](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution-roles.ts:388) repeats that subset. The server constructs pinned resource snapshots from those lists.

The repository's architecture skill requires `references/standard.md` and `references/structure.md`. Neither is loaded into the normal architecture review bundle, and the execution lens filter would discard them if added only to the loader. With context files and skills disabled for Pi, their availability in the target repository is not a reliable replacement for the recorded bundle. Folder-structure and standard-based reviews therefore lack required inputs.

**Counterevidence:** skill content and recorded resources are intentionally immutable; that mechanism is sound. Current tests derive their expectations from the same configured lists, so they cannot detect omitted required files. This is a role-resource correctness issue, not a package-boundary violation.

**Smallest correction:** define the complete architecture resource set once and reuse it for loading and lens selection. Add explicit assertions for standard and structure content in the rendered architecture spec. Existing persisted snapshots must remain truthful; apply the expanded bundle to new snapshots or explicit upgrades.

**Verification:** full role loading, snapshotting and rendering chain, repository architecture-skill requirements, and resource tests.

## File size and structure decisions

Counts include blank lines and comments and describe the audited working tree. Size is a navigation signal, not a SOLID verdict.

| File | Lines | Decision |
|---|---:|---|
| `factory/src/execution-review.ts` | 673 | First delete duplicated artifact operations (C2); keep the review protocol explicit. |
| `factory/src/execution/commit.ts` | 597 | Keep together for now: intent, reconciliation, and accepted-scope completion form one durable commit protocol. |
| `factory/src/execution/validation.ts` | 584 | Split existing check and repair operations from orchestration (C3). |
| `kernel/src/agent-step.ts` | 427 | Extract concrete raw-log I/O (A2); remaining attempt lifecycle is cohesive. |
| `factory/src/execution-roles.ts` | 408 | Explicit role-specific prompts are useful; avoid a generic prompt factory. Fix resource selection (C4). |
| `factory/src/execution.test.ts` | 2,281 | Large multi-scenario suite: when editing it, separate lifecycle, validation/repair, and recovery scenarios; retain shared fixtures under its test owner. |
| `git/src/execution.ts` | 897 | Largest backend adapter; internals only sampled, so no confirmed SRP verdict. |
| `runner-pi/src/index.ts` | 694 | Protocol mapping/process seams inventoried; detailed SRP assessment remains unverified. |
| `config/src/index.ts` | 516 | Pure resolution and atomic file operations are visible seams; not deeply audited. |
| `web/.../SettingsPage.tsx` / `PlanReview.tsx` | 844 / 680 | Large UI candidates, outside the deep core audit. Size alone does not establish excessive responsibility. |

Preserve the package topology. The useful layout change is inside factory: make application ownership as visible as domain and infrastructure ownership. Keep pure domain helpers direct, existing side-effect ports, and the root API. Do not add classes just to label layers.

## Explicitly fine

- **Package direction:** literal internal imports form an acyclic graph. Kernel imports contracts only; factory imports kernel/contracts; adapters import kernel/contracts. No package-private import bypass was found in the inventoried production graph.
- **Factory domain boundaries:** existing tests enforce inward imports, type-only use of kernel state, absence of selected I/O APIs, and an acyclic factory graph. No forbidden import was found in the inspected domain files.
- **Composition:** server construction and shutdown are discoverable in `composition.ts`; application functions receive store/runner/workspace/check collaborators. Optional real-client construction at the composition root is legitimate.
- **Public factory ownership:** both public handles clone checkpoint/run snapshots and hide mutation behind factory commands. A1 concerns the lower kernel contract that remains exposed.
- **Pure rules:** review convergence, repair accounting, manifest validation, and execution checkpoint transitions already have pure domain seams. Preserve them.
- **Ports/ISP:** planning has its narrower `Workspace`; execution has `ExecutionWorkspace`. Their methods have real consumers. No further interface split was justified by the inspected callers.
- **Error handling:** review/check failures generally gate execution, preserve work, and remain truthful. Best-effort diagnostic capture is deliberate. C1 does not establish false successful execution.
- **Simplicity:** no demonstrated need for a DI container, generic repository, workflow DSL, registry, generic role factory, or additional service. No independent OCP/LSP violation was confirmed in the deep scope.

## Evidence map and history

Production/test source counts at inventory time:

| Area | Production | Tests |
|---|---:|---:|
| Factory | 38 | 12 |
| Kernel | 15 | 9 |
| Contracts | 11 | 7 |
| Config | 1 | 1 |
| Server | 15 | 15 |
| CLI | 4 | 4 |
| Web | 35 | 18 |
| Six adapters combined | 8 | 7 |

The inventory excludes dependencies and build output; kernel `testing.ts` is counted as a non-`.test` source file.

Normalized core imports, counted by literal source import/export occurrences:

| Edge | Count |
|---|---:|
| factory → contracts | 40 |
| factory → kernel | 25 |
| kernel → contracts | 10 |
| server → factory | 9 |
| server → kernel | 5 |
| server → contracts | 13 |
| adapters → kernel | 7 |
| adapters → contracts | 6 |
| web → contracts | 25 |
| CLI → contracts / config | 4 / 1 |
| config → contracts | 1 |

Other inventoried server edges point to concrete adapters and config. No package cycle or relative production-file cycle was found by the literal-import scan; computed/nonliteral imports are outside that scan's guarantee.

The 12-month history contains only **seven Payo commits**. Factory, server, and contracts co-change in all seven; kernel co-changes with factory in six, and web with factory in five. Sampled `2c8c0ee` adds the first full engine/CLI flow; `c601174` combines several feature and setup changes across packages. These broad commits and the current uncommitted work are too coarse to establish a god package from co-change frequency. The findings above rely on source contracts and concrete change scenarios, not a coupling inference from those percentages.

## Enforcement gaps

E1 is partly satisfied: package import restrictions, factory domain boundaries/cycles, and web feature direction are checked in CI through `pnpm check`. Extend those existing checks instead of adding another dependency solely for this audit.

| Gap | Concrete contract to add |
|---|---|
| Kernel policy can import concrete I/O despite passing package checks (D1). | Extend restricted imports to ban filesystem/process/network clients in kernel application/policy files after capture is moved; explicitly allow adapter implementations. |
| State ownership can be bypassed without any forbidden import (T1). | Kernel behavioral regression covering mutations of constructor input, `current()`, and `write()` results; replay the recorded log afterward. |
| Layer placement within factory is only partially checked (S1/S4). | Assert allowed layer directories and prevent domain → application/infrastructure imports after the layout is settled; preserve package-root export tests. Avoid arbitrary maximum-line rules. |
| Factory acyclicity has no equivalent comprehensive kernel/application check (L5). | Reuse the existing literal-import cycle test for the remaining core source graph. The scan found no current cycle; this is prevention. |
| Required architecture resources can disappear while list-derived tests pass. | Assert `standard.md` and `structure.md` independently at loader and rendered-spec boundaries. |
| Approximate money has no declared precision/deviation contract (T3). | Record the deliberate telemetry deviation or enforce the chosen exact representation and normalization with focused cost tests. |

## Coverage and verification limits

“Checked” means the named architectural surface or sampled code-quality dimension was inspected, not exhaustive behavioral certification.

| Area | Boundaries | Responsibilities | Structure | Code quality |
|---|---|---|---|---|
| Kernel | Checked imports, ports, raw capture | Checked run state/log ownership and generic lifecycle | Checked inventory/public surface | SOLID/DI checked; cost types inspected; remaining typing/errors sampled |
| Contracts | Checked dependencies/public schemas | Checked event, execution, and cost contracts | Checked inventory | SOLID and boundary typing checked; exhaustive schema semantics unverified |
| Factory domain | Checked all domain files | Checked policy/transition ownership | Checked layout and test homes | Pure-rule callers and representative tests inspected |
| Factory planning | Checked direct domain/kernel edges | Checked approval, updates, recovery | Checked all source homes | Relevant files read; full DRY/typing/error audit unverified |
| Factory execution | Checked direct domain/kernel edges | Checked validation/review/commit and handles | Checked all source homes | Full review, roles, validation, commit, and artifact helpers; remaining helpers/callers sampled |
| Server | Checked core-facing imports/composition | Checked recovery/dispatch edge | Checked inventory/root | Application/composition/role-loading read; remaining handlers sampled |
| Config and six adapters | Checked package import edges | Deep ownership unverified | Inventoried | Internals sampled; security/process correctness unverified |
| CLI/web | Checked package edges; web checker run | Deep behavior unverified | Inventoried | Body-level SOLID audit excluded |

Verification performed:

- Existing boundary suites: **3 files, 67 tests passed** using the installed Vitest binary.
- Biome lint: **228 files, no errors; four CSS `noImportantStyles` warnings** in the existing web stylesheet.
- In-memory run-log alias reproduction: confirmed that the live log accepts a terminal event whose persisted history then fails replay.
- Static source inventory, literal-import graph/cycles, 12-month co-change table, and two representative historical commits inspected.

The initial `pnpm exec` invocation failed while fetching its pinned package-manager version. The installed local binaries ran successfully without fetching dependencies. The complete application suite, TypeScript check, live Pi/Git/Jira runs, performance, security, and test-pyramid quality were not run or audited. No unresolved candidate is being presented as a confirmed defect; large unverified adapter/UI files are explicitly left unclassified above.

Recommended implementation order: close A1; type C1; consolidate C2 and fix C4; move the C3 operations; complete A4/A5 only alongside those edits. Resolve the intentional-money decision A3 before treating cost totals as exact. When moving execution code, preserve checkpoint/event ordering and every workspace/history guard.
