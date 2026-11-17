# Payo architecture audit — 13 November 2026

Audited committed source at `288cc920cd54ad10c81b0b87864c84a3e5d34adc`; the working tree was clean. Scope: `payo/`, its incoming documentation/CI contracts, and all internal package edges. No implementation changes.

Five confirmed P2 findings; no confirmed P0 or P1. Package direction, effect injection in the engine, and state encapsulation are substantially sound. The remaining work is policy placement, one untranslated storage error, and structural/domain-type compliance. Start with PA13-01 and PA13-02; neither requires a redesign.

## Governing rules and classification

The requested skill's `references/standard.md` is the target: L1–L5, T1–T6, D1–D5, S1–S6, E1. The installed skill no longer contains the three separately named lens files; its combined `references/checks.md` supplies boundaries, responsibilities, structure and enforcement checks. `references/review.md` supplies evidence/completion guidance.

Repository rules, quoted from `docs/payo/engine-design.md`:

- Line 20: “CLI and web are thin clients over HTTP and SSE. The engine is a plain library, so tests drive it without a server.”
- Line 50: “`kernel` imports only `contracts`. It never imports a module or an adapter.”
- Line 51: “Modules import `kernel` and `contracts`, never another module or an adapter.”
- Line 52: “Adapters implement kernel ports. Only `apps/server` wires them in.”
- Line 53: “`contracts` imports no other `@payo` package.”
- Line 54: “Adapters import only `kernel` and `contracts`, never another adapter or module.”
- Line 55: “`apps/cli` is a thin client and imports `contracts`, plus `config` only for local bootstrap settings; it never imports the server, modules or adapters.”
- Line 56: “Every layer, including `apps/server`, is barred from relative imports into another package; packages refer to each other by their `@payo` name.”
- Lines 66–68: “Inside `packages/kernel/src`, `domain/` holds deterministic lifecycle, usage, cost and artifact rules; `application/` holds orchestration and its owned ports; `adapters/` holds the memory store and real scheduler.”
- Lines 72–76 assign factory pure policy to `domain/`, lifecycle orchestration to planning/execution, plan-file I/O to infrastructure, transport to `http.ts`, coordination to `run-application.ts`, and wiring to `composition.ts`.

No ADR naming a standard rule, deviation and reason was found. The documented current layout is evidence of intent, not an accepted exception to S1. The proposed future module registry/model gateway is not implemented scope.

**Applicability:** the kernel and factory are domain services: run/step/attempt terminal-state restrictions; approval with answered questions; bounded review/repair; monotonic execution checkpoints and receipts; publication only from reviewed work and reconciled durable intent. Full standard applies. A domain layer exists in both engine packages. Planning, execution and publication are lifecycle subdivisions of the single factory context, not three independently established bounded contexts. Clients and infrastructure expose/integrate that domain; tactical-DDD ownership belongs to the engine. Config is a library/bootstrap capability, judged under D1–D3 and S3 for its core; no separate config aggregate is presumed.

**Composition:** `apps/server/src/main.ts` bootstraps HTTP/system capabilities; `composition.ts` and `adapters.ts` assemble the engine and own shutdown. CLI bootstrap is `apps/cli/src/index.ts`; web assembly is `apps/web/src/main.tsx` and `app/App.tsx`. Env/config access is at CLI/server bootstrap, the config loader, and concrete system/tool adapters. No ambient env/clock/network/filesystem access was found in the checked kernel/factory core.

## Confirmed findings

### PA13-01 — P2: the plan-read port exposes a filesystem error contract

- **Lens / confidence:** boundaries / high. **Violated contract:** L3. **Verification tier:** full edge: factory dependency contract, resume caller, concrete plan implementation and composition binding inspected.
- **Location / excerpt:** `payo/modules/factory/src/planning/lifecycle.ts:297`: `if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;`
- **Evidence:** `FactoryDeps.readPlan` in `types.ts:42` promises `Promise<string>` without a domain-level absence outcome. `infrastructure/plans.ts:49` implements it with `lstat`/`readFile`, and `apps/server/src/composition.ts:127` binds that implementation directly. Resume interprets the adapter's `ENOENT` as permission to restore the saved plan.
- **Consequence / finding:** replacing local files with another plan store requires reproducing a Node filesystem errno or editing the use case. A normal missing-plan outcome from a different adapter will escalate instead of taking the existing fallback. Storage representation has crossed the port even though the filesystem import itself remains outside application code.
- **Counterevidence considered:** the dependency is injected, and other read failures are correctly propagated. This is not a request to swallow permission, corruption or unsafe-path errors.
- **Smallest correction:** translate only absent-plan errors at the plan adapter into a consumer-owned `PlanNotFound` error, or an explicit optional-read outcome; consume that in resume. Retain all other failures. Update injected fake readers and add one absence/failure boundary check.
- **Effort:** small.

### PA13-02 — P2: some lifecycle decisions remain owned by application code

- **Lens / confidence:** responsibilities / high. **Violated contract:** L2. **Verification tier:** full files for kernel `application/run.ts` and `domain/state.ts`, factory publication `preview.ts` and `domain/publication.ts`; targeted corroboration at planning answer/approval seams.
- **Location / excerpt:** `payo/packages/kernel/src/application/run.ts:54`: `if (attempt.status !== "running") continue;`, followed at line 58 by `outcome: "interrupted",` and a recovery gate with `allowedCommands: ["retry", "abandon"]` at line 68.
- **Evidence:** `recover` chooses interrupted outcomes, whether an idle-but-running step needs a gate, and which recovery commands are allowed. `openRun` both loads/persists and invokes that policy. In factory `publication/preview.ts:76–103`, the use case itself decides whether result/checkpoint hashes and the ordered receipt chain authorize publication. In `planning/updates.ts:178–185`, the application decides which stages accept answers and whether the question belongs to the current plan.
- **Consequence / finding:** these are decisions about permissible domain behavior, not mapping an already chosen decision to I/O. Recovery policy changes land beside storage orchestration; publication evidence rules land beside Git/artifact collection; answer eligibility lands beside plan writes. The domain APIs cannot express those decisions independently of their use cases.
- **Counterevidence considered:** `reduce`, `decideReview`, `assertPlanApprovable`, `applyExecutionCheckpoint`, `repairContinuation`, `assertAcceptanceEvidence`, `publicationEligibility`, `reconcileRemote` and `reconcilePullRequests` already own substantial policy correctly. Branches applying their decisions, schema parsing, and cancellation checks are excluded. Existing guards do reject bad operations; no current production invariant bypass is claimed.
- **Smallest correction:** move the pure `recover` decision into kernel domain; extend the existing factory domain functions with publication-evidence and answer-eligibility decisions. Keep collecting facts, loading artifacts and committing events in application code. Keep public exports stable; no new service hierarchy.
- **Effort:** small to medium, with focused pure-policy tests.

### PA13-03 — P2: factory application code has no single layer home

- **Lens / confidence:** structure / high. **Violated contract:** S1. **Verification tier:** complete source-folder inventory, public exports, and representative files in every factory subdivision.
- **Location / excerpt:** `payo/modules/factory/src/index.ts:41`: `} from "./execution.ts";`; the same public surface exports orchestration from `./execution/naming.ts`, `./prepare-execution.ts` and `./publication.ts`.
- **Evidence:** factory has six pure-domain files, but orchestration/support is distributed among 20 root files and sibling `planning/` (5), `execution/` (12), `publication/` (5), alongside `domain/` and `infrastructure/` (1). Examples: root `prepare-execution.ts` is an application use case; root `artifacts.ts` performs persistence through a port; root `types.ts` contains application dependencies and handles.
- **Consequence / finding:** the single-context exemption permits dropping a context folder, not its layers. The current layout cannot express a simple `application → domain`, `adapters → application` folder rule; effect and placement checks instead need exceptions and exclusions over a mixed source root. This is structural compliance, not a missing-domain-layer or god-module finding.
- **Counterevidence considered:** files have meaningful names, lifecycle subdivisions are useful, and `infrastructure` is a valid name for the adapter layer. The engine design describes this layout, but does not name an S1 exception and reason. Co-change does not establish multiple factory contexts or an S2 violation.
- **Smallest correction:** retain factory as one context; place orchestration under `application/{planning,execution,publication}` and root application support under `application/`; retain `domain/` and `infrastructure/`. Classify remaining pure files by actual responsibility and preserve package-root exports.
- **Effort:** medium, mostly moves/import updates and a layout assertion.

### PA13-04 — P2: execution and generic run commands live in the plan-review UI feature

- **Lens / confidence:** structure / high. **Violated contract:** S1, feature-first ownership. **Verification tier:** full API files and workspace component; targeted execution-naming/publication callers and feature-boundary configuration.
- **Location / excerpt:** `payo/apps/web/src/features/run-workspace/ExecutionNamingForm.tsx:4`: `import { correctExecutionNaming } from "../plan-review/api.ts";`
- **Evidence:** `plan-review/api.ts:161` owns the execution-naming endpoint; `:120` owns generic `resumeRun`. The latter is imported by `run-workspace/PublicationView.tsx:2` and execution views. Meanwhile `run-workspace/api.ts` owns publication preview/publish and run event/cost calls, and `runs/api.ts` owns general run reads/creation.
- **Consequence / finding:** execution naming and publication resume changes touch the planning-review feature even when there is no planning-review behavior involved. The declared feature DAG permits this dependency, so lint passes; its placement still misstates ownership. The legitimate dependency on `PlanReview` as a rendered component is a different edge.
- **Counterevidence considered:** the HTTP wrappers are thin, use shared validation/transport, and produce no cycle. `implementRun` and preview used by the planning screen can reasonably remain there. No claim is made that every feature must be a separate bounded context or that every deep UI import violates T6.
- **Smallest correction:** move execution naming to the existing workspace API and generic resume to the existing runs API; update consumers/tests. Keep actual plan-review commands in plan-review. No shared catch-all service is needed.
- **Effort:** small.

### PA13-05 — P2: identity rules are represented by interchangeable primitive strings

- **Lens / confidence:** responsibilities / high for T3 compliance; no observed wrong-ID production call. **Violated contract:** T3. **Verification tier:** shared primitive/event/API schemas and their kernel/factory consumers inspected.
- **Location / excerpt:** `payo/packages/contracts/src/primitives.ts:142`: `export const Id = z.string().min(1);`; `payo/packages/kernel/src/domain/state.ts:14`: `runId: string;`.
- **Evidence:** the same unbranded `Id` schema backs run, step, attempt and gate IDs in `contracts/src/run.ts`; `StepInput` in kernel application accepts `stepId: string` and `attemptIds: readonly [string, string]`. Public API `RunId` in `contracts/src/api.ts:18` is separately constrained to UUID. Factory plan storage also has its own path-safe run-ID validation in `plans.ts`.
- **Consequence / finding:** the domain contracts do not preserve identity kind or its rules. A step ID can be supplied where a run ID is expected without a type error; whether a run identifier is admissible depends on which API/storage surface receives it. The standard explicitly requires domain IDs to be value objects. This crosses shared contracts and engine APIs, rather than being a local annotation preference.
- **Counterevidence considered:** schema validation exists, Map lookups/reducer guards catch unknown identities, and internal library IDs intentionally permit fixtures/non-UUID names. Qualified monetary amounts already use validated decimal text and exact addition; the previous float-money finding is not repeated.
- **Smallest correction:** introduce distinct validated/branded ID types in the shared kernel contract and carry them across engine ports. Preserve supported historical identifiers; UUID restrictions belong at the HTTP adapter where appropriate. No wrapper classes or persisted-data migration are required.
- **Effort:** medium; shared signatures and test fixtures need coordinated updates.

## Evidence inventory

Non-test-suffixed TS/TSX source counts; dependencies/generated files excluded:

```text
payo/
  packages/kernel/src/{domain,application,adapters}/   5,11,2 (+2 entrypoints)
  packages/contracts/src/                            14
  packages/config/src/                                1
  modules/factory/src/                               49 (breakdown PA13-03)
  apps/server/src/                                   16
  apps/cli/src/                                       4
  apps/web/src/                                      41
    app/2; features/{connection,plan-review,run-workspace,runs,settings}/4,5,18,3,2
    shared/{api,ui}/2,3; main.tsx/1; test support/1
  adapters/{git,gh}/src/                              4,2
  adapters/{checks-process,jira-acli,runner-fake,runner-pi,store-sqlite}/src/ 1 each
```

Internal literal import/export edges, normalized to packages, with statement counts:

| Importer | Targets |
|---|---|
| factory | contracts 52; kernel 31 |
| kernel | contracts 14 |
| contracts | none |
| config | contracts 1 |
| server | contracts 13; factory 10; kernel 6; config 4; git 3; jira-acli, runner-fake, runner-pi 2 each; checks-process, gh, store-sqlite 1 each |
| cli | contracts 5; config 1 |
| web | contracts 31 |
| git | contracts 2; kernel 3 |
| gh | contracts 1; kernel 1 |
| jira-acli | contracts 2; kernel 1 |
| runner-pi, runner-fake, store-sqlite | contracts 1; kernel 1 each |
| checks-process | kernel 1 |

No literal import cycles: the passing whole-Payo graph test resolves relative imports, package exports, and web aliases. Package lint passes. This is syntactic dependency evidence, not general runtime symbol analysis.

Twelve-month history has ten commits touching server/factory, nine contracts, eight kernel/runner-pi, seven CLI/web, six git, four config/Jira/SQLite, two fake runner, one gh/checks-process. Server ↔ factory co-change in 10 commits; server ↔ contracts and factory ↔ contracts in 9; factory ↔ kernel in 8; server ↔ web in 7. Sampled `6294a7b` spans 99 Payo files; latest `288cc92` spans seven Payo files for role-resource updates. These broad commits and legitimate integration changes make co-change a weak coupling signal. No S2 or god-module finding rests on those counts.

Domain vocabulary matches docs/tests: work items, runs, steps, attempts, gates, artifacts, plans/versions, phases, findings, receipts, naming, publication. No confirmed T5 terminology mismatch. Factory planning/execution/publication sharing persisted records is not T6 cross-context storage access: they are one context.

## Explicitly fine

- **Package direction:** all observed internal edges obey the documented whitelist; production does not import kernel testing APIs or another package through a relative path.
- **Domain isolation:** kernel domain has inward dependencies; factory domain imports contracts, pure domain helpers/errors, and type-only kernel state. Architecture tests reject I/O and ambient effects in checked engine core.
- **DI/composition:** stores, scheduling, runners, ID generation, checks, workspaces and publication ports are supplied at server assembly; no missing root or core client construction found.
- **Encapsulation:** factory, execution and publication public handles return detached snapshots; their mutable state is held behind private WeakMap mappings. Kernel RunLog clones state and funnels writes through validated reduction and optimistic append.
- **Storage ownership:** SQL/event/artifact storage is owned by the SQLite adapter; engine callers use `RunStore`. No foreign context tables or ORM models found.
- **Transport:** HTTP parses/maps commands to application services; CLI/web depend on published contracts, not engine implementations. HTTP legitimately owns request/response framework types.
- **External translation:** inspected Jira/Pi/GitHub/check adapters normalize results into work-item, agent-event, repository/PR and check records. Vendor payload types do not appear in their engine port signatures.
- **Shared kernel:** lifecycle mechanisms, scheduling and immutable artifact/cost contracts are reusable engine concerns; high fan-in alone does not make a junk drawer. No verified S3 or T2 cross-aggregate transaction violation.

## Enforcement gaps — E1

CI `.github/workflows/ci.yml` runs `pnpm check`, including Biome import restrictions and all boundary tests. Persistent checks cover package directions/public package names; factory domain isolation; core ambient effects; kernel layout/direction; factory filesystem placement; publication I/O restrictions; literal cycles; computed-loading syntax; explicit server wiring locations; and web feature direction/layout.

Remaining contracts worth adding:

1. **L3:** prohibit `NodeJS.ErrnoException` and errno branching in factory application files, using a Biome custom rule or syntax-scanning boundary test; retain it in infrastructure. Assert the absent-plan translation at the port. Import restrictions alone cannot catch this leak.
2. **S1:** after PA13-03, assert every factory implementation file belongs to domain/application/infrastructure or a named public entrypoint. Restrict domain imports to domain/pure contracts and application imports away from infrastructure. Current filesystem exclusions do not enforce complete layer placement.
3. **S1 feature ownership:** after PA13-04, add focused boundary fixtures that execution naming belongs to workspace and generic run resume belongs to runs. Keep the legitimate workspace → PlanReview component edge allowed. General semantic ownership/L2 decisions still need review; do not claim an import checker proves them.
4. **T3:** use branded shared types and TypeScript compile-time checks to reject mixing run/step/attempt IDs. Keep boundary normalization explicit and preserve historical records.
5. **D2:** existing server construction checks look for `create*` imports at a named set of wiring files. Strengthen the rule to reject runtime concrete-adapter imports outside those files, with explicit pure-helper/type-only exceptions; otherwise aliasing a factory import can evade the current syntactic test.

## Coverage ledger and limits

“Checked” below means complete package graph/layout plus the stated ownership samples; it does not mean every algorithm or branch was audited.

| Module | Boundaries | Responsibilities | Structure |
|---|---|---|---|
| factory domain/planning | Checked: ports, purity, plan-read/resume | Checked: review, approval, answers, checkpoint writes | Checked |
| factory execution | Checked: dependencies, handle/port interfaces | Checked: transition policy, repair/acceptance decisions, checkpoint/commit samples | Checked |
| factory publication | Checked: repository/code-host/store edges | Checked: eligibility, evidence chain, remote/PR reconciliation and durable intent | Checked |
| factory read models/infrastructure | Checked: filesystem placement, published exports | Checked: plan read/write; cost/read-model ownership sampled | Checked |
| kernel | Checked: layers, effects, graph and port signatures | Checked: reducer, recovery, log/commit, cost; agent retry/cancel policy sampled | Checked |
| contracts | Checked: package purity and published schemas | Checked: identity/money/lifecycle schemas; remaining wire schemas sampled | Checked |
| config | Checked: bootstrap/library interface | Checked: loader versus resolution and settings-write responsibilities; aggregate rules N/A | Checked: S3 library scope |
| server | Checked: HTTP/application/root edges | Checked: command delegation, recovery/summary, settings and assembly | Checked |
| cli | Checked: contracts/config-only imports | Checked: bootstrap/client/editor separation; aggregate policy N/A | Checked |
| web | Checked: package and feature DAG | Checked: API ownership, workspace composition; presentation derivations sampled; aggregate policy N/A | Checked |
| git | Checked: workspace/repository port/package edges | Checked: planning/execution/publication responsibility surfaces; Git algorithms excluded | Checked |
| gh | Checked: CodeHost interface and translation | Checked: repository identity/PR mapping | Checked |
| jira-acli | Checked: WorkItemSource/package edges | Checked: normalized work-item translation; ADF algorithm excluded | Checked |
| runner-pi | Checked: AgentRunner/package edges | Checked: process ownership and event translation samples; cleanup algorithm excluded | Checked |
| runner-fake | Checked: AgentRunner/package edges | Checked: scripted playback and cancellation ownership | Checked |
| checks-process | Checked: Checks/package edges | Checked: command/result mapping and process ownership; cleanup algorithm excluded | Checked |
| store-sqlite | Checked: RunStore/package/storage edges | Checked: append/sequence and artifact ownership; storage algorithms sampled | Checked |

Prior audit comparison: the 12 November report records remediation of scheduling DI, float-qualified money, execution repair/acceptance policy and kernel layer layout. Current source and passing guards support those changes. PA13-01 through PA13-05 are additional observations under the same scope/standard, previously unreported; this audit does not establish when each was introduced. PA13-02 concerns remaining policy, not a claim that the recorded repair-policy fix failed.

**Validation:** installed Biome lint checked 276 files with no diagnostics. All four architecture suites passed: 77 tests. The initial `pnpm exec` launcher stalled without output and was interrupted; validation then ran successfully through the installed local binaries. No dependency installation was needed.

**Unresolved:** no unresolved candidate is promoted to a finding. General runtime symbol resolution/alias loading is unverified; next probe would require a TypeScript AST/symbol graph if such patterns are introduced. Architecture-specific source inspection was sampled as above. No security, performance, class-level design or test-strategy finding is asserted; those require their corresponding audits. Full behavioral tests, builds and live Jira/Pi/GitHub integrations were not run.


## Implementation — 13 November 2026

All five findings have been addressed in the working tree:

- **PA13-01:** factory application owns `PlanNotFound`; the filesystem adapter translates absence and preserves other failures. Resume and review projection consume the translated error. The same discovered leak in execution naming now uses the kernel-owned `ExecutionWorkspaceNotFound`, translated by the Git adapter. Missing-path and unsafe-path tests cover both adapters.
- **PA13-02:** kernel recovery decisions now live in `domain/recovery.ts`, retaining the existing public export. Planning domain owns answer eligibility/question validation and the approval stage guard. Publication domain owns result/checkpoint matching, manifest eligibility and receipt-chain validation. Application code loads facts and applies decisions. Focused domain tests cover matching and mismatched facts.
- **PA13-03:** factory orchestration/support and associated tests now live under `application/`, with lifecycle subdivisions retained. Pure plan behavior and command rejection live in domain; application failures live in application; filesystem implementation/tests live in infrastructure. All 54 moved files were accounted for, and package-root exports remain available.
- **PA13-04:** execution naming is owned by the workspace API; generic resume is owned by the runs API. Consumers, mocks and API tests use those owners. A persistent architecture check verifies these ownership contracts.
- **PA13-05:** run/step/attempt/gate identities use distinct Zod brands in parsed records and engine port inputs. Raw boundary inputs remain supported, while known validated identities of another kind are rejected by TypeScript. Event command types preserve that distinction too. `ApiRunId` retains HTTP/browser UUID validation; legacy engine IDs and serialized event bytes remain compatible. DeepReadonly preserves primitive brands instead of expanding string members. Compile-time assertions cover identity separation, event fields and engine port signatures.

Enforcement now covers factory layer layout/direction, the application errno ban, resolved relative package escapes, feature API ownership, and stricter runtime adapter imports outside server wiring. The Biome relative-import pattern was corrected to allow valid deeper intra-package imports; the resolved graph check also verifies actual package containment.

Final validation: **Biome check passes; both TypeScript projects pass; 91 test files / 1,102 tests pass, with one live file/test skipped; production web build passes.** Server/CLI loopback integration tests required execution outside the filesystem/network sandbox. The first unrestricted run exposed one erroneous test expectation for a symlink (the adapter correctly raised an unsafe-path error); that expectation was corrected and the complete suite rerun successfully. Vite reports a bundle-size warning for the main chunk (647 kB minified). No live Jira, Pi provider or GitHub publication was run. No database migration, dependency addition, commit or external publication was performed.
