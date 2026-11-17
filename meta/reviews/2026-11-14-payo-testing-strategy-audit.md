# Payo testing strategy audit — 2026-11-14

Verdict: the existing strategy fits this local developer tool well. Keep the unit/component base and real Git/SQLite boundary tests. Four P2 improvements are justified; no P0/P1 testing-strategy defect was confirmed. This is an audit of the current working tree, including its staged changes, not only HEAD. Implementation and tests were not changed.

## Follow-up fixes — 2026-11-14

The audit below records the original observations. All four corrections have
since been implemented:

- TS-01: both cancellation tests wait for a descendant PID, bound the wait for
  cancellation, assert the descendant is gone on return, and clean up on failure.
- TS-02: Payo CI now runs the existing `pnpm web:build` command.
- TS-03: a publication component regression proves that base movement after
  push escalates without creating a draft PR.
- TS-04: `pnpm smoke:external` runs separate opt-in, read-only GitHub/Jira
  probes using real adapters, prints CLI versions and requires existing targets.
  The usage guide records fixture-provenance limits and refresh instructions.

Validation: Biome, both TypeScript projects, the full Vitest suite (**1,129
passed, 3 live tests skipped**) and the production web build passed. The final
bounded cancellation tests were also rerun separately (49 passed). Both new
external probes passed through temporary fixture executables; missing targets
failed before any CLI was spawned. Live providers were not contacted, so their
current compatibility and the original fixtures' producing versions remain
unverified. No production implementation or dependencies were changed.

## 1. Service shape

Payo is a co-versioned TypeScript monorepo: React web and CLI consumers call a loopback HTTP server, which composes factory planning/execution/publication workflows, kernel state/recovery logic, and SQLite plus artifact-file persistence. External boundaries are Git/worktrees/remotes, GitHub through `gh`, Jira through `acli`, Pi subprocess JSON streams, configured check processes, and desktop folder/editor/terminal launchers; there is no broker or cache (`payo/apps/server/src/adapters.ts:172`, `payo/apps/server/src/composition.ts:84`).

This is a local tool rather than an independently deployed microservice fleet. Its safety-sensitive operations write developer worktrees and publish branches/PRs, so recovery, ownership, cancellation and confirmation deserve more depth than routine UI formatting. No separate-team API/event consumer was identified; web and CLI share `@payo/contracts` with the server.

## 2. Current distribution and execution

Inventoried **96 test files**. Classification follows what runs, using each file's principal purpose. Mixed files count once: their case totals below inherit that classification, so these are suite-group totals, not a claim that every case is a pure example of that level. For example, Pi mixes mapper units and subprocess integration; HTTP/component tests include real SQLite.

| Level/group | Files | Cases | Aggregate file execution time | Actual scope / doubles |
|---|---:|---:|---:|---|
| Unit | 49 | 516 | 2.14 s | Kernel/domain/projections/schema parsing, focused factory logic, UI transport helpers; memory stores and fake runners/executors where needed |
| Integration | 16 | 236 | 34.47 s | Real Git, bare remotes, SQLite, files/config, child processes, CLI transport against local HTTP fixtures; external providers replaced |
| Component | 26 | 295 | 53.42 s | Factory workflows, server composition/HTTP/process journeys, 17 React interaction suites; external effects stubbed |
| External producer contracts | 0 dedicated | 0 | — | GH/Jira fixtures do not verify current producers; see TS-04 |
| Complete E2E | 0 | 0 | — | No real browser-to-external-provider journey |
| Opt-in live boundary smoke | 1 | 1 skipped | Not run | Real Pi/Git, gated by `PAYO_LIVE=1`; partial-system smoke, not full E2E |
| Architecture checks | 4 | 81 | 0.53 s | Dependency/layer/import rules; kept outside behavioral pyramid totals |

Contract testing is also an orthogonal strength: the same **14-case RunStore contract** runs against memory and SQLite (`payo/packages/kernel/src/testing.ts:130`, `payo/packages/kernel/src/store.memory.test.ts:5`, `payo/adapters/store-sqlite/src/index.test.ts:36`). Those cases are already counted above. Files under `packages/contracts` test schemas; the directory name does not make them producer-verified consumer contracts.

**Observed run:** Node 24.11.1, Vitest 5.0.5, macOS: **1,128 passed, 1 skipped, 0 failed**, approximately **15.74 s wall time**. Aggregate file times overlap because files run concurrently. Slowest files were real Git execution (14.94 s), process journeys (14.40 s), HTTP (9.03 s), and assembled App interactions (6.81 s). This single run establishes neither CI runtime nor flakiness history.

Executed the installed Vitest entry directly with Node 24, matching CI's Node major. Initial sandboxed runs were interrupted after confirming that local listeners receive `EPERM`; the completed run used approved loopback access. Also ran the Vite production build successfully, directing generated output to `/tmp`. Biome and TypeScript checks were not rerun. CI currently runs install plus `pnpm check`, covering Biome, both TypeScript projects and default Vitest (`.github/workflows/ci.yml:44`, `payo/package.json:10`).

The distribution is a sensible broad base, not an E2E-heavy inversion. Local integration suites are substantial because Git/SQLite/process semantics are central product behavior; they do not depend on external service availability. Runtime provides no reason to split them into a separate mandatory pipeline now.

## 3. Confirmed findings

### TS-01 — P2 / high confidence — Cancellation tests can pass before descendants exist

- **Location/evidence:** `payo/adapters/checks-process/src/index.test.ts:97`: `setTimeout(() => controller.abort(), 60);`; corroborating `payo/adapters/runner-pi/src/index.test.ts:837`: a 75 ms wait before abort. Both later assert that a delayed-write file does not exist.
- **Violated testing obligation:** A test claiming process-tree termination must first establish a live descendant, and prove that cleanup completes before the writer lane is released.
- **Consequence:** Slow startup can let cancellation kill the parent before it spawns a descendant. A regression that kills only the parent could then pass. Waiting for a missing future write also does not prove that the descendant was gone when the adapter returned.
- **Counterevidence:** These are real subprocess tests, production code does signal process groups, and separate tests check detached spawning. The missing synchronization concerns regression detection, not a confirmed production cleanup bug.
- **Smallest correction:** Have the descendant publish a ready marker/PID, wait for it with a bounded poll, then abort. Assert that the descendant is gone when the operation resolves; include failure cleanup. Reuse this fixture pattern in both suites.
- **Effort:** Small. **Verification tier:** load-bearing full checks suite and implementation read; targeted corroboration of Pi test and neighboring cancellation tests.

### TS-02 — P2 / high confidence — CI never builds the browser artifact

- **Location/evidence:** `payo/package.json:10`: `"check": "biome check . && tsc -p tsconfig.json && tsc -p apps/web/tsconfig.json && vitest run"`; `.github/workflows/ci.yml:45`: `- run: pnpm check`.
- **Violated testing obligation:** CI should verify that the shipped browser entry and assets assemble successfully.
- **Consequence:** A broken HTML module entry or CSS/font import can bypass TypeScript and component tests and leave the console unbuildable.
- **Counterevidence:** Tests use the same Vite plugins/configuration. However, `payo/apps/web/src/app/App.test.tsx:12` imports App directly; `payo/apps/web/src/main.tsx:4` imports the stylesheet, and `payo/apps/web/index.html:11` wires the entry. The current production build succeeds; this is a missing regression gate, not a current build failure.
- **Smallest correction:** Add the existing `pnpm web:build` command to the Payo CI job. A build checks asset resolution; it does not establish browser runtime correctness.
- **Effort:** Trivial. **Verification tier:** load-bearing full package/workflow/Vite configuration and browser entry inspection, plus successful production bundling.

### TS-03 — P2 / high confidence — Publication tests do not exercise base movement between effects

- **Location/evidence:** `payo/modules/factory/src/application/publication.test.ts:183`: `resolveRepository: vi.fn(async () => target)`; production `payo/modules/factory/src/application/publication/run.ts:98`: `await recheckBase();` after the push stage.
- **Violated testing obligation:** Publication must revalidate the pinned target/base between push and draft creation, not merely validate it once during preview.
- **Consequence:** Removing an orchestration recheck could leave the guard's unit tests green while allowing draft creation after base drift. Existing fixtures always return the same repository/base.
- **Counterevidence:** The application suite covers durable intent, concurrent/repeated confirmation, unowned branches, lost push/PR responses and reopening. Domain tests explicitly reject a moved base (`payo/modules/factory/src/domain/publication.test.ts:223`), and composition tests cover publication restart. None establishes that the workflow invokes the guard at the relevant transition with changed observations. Production currently performs the rechecks.
- **Smallest correction:** One component test: push succeeds, subsequent repository lookup returns a moved base, workflow escalates, and `createDraftPullRequest` is never called. Test through the publication workflow with fake ports; a live GitHub race is unnecessary.
- **Effort:** Small. **Verification tier:** load-bearing full publication application suite, execution path and domain test suite read; targeted composition restart inspection.

### TS-04 — P2 / high confidence — GitHub/Jira compatibility stops at fixtures

- **Location/evidence:** `payo/adapters/gh/src/index.test.ts:18`: the executor returns queued strings; `payo/adapters/jira-acli/src/index.test.ts:103`: `createAcliTicketSource({ exec: stub.exec })`. The only live smoke exercises Pi/Git (`payo/apps/server/src/live.test.ts:72`).
- **Violated testing obligation:** Consumer fixtures alone do not establish that supported external producer versions still satisfy the consumed interface.
- **Consequence:** Changes in CLI behavior or required response fields can first appear during ticket resolution or publication reconciliation. Passing fixture tests cannot establish installed-provider compatibility.
- **Counterevidence:** GH tests assert argv, malformed responses, authentication failures, cancellation and ambiguous effects; Jira tests cover ADF parsing, argv and nonzero exits. GH's executor has a real subprocess test, but substitutes Node for `gh`. Those are valuable deterministic checks and should remain.
- **Smallest correction:** Extend the opt-in smoke pattern with read-only real-executor probes for a configured GitHub repository/base/PR query and Jira ticket. Record CLI versions and fixture provenance. Run when validating supported tool upgrades; keep credentials/network calls outside normal PR checks. Draft creation remains outside these read-only probes.
- **Effort:** Small–medium. **Verification tier:** load-bearing full GH/Jira test suites, live smoke and CI configuration inspection; adapter inventory searched for alternate producer verification.

## 4. Recommendations

| Priority | Change | Appropriate level and reason | Effort |
|---|---|---|---|
| Do now | TS-01: synchronize descendant cancellation fixtures | Integration: only real OS processes establish this safety property | Small |
| Do now | TS-02: run `pnpm web:build` in CI | Build validation: existing command closes the artifact-resolution gap | Trivial |
| Worth doing | TS-03: moved-base-after-push regression | Component: tests effect ordering with deterministic observations | Small |
| Worth doing before tool upgrades | TS-04: opt-in read-only GH/Jira probes | External contract/integration: tests the actual producer | Small–medium |
| Only if browser deployment/support grows | One browser connect → start → observe streamed progress journey against dev-fakes | Component/system seam: covers actual browser policy and entry wiring; no paid agent needed | Medium |

## 5. Explicitly not recommended

- **Do not add a full five-level microservice apparatus.** There is no broker or independently deployed internal consumer fleet. DLQs, rebalance tests, schema registries and Pact between co-versioned packages would address absent boundaries.
- **Do not replace real SQLite/Git tests with mocks to improve pyramid proportions.** SQLite trigger-induced rollback and cross-process writer contention exercise actual transaction behavior (`payo/adapters/store-sqlite/src/index.test.ts:304`, `:350`). Git publication tests race remote-ref creation against push using a temporary bare remote (`payo/adapters/git/src/publication.test.ts:161`). Memory doubles cannot establish those properties.
- **Do not move domain cases into browser/E2E tests.** Kernel/factory tests use real state/domain collaborators and injected effect ports, while assembled workflows cover recovery. No harmful mock-heavy domain style was confirmed in the sampled suites.
- **Do not require paid live-model calls for every PR or duplicate all UI cases in a browser suite.** The opt-in Pi smoke already separates external availability from deterministic checks. Seven process journeys cover plan revisions, configuration, execution/publication and restart; they use `--dev-fakes` and are out-of-process component tests (`payo/apps/server/src/e2e.test.ts:57`).
- **Do not add generic idempotency tests as if recovery were absent.** Repeated kernel recovery, plan install/checkpoint failures, lost publication responses, and real SQLite publication restart already have targeted coverage (`payo/packages/kernel/src/run.test.ts:93`, `payo/apps/server/src/factory-flow.test.ts:92`, `payo/modules/factory/src/application/publication.test.ts:271`, `payo/apps/server/src/composition.test.ts:781`).

## 6. Coverage and unresolved evidence

| In-scope area | Applicable levels checked | Limits / disposition |
|---|---|---|
| Kernel and factory policy/application | Unit; workflow component; local async recovery | Inventory complete; deeper reads sampled around execution/publication/recovery. TS-03 confirmed; no blanket claim of exhaustive invariant coverage |
| SQLite, plans/artifacts/config files | Integration; shared RunStore contract; reopen component | Real database/filesystem suite executed; rollback/reopen/concurrency evidence inspected |
| Git worktrees/commits/publication | Integration | Real temporary repositories/bare remotes executed; internet-hosted Git behavior unverified |
| Pi and check processes | Mapper/coordination unit; OS integration; cancellation | Deterministic suites executed; TS-01 confirmed; live Pi skipped |
| GH and Jira | Unit/fixture consumption; GH executor subprocess integration | TS-04 confirmed; current external producers unverified; next probe is opt-in read-only smoke |
| Server lifecycle/HTTP/auth/SSE | Integration/component/process journeys | Executed. Host/Origin/preflight checks and streamed/replayed events inspected |
| Web/CLI | Unit, jsdom interaction component, real CLI/server process journeys | Executed; browser bundling passed. Real browser CORS/history/rendering behavior unverified; next probe is one browser journey |
| Async semantics | Local checkpoint recovery, retries, duplicate acceptance, SSE ordering/deduplication | Checked; broker delivery/DLQ/outbox rules not applicable because no broker exists |
| CI and suite health | Pipeline/config inspection; one local execution | Historical runtimes/failure frequency unknown. No coverage threshold configured; no evidence justifies prescribing a percentage |
| Incidents and monitoring | Recent Payo commit history sampled | Recent commits bundle broad features/fixes; no incident dataset or CI history inspected. No claim that synthetic monitoring compensates for absent full E2E; next probe is actual CI failure/incident records |

Boundary inventory included desktop launchers; mocked launcher tests ran, but real interactive dialogs/editors/terminals were not launched. The root Python service and `pi/` are outside this audit. Existing staged work was preserved.
