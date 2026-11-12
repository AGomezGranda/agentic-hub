# Payo architecture audit — 12 November 2026

The package boundaries hold, but the target standard is not fully met inside them. Four confirmed findings: two P1 and two P2. No P0 or demonstrated production invariant bypass was found.

## Scope and standard

Audited the current working tree under `payo/`, including staged, unstaged, and untracked source present during inspection. Existing user changes were preserved. This is a subsystem audit, not a review of only the current diff. No implementation changes were made.

**Classification: domain service.** Planning approval requires answered questions and an implementable PR strategy (`modules/factory/src/domain/planning.ts:64`); execution enforces legal transitions, nonregressing phases, and append-only receipts (`domain/execution.ts:103`); publication requires a terminal reviewed execution and reconciles remote ownership (`domain/publication.ts:14`). The full L/T/D/S standard applies to these mechanisms. Config loading and external-tool translation are supporting integration code; they do not independently need workflow aggregates.

The audit uses the architecture-audit skill's `references/standard.md`, with boundaries, responsibilities, and structure rubrics. No qualifying ADR was found that names a standard rule, its deviation, and the reason. The agreed engine design declares package boundaries but does not explicitly waive the standard's timer injection, monetary representation, or layer-layout rules.

Declared contracts, quoted from `docs/payo/engine-design.md`:

- Line 50: “`kernel` imports only `contracts`. It never imports a module or an adapter.”
- Line 51: “Modules import `kernel` and `contracts`, never another module or an adapter.”
- Line 52: “Adapters implement kernel ports. Only `apps/server` wires them in.”
- Line 53: “`contracts` imports no other `@payo` package.”
- Line 54: “Adapters import only `kernel` and `contracts`, never another adapter or module.”
- Line 55: “`apps/cli` is a thin client and imports `contracts`, plus `config` only for local bootstrap settings; it never imports the server, modules or adapters.”
- Line 56: “Every layer, including `apps/server`, is barred from relative imports into another package; packages refer to each other by their `@payo` name.”
- Lines 66–69: “`domain/` holds pure planning/execution rules”, lifecycle flows belong to `planning/` and `execution/`, mutable plan-file access belongs to `infrastructure/plans.ts`, and server commands/queries, transport, and wiring have separate owners.

A real domain layer exists in the factory. Kernel domain behavior exists as pure functions, but its folder structure does not separate it from application and adapter code. Server wiring is discoverable in `apps/server/src/composition.ts:createComposition`, with adapter construction in `adapters.ts` and process bootstrap in `main.ts`. Config/env entry points are server `main.ts`/`config.ts`, CLI `index.ts`/`client.ts`, and `packages/config/src/index.ts`; settings explicitly receives its environment and config I/O functions.

## Confirmed findings

### PAYO-A1 — P1: application code constructs real deadline timers

- **Lens / confidence:** boundaries / high. **Contract:** D1. **Verification:** first-hand implementation and collaborator-contract inspection, with test corroboration.
- **Location / excerpt:** `payo/packages/kernel/src/agent-step.ts:361`: `const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);`; line 316: `setTimeout(resolve, 1000).unref();`.
- **Evidence:** `runAgentStep` owns application orchestration over injected `RunStore`, `RunLog`, `Limiter`, `AgentRunner`, and optional raw-log capture. `AgentDeps` at lines 29–34 has no deadline/scheduling capability, so this core still selects its real clock and cleanup wait itself. Timeout tests at `agent-step.test.ts:321–347` use a 20 ms deadline and a wall-clock elapsed-time assertion.
- **Finding / consequence:** deadline creation is an outbound effect owned directly by the application. A test cannot independently advance the deadline and cleanup grace period through the same dependency seam as the other effects; lifecycle and timeout scenarios depend on real scheduling. This is a standard-mandated P1, not a claim that the current timeout behavior is broken.
- **Counterevidence considered:** caller cancellation is injected, the runner receives a signal, and `AbortSignal.timeout` is a platform API. Those are good choices, but none injects the application's deadline source. Timers inside process adapters are not part of this finding.
- **Smallest correction:** declare a narrow deadline/scheduling port at the kernel consumer, pass it in `AgentDeps`, and wire the real implementation at server composition. Keep cancellation/result precedence and writable-runner cleanup semantics in the kernel. Update factory dependency assembly and timeout tests to use that seam.
- **Effort:** medium; one port, composition and dependency plumbing, targeted lifecycle tests.

### PAYO-A2 — P1: monetary amounts cross the shared contract as floating-point numbers

- **Lens / confidence:** responsibilities / high. **Contract:** T3, whose prescribed severity for float money is P1. **Verification:** first-hand schema, projection, producer, consumer, and history inspection.
- **Location / excerpt:** `payo/packages/contracts/src/primitives.ts:40`: `amount: z.number().finite().nonnegative(),`; `payo/packages/kernel/src/cost.ts:54`: `const total = (previous?.amount ?? 0) + amount.amount;`.
- **Evidence:** Pi also accumulates monetary totals with numeric addition at `adapters/runner-pi/src/index.ts:652`. Kernel `sumCosts` rolls amounts up through attempts, steps, and runs; factory `cost-read-model.ts` rolls runs up to work totals; web `CostPanel.tsx:178` formats these shared amounts. The contract already distinguishes currency and reported/estimated basis, so this is explicitly money rather than a unitless metric.
- **Finding / consequence:** precision policy has no monetary value owner: producers, projections, and consumers inherit JavaScript binary-number semantics. Grouping the same amounts differently can produce slightly different totals; replacing the representation later reaches adapter normalization, shared schemas, projections, persisted events, and UI conversion. For example, binary numeric addition represents `0.1 + 0.2` as `0.30000000000000004`.
- **Counterevidence considered:** finite/nonnegative validation, currency/basis buckets, incomplete-usage tracking, and display rounding are present. These prevent several real accounting mistakes but do not provide exact arithmetic. This is observability spend, not evidence of an incorrect invoice or enforced budget; no production financial loss is asserted.
- **Smallest correction:** give the shared monetary value an explicit precision and rounding policy, using decimal text or scaled integer units sufficient for fractional inference costs; normalize native provider numbers at the adapter edge and sum through that representation. Handle existing numeric event payloads explicitly rather than rewriting historical logs. Retain currency, basis, and completeness metadata.
- **Effort:** medium; shared-contract migration with adapter, projection, API/UI, fixture, and compatibility updates.

### PAYO-A3 — P2: execution outcome rules remain in application flows

- **Lens / confidence:** responsibilities / high. **Contract:** L2. **Verification:** first-hand application branches and corresponding domain functions inspected.
- **Location / excerpt:** `payo/modules/factory/src/execution/validation.ts:560`: `if (output.planIssues.length > 0 || accounting.unresolved.length > 0) {`.
- **Evidence:** this branch decides whether a repair escalates or returns to checks. `domain/execution.ts:accountRepair` validates ID accounting but does not decide this outcome. Other execution acceptance rules remain in `execution/commit.ts:48–56` and `:118–119`, where missing evidence determines whether a phase or final PR may be accepted. These are grouped instances of the same incomplete policy/application separation.
- **Finding / consequence:** the domain owns transition legality and review decisions, while application modules still own some repair and acceptance eligibility. Changing which repair issues block continuation requires changing orchestration as well as the domain policy; testing those outcomes currently traverses application dependencies. These branches choose domain outcomes, beyond merely mapping an already chosen decision to I/O.
- **Counterevidence considered:** `validationAction`, `decideImplementationReview`, `accountRepair`, and `applyExecutionCheckpoint` already centralize substantial policy correctly. Branching on their returned decisions is normal orchestration and is excluded. Reading artifacts and checking that an adapter returned well-formed data also stays in the application/edge.
- **Smallest correction:** extend the existing execution domain policy with pure repair-continuation and acceptance-evidence decisions. Have validation/commit collect facts, call those decisions, and perform the selected writes. Preserve existing guards and error detail; no new service hierarchy is needed.
- **Effort:** small to medium; move the remaining decisions across the existing layer seam and add focused policy tests.

### PAYO-A4 — P2: the kernel mixes domain, application, and store implementation in one source layer

- **Lens / confidence:** structure / high. **Contract:** S1. **Verification:** complete source-directory inventory plus representative implementation inspection.
- **Location / excerpt:** `payo/packages/kernel/src/index.ts:10–12`: `export * from "./run.ts";`, `export * from "./run-log.ts";`, `export * from "./state.ts";`; `store.ts:57`: `export function createMemoryRunStore(`.
- **Evidence:** all 17 non-test-suffixed kernel TS files live directly in `packages/kernel/src/`. Pure lifecycle policy (`state.ts`, `usage.ts`, `cost.ts`), application orchestration (`run.ts`, `run-log.ts`, `agent-step.ts`), and a concrete in-memory store (`store.ts`) have no directory-level layer distinction. `store.ts` combines the consumer-owned port, pure hashing/validation, and concrete storage implementation.
- **Finding / consequence:** the standard permits dropping the context folder for a single context, but not the layers. A newcomer cannot identify which kernel files may perform effects from their location, and CI cannot apply domain-versus-application import restrictions by folder. A storage-only edit and a lifecycle-policy edit land in the same structural surface.
- **Counterevidence considered:** the package has a clear public root, inward package dependencies, and meaningful file names. The kernel is not reported as a god module: its concepts are reusable run mechanisms, and high co-change in broad early commits does not establish unrelated ownership. This is a layer-layout finding, not a missing-domain-behavior claim.
- **Smallest correction:** keep `@payo/kernel`'s public exports stable while placing pure policy in `domain/`, use cases in `application/`, and the memory implementation in `adapters/` or an explicit testing adapter. Place ports with their consumers and add layer checks. Do not reorganize all of Payo or introduce more bounded contexts for this correction.
- **Effort:** medium, mostly moves/import updates and boundary rules.

## Evidence inventory

Source tree, with non-test-suffixed `.ts`/`.tsx` file counts; dependency directories and generated assets excluded. Counts include bootstrap and testing-support TS files, not just deployable application code.

```text
payo/
  apps/cli/src/                         4
  apps/server/src/                     16
  apps/web/src/
    app/                                2
    features/{connection,plan-review,
      run-workspace,runs,settings}/      4, 5, 18, 3, 2
    shared/{api,ui}/                    2, 3
    test/                               1
    main.tsx                            1
  modules/factory/src/
    domain/                             6
    planning/                           5
    execution/                         12
    publication/                        5
    infrastructure/                     1
    root files                         20
  packages/{kernel,contracts,config}/src/ 17, 14, 1
  adapters/{git,gh}/src/                 4, 2
  adapters/{runner-pi,runner-fake,jira-acli,
    checks-process,store-sqlite}/src/    1 each
```

Internal package import edges, counted as literal import/export statements in non-test-suffixed source:

| Importer | Targets (statement counts) |
|---|---|
| factory | contracts 52; kernel 31 |
| kernel | contracts 12 |
| contracts | no Payo packages |
| config | contracts 1 |
| server | contracts 13; factory 10; kernel 6; config 4; git 3; jira-acli 2; runner-fake 2; runner-pi 2; checks-process, gh, store-sqlite 1 each |
| cli | contracts 5; config 1 |
| web | contracts 31 |
| git | contracts 2; kernel 3 |
| gh | contracts 1; kernel 1 |
| jira-acli | contracts 2; kernel 1 |
| runner-pi, runner-fake, store-sqlite | contracts 1; kernel 1 each |
| checks-process | kernel 1 |

No cycles in that package graph. A separate scan of literal relative imports/reexports found no production file cycles or relative edges escaping `payo`. Web feature direction is additionally checked by its boundary test. This is static literal-import evidence, not proof about computed dynamic loading.

Twelve-month co-change evidence contains only eight commits touching factory/server/contracts. Server ↔ factory, server ↔ contracts, and factory ↔ contracts each co-change in 8 commits; factory ↔ kernel in 7; server ↔ web in 6. Sampled `c601174` includes error-boundary and execution-preparation changes; `99c0ecf` includes publication, cost schemas/projections, and corresponding client/adapter integration. These broad commits explain much of the coupling. Counts are leads, not sufficient evidence for an S2 or god-module finding; no such finding is made.

Vocabulary in docs and source aligns around work items, planning runs, execution runs, publication runs, phases, gates, findings, manifests, receipts, and artifacts. No unsupported generic-name/T5 finding was identified.

## Explicitly fine

- **Package boundaries:** every observed internal package edge follows the declared whitelist; no adapter-to-adapter, adapter-to-factory, kernel-to-adapter, or client-to-engine edge.
- **Factory domain isolation:** the six domain files stay behind pure contracts and type-only kernel state imports. Domain boundary tests pass.
- **Composition and ports:** server composition supplies stores, runners, workspace/check/publication capabilities, ID generation, plan I/O, and raw capture; process construction remains at the edge. A missing composition root is not a finding.
- **State encapsulation:** factory/execution/publication handles expose detached snapshots and keep mutable handles behind implementation mappings; no external handle-state writer was identified in the inspected call paths.
- **Storage ownership:** SQLite owns its events table and artifact persistence; callers use the kernel `RunStore` surface. No cross-module SQL/table access was found.
- **Integration translation:** sampled Jira and GitHub edges translate native payloads into work-item/target/PR records; process checks return port-level results. Vendor subprocess objects do not appear in the inspected kernel port signatures.
- **Layout by context:** there is one factory workflow context, with planning/execution/publication lifecycle subdivisions. The existence of top-level `adapters/` alone does not establish multiple contexts or justify S2.

## Enforcement gaps — E1

CI runs `pnpm check` (`.github/workflows/ci.yml`), including Biome, TypeScript, and Vitest. Current checks enforce package imports, factory domain isolation, factory filesystem placement, publication effect restrictions, factory literal cycles, and the web feature dependency DAG.

1. **D1 across kernel/application:** add an AST-based banned-API check for `AbortSignal.timeout`, timer creation, clock/random/env access, filesystem/network/process APIs in domain/application files. Exempt concrete adapter/root paths. Existing factory checks do not cover kernel deadlines or all application flows.
2. **L1/L2 direction and S1 layout inside kernel:** after PAYO-A4, enforce `kernel/domain → domain or pure contracts`, `kernel/application → domain or owned ports`, and forbid either importing kernel adapters. Add a layout assertion for owned source folders. Keep L2 policy placement under review; an import checker cannot decide every rule's proper owner.
3. **L5 beyond factory:** retain a whole-Payo literal-import cycle check, resolving package exports and web aliases. Current persistent cycle enforcement is factory-specific; the wider scan in this audit was ad hoc.
4. **D2 root-only wiring:** restrict concrete adapter factory imports to server composition/bootstrap files, rather than allowing the whole server package to construct them. Config and system-adapter exceptions should be explicit.
5. **Static-analysis limits:** `test/boundaries.test.ts:1` already documents nonliteral imports and `import.meta.resolve` escapes. Forbid nonliteral internal loading outside explicit bootstrap exceptions, or add an AST rule for those calls. Existing passing checks do not close that gap.

## Coverage and limits

“Checked” means the named architectural surface was inspected, with responsibility checks sampled at the listed ownership seams; it is not a line-by-line correctness review.

| Module | Boundaries | Responsibilities | Structure |
|---|---|---|---|
| factory domain + planning | Checked: imports, approval/domain seam | Checked: approval gates, question/plan policy, checkpoints | Checked |
| factory execution | Checked: imports, injected ports | Checked: transitions, acceptance, repair, resume/naming seams | Checked |
| factory publication | Checked: ports/domain/lifecycle edges | Checked: eligibility, acceptance, checkpoint/resume ownership | Checked |
| factory infrastructure/read models | Checked: plan filesystem placement, store API | Checked: plan ownership, cost lineage/projection | Checked |
| kernel | Checked: graph, ports, state/orchestration seam | Checked: lifecycle, costs, attempt deadlines, store implementation | Checked |
| contracts | Checked: package purity, published schemas | Checked: cost and workflow record constraints; other schemas sampled | Checked |
| config | Checked: allowed package edge, env/I/O location | Checked: config/settings ownership; config precedence algorithm not audited | Checked |
| server | Checked: transport/application/composition edges | Checked: command delegation, recovery/summary, settings and dependency assembly | Checked |
| cli | Checked: package imports/bootstrap surface | Checked: client/bootstrap/editor roles; transport behavior sampled | Checked |
| web | Checked: contracts-only package edge and feature DAG | Checked: presentation/API/action roles, cost display; individual view derivations sampled | Checked: app/features/shared tree |
| git | Checked: ports and package graph | Checked: workspace/publication ownership surfaces; Git algorithms not audited | Checked |
| gh | Checked: CodeHost translation | Checked: repository/PR mapping and adapter construction | Checked |
| jira-acli | Checked: WorkItemSource translation | Checked: ticket parsing and subprocess ownership | Checked |
| runner-pi | Checked: AgentRunner surface and imports | Checked: process/usage mapping ownership; termination internals not audited | Checked |
| runner-fake | Checked: AgentRunner surface/imports | Checked: scripted playback, call recording, cancellation ownership | Checked |
| checks-process | Checked: Checks surface/imports | Checked: command/result translation; process cleanup algorithm not audited | Checked |
| store-sqlite | Checked: RunStore surface/table access | Checked: append sequencing and event ownership; artifact write algorithm not audited | Checked |

Computed imports are outside the graph's resolution. No unresolved candidate defect is promoted to a finding. The algorithm-level exclusions in the ledger are outside architectural ownership review, not evidence that those algorithms are correct.

Validation run: Biome lint completed with **0 errors and 16 warnings**; architecture boundary suites **3 passed / 73 tests passed**. Warnings concern non-null assertions and CSS style rules and are outside this architecture audit. No code-quality, security, performance, live-tool, full behavioral-suite, or test-strategy audit was performed. Runtime correctness of the existing dirty tree remains unverified beyond these checks.

## Remediation — 12 November 2026

- **PAYO-A1:** `Scheduler` is owned by kernel application code and required in agent/factory dependencies. Server composition supplies the real adapter. Deadline creation, cooperative yielding and read-only cleanup grace periods use that port; writable cleanup remains unbounded until descendants stop. Deadline and deaf-runner tests advance the injected scheduler explicitly.
- **PAYO-A2:** qualified `amount` values now leave contracts as decimal text with 12 fractional digits and half-up ingress rounding. Provider normalization and bucket addition share the monetary policy; sums use scaled `bigint` arithmetic. Numeric historical payloads normalize on read without rewriting stored rows. Currency, basis, completeness and legacy scalar-usage handling remain intact. API consumers must accept decimal strings.
- **PAYO-A3:** execution domain policy now owns repair continuation and phase/final acceptance evidence requirements. Application code collects facts and applies the selected writes, retaining guard messages and plan-issue precedence.
- **PAYO-A4:** kernel policy is under `domain/`, orchestration and consumer-owned ports under `application/`, and memory storage/real scheduling under `adapters/`. Public root exports remain stable.
- **E1:** persistent checks enforce kernel layout/direction, AST-based core effect restrictions through Biome GritQL, whole-Payo literal cycles including package exports/web aliases, concrete server factory imports at explicit wiring paths, and a syntactic ban on computed loading. The platform capability formerly read in execution orchestration is supplied by composition. System diagnostics and development fixtures are explicit wiring exceptions. Literal graph checks do not perform general symbol resolution.

Verification: lint and both TypeScript projects pass (16 existing lint warnings). The complete Vitest suite passes with two workers: **90 files / 1,092 tests passed**, one live test skipped. The first default-concurrency run failed once in the unchanged browser-history settings test; the full two-worker rerun passed. No live provider, Jira or GitHub integration was run.
