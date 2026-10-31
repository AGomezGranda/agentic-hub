## Plan Review: Payo step 5 — server and CLI
**Verdict:** REVISE

The plan is well aligned with the roadmap and preserves the server-as-composition-root boundary, but startup recovery has a concrete partial-initialization failure: a crash can leave a listed run without the checkpoint that `openFactory` requires. There are also several nonblocking gaps around plan-file permissions, shutdown ordering, process-test isolation, and how users and local CLI commands locate the executable and configured data directory.

### Coverage

- **Checked:** Architecture, Code Quality, Test Coverage, Correctness, Security, Safety, Simplicity, Database, Compatibility, Usability, Documentation, Standards, and Portability. Plan areas checked: current state and design decisions; risks and mitigations; all three phases; success criteria; exclusions and assumptions.
- **Not applicable:** Accessibility aspects of Standards; this plan adds no UI. Performance was considered at the plan level; the server is local and the plan states no scale target, so no performance finding is confirmed.
- **Unverified:** None. Review was against the full plan, its cited roadmap/design, and the relevant existing factory, store, contract, package, and test code; it does not assess an implementation that does not yet exist.

### Cross-Cutting Themes

No single defect was independently raised by multiple lens groups. The recovery and shutdown findings both concern lifecycle safety but have distinct causes and corrections: incomplete initialization must be recoverable, and graceful shutdown must coordinate active tasks with store closure.

### Findings

#### Major

- 🟡 **Correctness**: Startup can fail on a partially initialized run — **Location**: Phase 1, “Refactor the factory runner…” and “Add `composition.ts`…”; Risks & Mitigations, restart recovery. **Confidence: High. Effort: Low–Medium.** Existing `start` persists `run.created` through `startRun` before the checkpoint is appended separately. If the process stops in that gap, `listRunIds()` will return the run but `openFactory()` cannot load its checkpoint (`loadCheckpoint` throws), so the specified recovery of every ID can prevent server startup. The planned `beginFactory` seam does not say it changes this persistence boundary. Counterevidence considered: the plan tests crashes during an attempt and says recovery records interruptions, but neither covers a run with no checkpoint. **Correction:** Make initial run creation/checkpoint recording atomic, or define and test recovery for a `run.created` record without a checkpoint so it cannot block recovery of other runs.

#### Minor

- 🔵 **Security / Safety**: Owner-only storage does not explicitly cover working plan files — **Location**: Phase 1, `auth.ts` permissions; Phase 2, `payo edit <run-id>`. **Confidence: Medium. Effort: Low.** The plan promises owner-only data/token files, but the existing factory `writePlan` creates `runs/<runId>/plan.md` without restrictive modes and the plan does not identify that writer or add a permission test. With a permissive data directory/umask, another local user could read or modify the plan that `edit` opens. Counterevidence considered: the SQLite adapter creates new database/artifact storage restrictively, and an owner-only parent data directory would also protect children, but the plan does not define that guarantee for existing directories or plan files. **Correction:** Specify and test an owner-only guarantee for the data directory and plan path (either restrict the containing directories or create run directories/files with restrictive modes, including a policy for existing paths).

- 🔵 **Safety**: Shutdown can close SQLite while server-owned tasks are still active — **Location**: Phase 1, “Run lifetime belongs to the server” and `main.ts` startup/shutdown; Phase 3, restart scenario 2. **Confidence: Medium. Effort: Low–Medium.** Background commands are intentionally independent of request sockets, while `main.ts` is also required to close the store on termination. No ordering or cancellation/drain policy is specified. A signal handled as graceful shutdown could therefore close the store before an active task has finished its next append. Counterevidence considered: the process-level scenario verifies recovery after terminating a hung run, but does not specify graceful signal behavior or test shutdown ordering. **Correction:** Define shutdown behavior (stop accepting commands, then drain or abort active tasks before closing the store) and test SIGTERM during active work plus recovery after restart.

- 🔵 **Test Coverage**: Process-level acceptance contends for the fixed production port — **Location**: Phase 1, fixed port `7331` and test listener port `0`; Phase 3, process-level acceptance. **Confidence: High. Effort: Low.** Phase 3 launches actual server and CLI processes, but `payo serve` is specified to use `7331` and the only port-0 support is an injected server factory. The e2e test can fail before exercising behavior if another Payo process or concurrent test owns that port. Counterevidence considered: temporary data directories isolate storage, and fixed-port conflict is deliberately tested operationally, but neither isolates the process test’s TCP listener. **Correction:** Provide a test-only port override for spawned server/CLI processes, or explicitly serialize the test and detect/report port unavailability.

- 🔵 **Usability / Documentation**: The plan does not say how users put the private workspace binary on `PATH` — **Location**: Phase 2, CLI executable launch and command list; Phase 3, README update/manual flow. **Confidence: High. Effort: Low.** Adding a `bin` entry makes the package executable, but a `pnpm install` in this private workspace does not by itself make bare `payo ...` commands available in an ordinary shell. The plan documents Node/pnpm setup and then expects users to run `payo`, without defining a supported installation or invocation path. Counterevidence considered: users could invoke a binary under `node_modules/.bin` or install/link it globally, but neither is specified. **Correction:** Choose and document a supported checkout invocation (for example, a root script or a pnpm-filtered command) and use it in the manual criteria.

- 🔵 **Usability / Compatibility**: Local CLI commands have no defined resolution for a custom data directory — **Location**: Phase 1, `PAYO_DATA_DIR`; Phase 2, `payo edit` and `payo token`. **Confidence: Medium. Effort: Low.** The server may use a non-default `PAYO_DATA_DIR`, while `edit` and `token` must read local files under that directory. The plan does not state that the CLI uses the same environment/default resolution or another discovery mechanism. Invoking the CLI from a different shell can therefore make it look in `~/.payo` instead of the server’s configured directory. Counterevidence considered: the environment may be inherited/shared in the documented flow, but that requirement is not stated and is not covered by a custom-directory CLI test. **Correction:** Define shared `PAYO_DATA_DIR` resolution for local CLI operations and test `edit`/`token` with a non-default directory.

### Strengths

- ✅ Preserves the agreed process boundary: the server is the sole composition root and the CLI remains a thin client limited to contracts and Node built-ins.
- ✅ Adds run listing through the shared `RunStore` port instead of coupling the future UI or HTTP handler to SQLite internals.
- ✅ Covers important seams at multiple levels, including contract/store tests, HTTP and factory-flow tests, CLI tests, and fake-only process acceptance with temporary data directories.
- ✅ Explicitly addresses loopback binding, bearer authentication, exact Origin checks, disconnect-independent work, restart recovery, and the absence of automatic resume.

### Recommended Changes

1. Make initialization recoverable if the process stops between `run.created` and checkpoint persistence; test that startup can recover or isolate such a run (addresses the Major finding).
2. Specify and test owner-only permissions for the data directory and editable plan files, including existing paths (addresses the storage-permissions finding).
3. Define active-task behavior on graceful shutdown and test the signal path before closing the store (addresses the shutdown finding).
4. Add an isolated listener-port mechanism for the process-level tests, or document reliable serialization and port-conflict handling (addresses the test-isolation finding).
5. Document how a checkout invokes/installs the private CLI and use that same invocation in the acceptance flow (addresses the CLI availability finding).
6. Define shared `PAYO_DATA_DIR` resolution in the CLI and cover non-default paths for `edit` and `token` (addresses the custom-directory finding).
