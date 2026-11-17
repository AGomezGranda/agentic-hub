# Payo architecture audit — 14 November 2026

Audited the current working tree under `payo/`, including its uncommitted refactor, against the requested architecture standard. Base commit: `288cc920cd54ad10c81b0b87864c84a3e5d34adc`. Existing source and earlier reports were not changed.

Three confirmed P2 findings; no confirmed P0 or P1. Start with PA14-01: finish moving workflow policy into the existing domain modules. Package direction, core effect injection, state encapsulation and the new factory layer layout are sound in the checked scope. This is an architecture audit, not certification of every behavior or adapter failure path.

## Scope and governing contracts

The kernel and factory are **domain services**: terminal-state restrictions, approval eligibility, review/repair budgets, ordered phase receipts and reviewed-work publication are invariants. Full L/T/D/S rules apply. Planning, execution and publication are subdivisions of the single factory context; a second independently owned business context was not established. Domain layers exist in both kernel and factory. CLI and web are delivery clients, external adapters implement engine ports, and config is a bootstrap/configuration library; no additional domain aggregates are presumed in them.

The installed skill's `standard.md` governs. Its separately named `boundaries.md`, `responsibilities.md` and `structure.md` are absent; the installed consolidated `checks.md` supplies all three lens rubrics. No ADR accepting an explicitly named standard-rule deviation and rationale was found. Descriptive layout documentation is not an exemption.

Declared rules, quoted from `docs/payo/engine-design.md`:

- Line 20: “CLI and web are thin clients over HTTP and SSE. The engine is a plain library, so tests drive it without a server.”
- Line 50: “`kernel` imports only `contracts`. It never imports a module or an adapter.”
- Line 51: “Modules import `kernel` and `contracts`, never another module or an adapter.”
- Line 52: “Adapters implement kernel ports. Only `apps/server` wires them in.”
- Line 53: “`contracts` imports no other `@payo` package.”
- Line 54: “Adapters import only `kernel` and `contracts`, never another adapter or module.”
- Line 55: “`apps/cli` is a thin client and imports `contracts`, plus `config` only for local bootstrap settings; it never imports the server, modules or adapters.”
- Line 56: “Every layer, including `apps/server`, is barred from relative imports into another package; packages refer to each other by their `@payo` name.”
- Lines 66–68 assign deterministic rules to kernel domain, orchestration/ports to application, memory store/scheduler to adapters.
- Lines 72–78 assign factory pure rules to domain, lifecycle orchestration to application, plan-file access to infrastructure, and application-owned absence errors at the storage boundary.

`apps/web/README.md`, Dependency rules, additionally assigns composition/session state to `app`, prohibits feature → app and shared → feature dependencies, and declares the allowed feature DAG. Features are presentation areas, not independently established bounded contexts; direct component imports alone are not T6 violations.

Composition roots: server `main.ts` with `composition.ts`/`adapters.ts`, CLI `index.ts`, browser `main.tsx`/`app/App.tsx`. Server composition owns task shutdown and store closure. Environment reads occur in server bootstrap/config, CLI bootstrap/client helpers, config loading, Pi/GitHub subprocess adapters, and the workspace launcher. No direct ambient clock, randomness, environment, filesystem or network use was detected in kernel/factory domain or application by the configured checks.

## Confirmed findings

### PA14-01 — P2 / responsibilities: workflow outcome policy still lives in application modules

- **Confidence:** high. **Contract:** L2. **Verification:** full-edge reads of implementation orchestration and execution domain, publication preview and publication domain; targeted corroboration in publication execution and kernel checks.
- **Location:** `payo/modules/factory/src/application/execution/implement.ts:189`.
- **Excerpt:** `const missingCriteria = phase.acceptanceCriteria.filter(`; line 192: `if (output.planIssues.length > 0 || missingCriteria.length > 0) {`; line 208: `if (!feedback) {`.
- **Finding/evidence:** the use case owns the rule that incomplete acceptance reporting or plan issues get one reconciliation attempt, then an escalation gate. That decision is absent from `domain/execution.ts`, although that module already owns repair continuation, review decisions and acceptance-evidence policy. Publication has the same residual placement: `application/publication/preview.ts:62–73` decides whether checkpoint/workspace evidence authorizes publication, and `:146–152` rejects moved target bases; `application/publication/run.ts:49–60` independently implements the base-consistency rule. `publicationContent` at `preview.ts:197–210` is entirely pure content/marker policy. Kernel `application/checks.ts:29` also owns the pure empty-suite/passed-results decision.
- **Consequence:** changing reconciliation eligibility requires editing orchestration with artifact writes and agent calls; changing publication eligibility requires coordinating preview and execution checks. Existing domain APIs cannot exercise all of those policies independently of use-case setup. No present production bypass is claimed.
- **Counterevidence:** application should collect facts and branch on an already selected domain decision; those branches are not findings. `validationAction`, `repairContinuation`, `decideImplementationReview`, `publicationEligibility`, `assertPublicationResult`, `assertPublicationReceipts` and `reconcileRemote` already put substantial policy in the right owner. The remaining conditions above independently choose or reject domain outcomes.
- **Smallest correction:** extend the existing execution/publication domain functions with pure report-disposition and publication-eligibility checks; have use cases supply observed facts and execute the returned decision. Move pure publication content policy and check-success policy to their existing domain homes. Reuse the same target-base assertion for preview and execution. Keep I/O, intent persistence and event commits in application; preserve public exports.
- **Effort:** small to medium, plus focused pure-policy checks.

### PA14-02 — P2 / boundaries: adapter configuration still reads ambient environment outside bootstrap

- **Confidence:** high against the literal standard. **Contract:** D2, specifically “Only config loading at the root reads env; it passes typed config down.” **Verification:** targeted reads of environment consumers, options, and root wiring; server bootstrap and adapter-set construction read in full. Not an engine D1 finding.
- **Location:** `payo/apps/server/src/open-workspace.ts:40`.
- **Excerpt:** `process.env.SHELL ?? "/bin/sh",`.
- **Evidence/finding:** the Linux workspace launcher selects its shell during each request. Root `main.ts` injects the already-created `openWorkspace` function rather than a launcher configured with the selected shell. Likewise `adapters/runner-pi/src/index.ts:99–104` and `adapters/gh/src/exec.ts:31` build child environments from `process.env` when invoked; their root wiring does not pass an environment snapshot. Effects are correctly at the edge, but configuration still has multiple ambient readers.
- **Consequence:** the injected launcher/runner identity does not fully determine its configuration: environment mutation after composition can change shell selection or child credentials/tool behavior. Tests must control globals to exercise those inputs. This is nonblocking composition/configuration compliance, not evidence of exposed credentials or failed commands.
- **Counterevidence:** `config` is intentionally the configuration loader, and root reads are allowed. Inheriting a child environment is normal subprocess behavior and is not itself a security issue. The kernel/factory do not perform these reads, and real side effects remain behind injected ports. Nevertheless D2 explicitly restricts environment reads; no accepted deviation was found.
- **Smallest correction:** capture launcher shell and child environment at bootstrap, then pass them through concrete adapter options. Preserve intended child inheritance and Payo correlation overrides. No new domain port is needed.
- **Effort:** small; update adapter/launcher setup and environment-sensitive tests.

### PA14-03 — P2 / structure: storage application tests remain in the domain folder

- **Confidence:** high. **Contract:** S1, tests mirror the source ownership/layers. **Verification:** full test-file read and inspection of application artifact exports/callers.
- **Location:** `payo/modules/factory/src/domain/planning-review.test.ts:123`.
- **Excerpt:** `const { storeCheckpoint } = await import("../application/artifacts.ts");`.
- **Evidence/finding:** three tests at lines 119, 156 and 197 exercise checkpoint loading, ordered persisted plan versions and artifact-integrity rejection. They instantiate a memory store/event log and call application artifact functions, while the same file also tests the pure domain review decision. Production code now has an application layer, but these tests retain the former mixed ownership.
- **Consequence:** selecting domain tests pulls in storage/application behavior, and changes to artifact persistence require editing the domain test area. The folder no longer reliably identifies the tested layer. This is a test-placement issue, not a production domain → application edge or a request for more test coverage.
- **Counterevidence:** the pure `decideReview` tests belong here. The storage tests are valuable and use in-memory dependencies. Factory production boundary checks intentionally exclude test files; their passing result therefore does not disprove this placement issue.
- **Smallest correction:** move those three storage tests into `application/artifacts.test.ts`; keep pure review tests under domain. Put schema-only compatibility checks with contract tests when next touching them, without duplicating assertions.
- **Effort:** small, moves/import updates only.

## Explicitly fine

- **L1/L5:** literal-import graph checks pass across all production Payo packages; kernel/factory core points inward and the scanned graph is acyclic. No cross-context cycle was found.
- **D1/D3:** core collaborators include scheduler, IDs, store, runners and workspace capabilities supplied by composition; checks reject direct core effects. Concrete adapter construction is at the server edge.
- **T1:** `openRunLog` clones initial state, current snapshots, write input and output. Factory/execution handles expose detached readonly snapshots and keep mutable state in private WeakMaps. Public snapshot mutation does not mutate the owned engine state.
- **T3:** run/step/attempt/gate identities are branded in shared contracts. Qualified money uses decimal text and exact BigInt addition; legacy numeric ingress is converted. No float aggregation finding is established.
- **L3:** plan absence becomes application-owned `PlanNotFound`; execution workspace absence uses kernel-owned `ExecutionWorkspaceNotFound`. The checked callers no longer interpret filesystem `ENOENT`.
- **S1/S3:** factory production support/orchestration now has a single application home; pure policy and plan-file I/O have domain/infrastructure homes. No mixed-purpose `utils`/`common` junk drawer was found in the source inventory.
- **Client ownership:** execution naming is in workspace API; generic resume is in runs API. Package direction prevents clients from importing engine/adapters. Feature DAG tests pass.
- **T2/T4/T6, sampled:** durable writes are per-run event batches through `RunStore`; linked runs are referenced by ID. No direct foreign table/ORM access or multi-aggregate transaction was found in the inspected flows. Event sourcing and pure functional domain operations do not require wrapper aggregate classes.

The prior report was consulted only after inspecting current evidence. Its plan-error, factory-layout, UI-command-placement and primitive-ID findings are no longer present in the inspected working tree. Recovery policy has also moved to kernel domain. PA14-01 covers remaining policy, not those already corrected examples.

## Evidence inventory

Production TS/TSX files under each package's `src`, excluding test-suffixed files, dependencies and generated output:

```text
payo/
  packages/
    kernel/src/{domain,application,adapters}/          22 files incl. entrypoints
    contracts/src/                                    14
    config/src/                                        1
  modules/factory/src/
    {domain,application,infrastructure}/               51 incl. index
    application/{planning,execution,publication}/
  apps/
    server/src/                                       16
    cli/src/                                           4
    web/src/                                          42
      app/
      features/{connection,runs,settings,plan-review,run-workspace}/
      shared/{api,ui}/
      test/
  adapters/
    git/src/                                           4
    gh/src/                                            2
    {checks-process,jira-acli,runner-fake,
     runner-pi,store-sqlite}/src/                 1 each
```

Internal cross-package import statements (type imports and re-exports included; third-party imports excluded):

| Importer | Targets, with statement counts |
|---|---|
| kernel | contracts 20 |
| factory | contracts 65; kernel 31 |
| config | contracts 1 |
| web | contracts 31 |
| cli | contracts 5; config 1 |
| server | contracts 14; factory 10; kernel 6; config 4; git 3; runner-pi 2; runner-fake 2; jira-acli 2; each other adapter 1 |
| git | contracts 2; kernel 4 |
| gh | contracts 1; kernel 2 |
| jira-acli | contracts 2; kernel 1 |
| runner-pi, runner-fake, store-sqlite | contracts 1; kernel 1 each |
| checks-process | kernel 1 |

The boundary suite resolves relative/package/browser-alias literal edges and checks cycles, supplementing this package summary. Computed loading is separately prohibited in scanned production files. Symbol aliases or arbitrary runtime-generated dependencies are not fully resolved by this syntactic analysis.

Twelve-month non-merge history, grouped at `payo/<group>/<package>` depth:

| Pair | Co-changing commits | Commits touching either module, respectively |
|---|---:|---:|
| server / factory | 10 | 10 / 10 |
| server / contracts | 9 | 10 / 9 |
| factory / contracts | 9 | 10 / 9 |
| runner-pi / kernel | 8 | 8 / 8 |
| server / web | 7 | 10 / 7 |
| git / factory | 6 | 6 / 10 |

This is a very small history of broad feature commits. Co-change is a lead, not proof of a god module, multiple contexts or S2. Uncommitted changes are not included in these counts. Vocabulary consistently names runs, steps, attempts, gates, plans, phases, receipts and publications; no concrete T5 naming defect was established.

## Enforcement gaps

CI runs `pnpm check`, including Biome, both TypeScript projects and Vitest. Existing checks cover package restrictions/public paths, production literal graph acyclicity, kernel/factory layer direction and core effects, factory filesystem ownership, web placement/DAG, and two UI endpoint ownership rules. Those checks substantially cover L1/L5, D1 and engine S1; they do not prove semantic rule ownership.

- **D2 / PA14-02:** add a syntax-aware banned-access rule for `process.env` outside a documented bootstrap/config allowlist, including concrete adapter directories. Require child environment/shell options to come from wiring. Existing core-only effect checks do not cover these sites.
- **S1 / PA14-03:** add a test-target placement assertion: domain test files may not import `../application/` or `../infrastructure/`, including literal dynamic imports. This need not forbid test frameworks or shared test fixtures.
- **L4/D4:** HTTP currently receives the broad `Composition` type, which includes `store` and shutdown capabilities, although checked handlers use application methods. Add an import/use restriction or narrow handler service type so future handlers cannot call `store` directly. This is an enforcement gap, not a confirmed current direct-storage violation.
- **L2:** meaningful report/eligibility policy cannot be comprehensively enforced with import lint. Keep pure-policy tests near the domain owner after PA14-01; avoid pretending a banned `if` rule can distinguish policy from orchestration.

## Coverage ledger and unresolved areas

“Checked, sampled” means the full import/tree inventory was checked but semantic ownership was assessed through representative flows, not every branch. It does not label uninspected logic clean.

| In-scope module | Boundaries | Responsibilities | Structure |
|---|---|---|---|
| kernel | Checked: graph, domain/application, log/store seam | Checked, sampled: reducer, recovery, costs, log; checks policy in PA14-01 | Checked: layers/entrypoints |
| factory | Checked: graph, ports, publication/plans/handles | Checked, sampled: approval, implementation, resume, review/receipt/publication policy | Checked: all production paths; test-placement PA14-03 |
| contracts | Checked: imports/exports | Checked, sampled: IDs, money, cost invariants; exhaustive schema semantics unverified | Checked: schema inventory |
| config | Checked: imports/root consumers | Checked, sampled: bootstrap/config role; every precedence/write branch unverified | Checked: one config home |
| server | Checked: graph, HTTP/application/wiring | Checked, sampled: command routing, summary, settings, composition lifecycle | Checked: named transport/application/wiring responsibilities |
| cli | Checked: package graph/client contract | Checked, sampled: bootstrap/client separation; every editor/CLI path unverified | Checked: command/client/editor source inventory |
| web connection | Checked: package/feature graph | Checked, sampled: connection/client separation | Checked: feature/shared layout |
| web runs | Checked: feature graph | Checked, sampled: generic endpoint ownership | Checked: feature layout |
| web plan-review | Checked: feature graph | Checked, sampled: planning endpoint ownership | Checked: feature layout |
| web run-workspace | Checked: feature graph | Checked, sampled: execution/publication endpoint ownership; exhaustive rendering decisions unverified | Checked: feature layout |
| web settings | Checked: feature graph | Checked, sampled: settings API ownership; all form branches unverified | Checked: feature layout |
| git | Checked: graph/port declarations, sampled absence translation | Checked, sampled: workspace/repository adapter role; full Git recovery internals unverified | Checked: adapter package/public surface |
| gh | Checked: graph/port, sampled wire translation | Checked, sampled: command/host role; full response mapping unverified | Checked: adapter public surface |
| store-sqlite | Checked: graph/store port, sampled append/read | Checked, sampled: transaction/event/artifact ownership; all failure paths unverified | Checked: storage adapter home |
| checks-process | Checked: graph/port | Checked: process execution and normalized check-result role | Checked: adapter home |
| runner-pi | Checked: graph/runner contract, sampled spawn config | Checked, sampled: runner role; full RPC/event mapping unverified | Checked: adapter home |
| runner-fake | Checked: graph/runner surface | Internal scripted-event ownership unverified; next probe: inspect full implementation against AgentRunner | Checked: adapter home |
| jira-acli | Checked: graph/WorkItemSource surface | Full external-model translation unverified; next probe: inspect result mapping against WorkItem | Checked: adapter home |

No unresolved candidate is presented as a defect. The next deeper audit should inspect complete Git commit/recovery and Pi/Jira model/error translation against their ports; the graph check alone cannot establish those semantics. No security, performance, code-quality or test-strategy findings are asserted here; those require their respective audits.

## Validation and limitations

- `node node_modules/vitest/vitest.mjs run test/`: **4 files, 79 tests passed**.
- `node node_modules/@biomejs/biome/bin/biome lint .`, from `payo/`: **282 files checked, passed**, no fixes.
- The pnpm launchers attempted a network fetch and failed; validation used the installed local tools directly. An initial root-directory Biome invocation rejected nested configuration; the successful run used the Payo working directory.
- No full functional suite, typecheck, build, live provider, GitHub/Jira/Pi execution or deployment was run. Local Node is v26.8.1; CI declares Node 24.
- Only this report was added. Findings describe a working tree under active revision and should be rechecked after further edits.

## Fixes applied after review

The user subsequently authorized implementation. All three confirmed findings
were addressed on 14 November 2026:

- **PA14-01:** implementation-report reconciliation decisions now live in factory
  execution domain. Publication checkpoint/workspace/base checks and content
  policy live in publication domain; preview and execution share the pinned-base
  check. Kernel check results and success policy live in domain, with existing
  public exports preserved.
- **PA14-02:** server bootstrap supplies explicit environment snapshots to Pi,
  GitHub command execution and workspace launchers. Constructor inputs are copied
  so later mutation cannot change their configuration. Correlation IDs and fixed
  GitHub execution settings retain their overrides.
- **PA14-03:** the three storage tests moved into
  `modules/factory/src/application/artifacts.test.ts`; pure review tests remain
  in domain.

Regression checks now reject application/infrastructure imports from factory
domain tests and ambient environment reads outside bootstrap/configuration
modules. HTTP services also have a narrowed type that excludes direct store and
shutdown capabilities. Domain-policy and environment-snapshot tests cover the
moved decisions and configuration behavior.

Validation after fixes: Biome check passed for 286 files; core and web TypeScript
checks passed; the full Vitest suite passed with **95 test files and 1,128 tests
passing, one live test skipped**. The sandbox disallowed local HTTP binds with
`EPERM`; the successful full-suite run used approved execution outside the
sandbox. Live provider execution and production deployment were not performed.
