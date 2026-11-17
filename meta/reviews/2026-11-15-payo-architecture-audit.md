# Payo architecture and microkernel audit · 15 November 2026

**Keep the static microkernel. Fix live-run ownership first.** An identical publish request can record a false interruption and prevent the worker that actually pushed the commit from recording completion. This was reproduced using production lifecycle code, the memory store and a fake remote. Import-direction tests cannot detect it.

## Scope and standard

Working tree at base 288cc92, including staged and unstaged changes, not just the last commit. Kernel and factory are domain services: they enforce event order, terminal states, gate resolution, phase evidence and eligibility to publish a reviewed commit. Both have domain and application layers. The server is the engine composition root (main.ts → composition.ts / adapters.ts); CLI and web are delivery processes with their own entrypoints. Config and adapters are integration libraries; they need ports and wiring, not their own business aggregates. No ADR explicitly overriding the audit standard was found. The installed skill names three missing rubric files; the available consolidated references/checks.md covers all three lenses.

Governing declarations in docs/payo/engine-design.md:50–56: “`kernel` imports only `contracts`. It never imports a module or an adapter.” “Modules import `kernel` and `contracts`, never another module or an adapter.” “Adapters implement kernel ports. Only `apps/server` wires them in.” “`contracts` imports no other `@payo` package.” “Adapters import only `kernel` and `contracts`, never another adapter or module.” CLI may use config for local bootstrap only; cross-package imports must use the public package name. Lines 66–83 assign deterministic rules to domain, orchestration to application and filesystem access to adapters. Web owns an additional feature DAG (apps/web/README.md:66). Runs, attempts, gates, plans, receipts and publication have consistent names in code and docs.

## Findings, ranked

**PA15-01 · P0 · responsibilities · T1 · high confidence. Live duplicate acceptance executes startup recovery.** In modules/factory/src/application/publication/lifecycle.ts:67, `handle: await openPublication(deps, id, { recover: false }),` reaches line 176, `const state = await openRun(deps.store, id);`. The kernel implementation at packages/kernel/src/application/run.ts:89 always executes `return commit(store, state, recover(state));`. The flag suppresses the factory's recovery gate only. Kernel recovery explicitly says “Startup only” (domain/recovery.ts:6). Execution duplicates take the same path (application/execution/lifecycle.ts:133, :272, :283).

Verification: full publication lifecycle, execution worker, kernel log/recovery contracts and runtime interleaving using the existing publication fixture. Paused the fake push after the durable step-start, submitted the identical preview hash, then released the push. The duplicate returned created=false, but persisted an interrupted-step gate; the original worker rejected with “StaleSeqError expected seq 4 but the log is at 5”. The fake remote had advanced. No restart occurred. The existing duplicate test submits both requests before executing, then repeats after completion; neither exercises this window. SQLite and memory both enforce expected sequence. The execution path was traced, not independently replayed. **Correction:** separate reading/folding from explicit startup recovery. Duplicate validation must not write the log or start recovery; retain recovery on bootstrap. Add one interleaving regression. **Effort:** small across kernel/factory plus test.

**PA15-02 · P1 · responsibilities · T1 · high confidence. A duplicate publish replaces the server's live handle.** apps/server/src/run-application.ts:263 unconditionally does `publicationHandles.set(publicationId, handle);`, but line 265 schedules the original handle only when created. The duplicate opens a fresh log; each log owns its own current state (packages/kernel/src/application/run-log.ts:16), and each publication handle its own checkpoint/busy flag (application/publication/handle.ts). Even after PA15-01 is fixed, a retry before the first step can replace the registry entry without writing an event. The original worker then finishes while summary/isActive read the other handle, which still describes an active run. Counterexample checked: execution registration explicitly retains the existing handle. **Correction:** retain the registered handle for that ID, after validating duplicate content; if none exists, install the appropriate handle. Test that after a mid-flight repeat the server reports the original worker's terminal result. **Verification:** both handle and log contracts plus caller and summary path; stale-summary outcome established by source inspection, not an HTTP replay. **Effort:** small.

**PA15-03 · P2 · boundaries · L3 · high confidence. A publication-specific GitHub identity is part of the kernel API.** packages/kernel/src/application/code-host.ts:8 returns `Promise<GitHubTarget>`; packages/contracts/src/publication-records.ts:13 requires `host: z.literal("github.com")`. The GitHub adapter maps its API responses, but the same exact wire identity is consumed by factory publication policy. A second host cannot satisfy the supposed generic capability by changing only its adapter. This does not imply present GitHub support is incorrect, nor require implementing another host. **Correction:** keep the GitHub-only restriction in the publication feature/adapter; either expose this explicitly as a publication-owned capability outside the universal runtime, or, when a second host is required, separate a neutral repository identity from the persisted GitHub DTO. Preserve existing record decoding. If moving the port, update the documented adapter import rule deliberately; do not introduce a forbidden adapter → factory implementation import. **Verification:** both port and schema, consumer and adapter mapping. **Effort:** medium; defer behind live-run fixes.

**PA15-04 · P2 · boundaries · L3 · high confidence. Backend exceptions cross the port unchanged.** adapters/jira-acli/src/index.ts:129 uses `reject(error);` for nonnumeric child-process failures; its WorkItemSource.resolve caller receives a Node process error when the binary cannot launch. adapters/store-sqlite/src/index.ts:196 uses `if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;`. Permission failures therefore surface as filesystem errors through RunStore.readArtifact. Counterevidence: numeric CLI exits and missing artifacts are already translated, and stale sequence is a kernel error. **Correction:** translate backend failures at these boundaries into operation-specific port errors, retaining the original cause and existing conflict semantics. **Verification:** full adapter/port reads; failure injection not run. **Effort:** small per operation.

**PA15-05 · P2 · responsibilities · D2 · high confidence. Acceptance queues outlive the composition that uses them.** Both application/publication/lifecycle.ts:27 and application/execution/lifecycle.ts:67 declare `let acceptanceTail: Promise<void> = Promise.resolve();` at module scope. Independent stores/engines in the same process wait on each other's requests; publication acceptance holds the queue across remote preview checks. Publication and execution have separate queues, and production normally has one engine, so this is principally an isolation/lifecycle defect. **Correction:** own each existing serializer per engine/store and pass the narrow serialization capability into acceptance. Preserve duplicate serialization for that store. **Verification:** queue declarations, callers and awaited acceptance work. **Effort:** small to medium.

**PA15-06 · P2 · responsibilities · L2 · high confidence. Publication resume policy remains in orchestration.** application/publication/lifecycle.ts:206–224 decides that status must be active, stage escalated, a paused operation present, and an open gate must authorize resume or retry. Example: `const command = gate.allowedCommands.includes("resume")`. The use case both decides eligibility and writes the resulting events. Domain/publication.ts already owns related publication decisions, but not this one. **Correction:** move just the pure eligibility/command decision into that domain module; keep iteration for writes, scheduling and persistence in the use case. **Verification:** direct domain and use-case reads. **Effort:** small.

## Microkernel assessment

This is a **statically composed modular monolith with a useful microkernel**, not a runtime plugin platform. That is appropriate to the current single workflow. The strongest evidence is that the kernel accepts generic event bodies and an AgentRunner, and persists and folds runs without importing factory, Pi, SQLite or the server. Factory owns what an approved plan, reviewed execution or publishable commit means. Replacing Pi with the fake runner preserves those decisions. Package acyclicity supports this claim; by itself it would not prove it.

The generic boundary is less convincing for code-host publication (PA15-03). Apply the same admission test to future capabilities: does a workflow need a mechanism the kernel itself consumes, or does one feature merely need an outbound port? A type exported from kernel is part of its change surface even if the import is erased at runtime. Keep factory-specific acceptance/transition policy out of the generic recovery mechanism.

**Second-module exercise:** a new read-only investigation workflow could reuse the run log, store, runner and costs without changing the run reducer. It could not simply register itself today: apps/server/src/run-application.ts:149–151 maintains three factory handle maps, and :194 treats an unrecognized recovered config as a planning run. Run summaries and commands also explicitly select factory handles. Its first integration would require host recovery dispatch and read-model routing in addition to ordinary root wiring. That is an extension limit, not a current defect: engine-design.md:59 deliberately defers the registry until a second module. When one exists, introduce an explicit module discriminator and a small static dispatch table in the host, with a test that unknown kinds are not opened as factory runs. Do not add runtime discovery, a service locator, an event bus or separately deployed services to solve a one-module problem.

## Enforcement, strengths and limits

All four architecture suites passed (81 tests); Biome lint passed (287 files). CI runs pnpm check. The checked literal package graph has no cycles, including the current kernel and factory layers. Server bootstrap snapshots its environment; engine domain/application effect restrictions and public-package imports are checked. Factory handle snapshots are detached. Adapter packages and the web feature tree have clear owners. No independent structure defect was established. The small number of broad commits below is not evidence that these layers need rearranging.

- **T1:** add the live duplicate tests in PA15-01/02. Assert no new recovery events, one active owner and a terminal summary. A graph rule cannot prove these properties.
- **L3/D2:** add adapter contract cases for process launch and storage failure, and a narrowly scoped check against module-level mutable acceptance queues in factory application. Scope out per-handle private representation.
- **Microkernel:** the present checker permits all exports of contracts into kernel. Guard generic runtime files against importing publication/factory-specific records (including via the contracts barrel); explicitly isolate the publication capability first. Keep contract compatibility and unknown-kind recovery tests with the second module.
- **L2:** test the domain decision directly; banning conditionals in use cases would also ban valid orchestration.

Coverage ledger: boundary and structure inventory includes every package below; responsibilities were sampled. Kernel/factory: verified run recovery, live publication, state ownership, ports and selected policy; not every planning/review branch. Server: verified startup, command/handle registration and summaries; not every endpoint. Contracts: sampled event and publication schemas; config: bootstrap boundary, not every precedence rule. CLI/web (connection, runs, plan review, workspace and settings): checked declared graph/layout, not every UI decision. Jira/fake runner/SQLite: inspected translation, scripted behavior and storage respectively. Git/GitHub/Pi/checks-process: graph/layout checked; GitHub identity mapping sampled, full Git recovery, Pi RPC and process behavior unverified. Next probe for those areas: compare each adapter's failure mapping with the consumer's port contract. No security, performance or general code-quality findings asserted. No live provider, full functional suite or deployment was run.

## Reproducible inventory

Production TypeScript source counts and literal cross-package imports (one count per import/export statement); tests and vendor/build files excluded. Co-change uses the last twelve months of non-merge commits, not the uncommitted working tree.

| Package | Source files | Imports of other Payo packages |
|---|---:|---|
| adapters/checks-process | 1 | kernel ×1 |
| adapters/gh | 2 | contracts ×1, kernel ×2 |
| adapters/git | 4 | contracts ×2, kernel ×4 |
| adapters/jira-acli | 1 | contracts ×2, kernel ×1 |
| adapters/runner-fake | 1 | contracts ×1, kernel ×1 |
| adapters/runner-pi | 1 | contracts ×1, kernel ×1 |
| adapters/store-sqlite | 1 | contracts ×1, kernel ×1 |
| apps/cli | 4 | config ×1, contracts ×5 |
| apps/server | 16 | checks-process ×1, config ×4, contracts ×14, factory ×10, gh ×1, git ×3, jira-acli ×2, kernel ×6, runner-fake ×2, runner-pi ×2, store-sqlite ×1 |
| apps/web | 41 | contracts ×31 |
| modules/factory | 51 | contracts ×65, kernel ×31 |
| packages/config | 1 | contracts ×1 |
| packages/contracts | 14 | none |
| packages/kernel | 23 | contracts ×20 |

| Frequently co-changing packages | Joint commits | Commits per package |
|---|---:|---|
| apps/server / modules/factory | 10 | 10 / 10 |
| apps/server / packages/contracts | 9 | 10 / 9 |
| modules/factory / packages/contracts | 9 | 10 / 9 |
| adapters/runner-pi / apps/server | 8 | 8 / 10 |
| adapters/runner-pi / modules/factory | 8 | 8 / 10 |
| adapters/runner-pi / packages/contracts | 8 | 8 / 9 |
| adapters/runner-pi / packages/kernel | 8 | 8 / 8 |
| apps/server / packages/kernel | 8 | 10 / 8 |

Production source directory counts (paths relative to payo):

```text
adapters/checks-process/src  1
adapters/gh/src  2
adapters/git/src  4
adapters/jira-acli/src  1
adapters/runner-fake/src  1
adapters/runner-pi/src  1
adapters/store-sqlite/src  1
apps/cli/src  4
apps/server/src  16
apps/web/src  1
apps/web/src/app  2
apps/web/src/features/connection  4
apps/web/src/features/plan-review  5
apps/web/src/features/run-workspace  18
apps/web/src/features/runs  3
apps/web/src/features/settings  2
apps/web/src/shared/api  2
apps/web/src/shared/ui  3
apps/web/src/test  1
modules/factory/src  1
modules/factory/src/application  19
modules/factory/src/application/execution  12
modules/factory/src/application/planning  5
modules/factory/src/application/publication  5
modules/factory/src/domain  8
modules/factory/src/infrastructure  1
packages/config/src  1
packages/contracts/src  14
packages/kernel/src  2
packages/kernel/src/adapters  2
packages/kernel/src/application  12
packages/kernel/src/domain  7
```


## Fixes applied

All six findings received targeted changes: duplicate opens skip kernel recovery;
server publication registration retains the live handle; CodeHost uses a neutral
RepositoryTarget while persisted GitHubTarget decoding is preserved; Jira launch
and artifact read/write failures are translated with their original causes;
acceptance serialization is owned by each store instance; publication resume
eligibility and gate-command selection live in domain policy.

The existing RunStore port gained serializeAcceptance, implemented by both
memory and SQLite stores. External implementations of that port must supply the
same per-instance serialization capability. No dynamic plugin registry was added.

Validation after fixes: Biome passed (287 files); core and web TypeScript checks passed; full Vitest run passed with 1,134 tests, three skipped (95 files passed, two skipped). Full suite required local HTTP binding outside the sandbox. Live provider operations were not run.
