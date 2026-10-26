## Plan Review: Portable Pi handler foundation

**Verdict:** REVISE

Reviewed on 2026-10-24. The handler boundary, conservative adoption/release rules, and staged test strategy are well specified. Two confirmed P1 issues remain at the external-process boundary: Pi's own settings persistence violates the unconditional unrelated-value preservation contract, and a direct-child timeout does not establish that package mutation has stopped before retry. A P2 clarification is also needed for doctor's read-only guarantee.

### Coverage

| Lenses / plan areas | Result |
|---|---|
| Architecture, Code Quality — module responsibilities, CLI integration, distribution model, phase boundaries | Checked against the full plan, `cli.py`, `catalog.py`, `agents.py`, `behavior.py`, `tui.py`, and `pyproject.toml`. Directly imported handler modules and service-owned orchestration fit this repository; existing skill/behavior APIs remain separate. |
| Correctness, Safety — ownership, adoption, drift, release, journals, locking, partial progress, file writes | Checked against all ownership/process rules and Phases 1–3, the existing behavior writer, installed Pi package/persistence source, and a synthetic subprocess probe. Findings PHF-01 and PHF-02 identify external-boundary gaps; no all-or-nothing transaction guarantee is assumed. |
| Security — input validation, secret exposure, executable sources, file layout, subprocess invocation | Checked manifest restrictions, private-state scope/permissions, redacted diagnostics, unsafe-file rejection, neutral cwd, and upstream project-trust/package-command code. Review is bounded to the handler's configuration and process boundary, not third-party package security or a sandbox guarantee. |
| Test Coverage — isolation, pyramid, right-level scenarios, failure injection | Checked `tests/conftest.py`, `tests/test_cli.py`, CI commands, and every phase's planned tests. Planner/controller cases and CLI round trips are separated appropriately. The fake-runtime suite needs the specific upstream-persistence and descendant-lifecycle regressions described below. |
| Compatibility, Portability — Pi 1.4.0 CLI, package identity/pins, root/launcher resolution, bootstrap | Checked installed Pi README and relevant complete package/settings/environment/CLI/configuration/security docs, plus launcher and package-manager source. `install`/`remove`, exact source replacement by package identity, and `--no-approve` are supported by the inspected 1.4.0 source. PHF-01 concerns settings compatibility, not unsupported package flags. |
| Documentation, Usability, Standards — status/doctor semantics, exit codes, recovery, relocation, onboarding | Checked the plan, current README, parser, review-folder conventions, and upstream startup behavior. The explicit ownership lifecycle and bootstrap instructions are coherent; PHF-03 qualifies doctor's filesystem guarantee. |
| Database | Not applicable: no database, query, or database-migration work. JSON ownership-state schema/versioning is included in correctness coverage. |
| Performance as a separate lens | Not applicable: this is a bounded local reconciliation command with sequential package operations, no service hot path, and no caching subsystem. Process deadlines are reviewed as correctness/safety, not throughput. |
| Implemented handler, full test suite, real package lifecycle, live CLI smoke test | Unverified: the handler does not exist yet and this review did not implement/install it or invoke the real Pi launcher. Real npm/network operations and personal configuration were not accessed. These future acceptance activities must not be described as passed. |

No prior review exists for this plan. No child-dispatch tool was available; the lenses were reviewed serially, with upstream-source verification and two isolated synthetic probes. Existing unrelated working-tree changes were left untouched.

**Evidence notation:** upstream paths below are relative to the installed package at `/Users/alvarogomez/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/`, except the separately identified launcher. These are version-specific review evidence, not portable paths to put into the implementation.

### Cross-Cutting Themes

**The delegation boundary must carry the safety contract.** Correctness, safety, compatibility, and testing converge on the same issue: safe Python writes and faithful fake executables cannot establish the behavior of Pi's independent full-file writer or installer children. Preflight and recovery must account for those behaviors explicitly.

**“Read-only” needs a precise scope.** Status and dry-run can retain the strict zero-write promise because they do not launch Pi. Doctor's useful executable/version check conflicts with an absolute filesystem promise because upstream startup performs maintenance. Prefer documenting that narrow exception over adding a new version-discovery framework.

There is a preservation/compatibility tradeoff in PHF-01: rejecting settings that Pi would migrate is conservative but can prevent a package-only apply until the user migrates their local file separately. Allowing migration is more convenient but expands the explicitly owned surface. The recommended v1 resolution is fail-closed preflight with an actionable diagnostic, retaining the existing preservation goal.

### Findings

#### Critical

None confirmed.

#### Major

- 🟡 **Correctness / Safety / Compatibility / Test Coverage**: PHF-01 — Delegated package writes do not preserve every unrelated JSON value — **Location**: Design Decisions → Pi process boundary and safe writes, preservation/preflight paragraph (plan line 102); Phase 3 → adapter integration tests (line 201).

  **Severity:** P1. **Confidence:** high. **Effort:** medium; bound supported observed input before delegated writes and add persistence-boundary regression tests.

  **Violated contract:** “Preserve all unrelated JSON values and package entries,” including preservation of unmanaged machine-local settings, with known incompatibilities detected before mutation.

  **Concrete consequence:** A package-only install/update/removal can rename or remove an unowned setting or alter its numeric value. A fresh read afterward observes the changed file but cannot prevent the already-completed unrelated mutation; the ownership journal intentionally does not retain unrelated original values.

  **Evidence and rationale:** Pi 1.4.0 `dist/core/settings-manager.js:449–472` parses the complete current file, calls `SettingsManager.migrateSettings`, and serializes the result during a package-field save. Its migrations include `queueMode` → `steeringMode` (`:281–286`), legacy `skills` transformation, and retry-key migration. JavaScript JSON parsing also cannot preserve arbitrary Python JSON integers. An isolated probe used the actual installed `SettingsManager` against a temporary synthetic file, called only `setPackages` and `flush`, and confirmed that unowned `queueMode` disappeared, unowned `steeringMode` appeared, and the integer `9007199254740993` was not preserved, with zero persistence errors. No package install, launcher, npm, network, or personal settings were involved.

  **Counterevidence considered:** Pi's package manager updates declarations by identity and preserves unrelated package entries in the normal case (`dist/core/package-manager.js:624–678`). The plan already rereads after each subprocess and verifies success postconditions. Those safeguards are valuable but do not stop full-file migration or numeric conversion. A fake executable that faithfully preserves unrelated values will not expose this upstream behavior.

  **Smallest sufficient correction:** Define and preflight a Pi-write-compatible observed-settings subset before any package command: reject settings requiring known 1.4.0 migrations or containing values that its JSON round trip cannot preserve, with a value-redacted instruction to migrate/repair locally first. Keep this check specific to delegated package writes; ordinary read-only inspection and hub-owned setting writes need not acquire those restrictions unnecessarily. Add regressions against the actual Pi persistence behavior, or a version-grounded fixture/contract test covering migration and numeric conversion, without requiring real npm/network. If broader migration is desired instead, explicitly revise the preservation/ownership contract and obtain user consent rather than silently accepting it.

- 🟡 **Correctness / Safety / Test Coverage**: PHF-02 — Timeout does not establish that installer children have stopped — **Location**: Design Decisions → Pi process boundary and safe writes, timeout/lock/journal rules (plan lines 96, 104, 108); Phase 3 → runtime changes and failure tests (lines 184–201).

  **Severity:** P1. **Confidence:** high. **Effort:** medium; specify process-tree lifecycle handling and extend the fake-executable failure test.

  **Violated contract:** Package operations are sequential, concurrent hub apply is excluded, and a failed/interrupted operation can be conservatively retried from its observed pre/post managed state.

  **Concrete consequence:** Killing the direct Pi process on timeout can leave npm or a lifecycle child changing the package installation. The handler can release its lock and a later apply can retry while that earlier child is still running. Settings declarations can still equal the journal's pre-state, so declaration inspection does not detect this overlap.

  **Evidence and rationale:** Pi's `dist/core/package-manager.js:1527–1550` launches a separate package-manager process for install/remove; `:2141–2148` and `:2197–2213` spawn it and await exit without a process-tree cancellation contract. The inspected package-command path has no compensating signal-forwarding handler. Python's ordinary subprocess timeout terminates the direct child, not its descendants. A harmless temporary-file probe confirmed that a spawned descendant wrote its marker after its direct parent timed out. The plan requires an explicit timeout and sanitized errors but never specifies descendant termination/reaping or fail-closed behavior when shutdown cannot be established.

  **Counterevidence considered:** The journal deliberately retries interrupted installs and the plan disclaims rollback of third-party side effects. Both are appropriate. Neither makes concurrent installation safe, and the handler lock only excludes another hub process while it remains held. No containment of deliberately detached or hostile third-party processes is assumed here.

  **Smallest sufficient correction:** Specify lifecycle handling for timeout and handled interruption: start the runtime in an isolated process group/session on supported POSIX platforms, terminate/escalate/wait for the ordinary installer process tree before releasing the apply lock or enabling retry, and define a fail-closed/manual-recovery path when shutdown cannot be established. Document platform support and the abrupt-crash limit; stale-lock recovery must check installer descendants, not only the original hub PID. Extend the fake runtime to spawn a delayed-writing child and assert that timeout/interruption cannot leave that ordinary child mutating after apply reports termination or permits retry. Do not expand this into a sandbox promise.

#### Minor

- 🔵 **Documentation / Usability / Compatibility**: PHF-03 — Doctor's upstream version check is not literally zero-write — **Location**: Design Decisions → Read-only planning and CLI contract (plan line 90); Phase 2 → doctor tests; Phase 4 → doctor limits and smoke-test documentation.

  **Severity:** P2. **Confidence:** high. **Effort:** small; narrow the guarantee and align acceptance wording.

  **Violated contract:** “Read-only operations never create directories” while doctor is permitted to execute `pi --version` through the resolved launcher.

  **Concrete consequence:** A user can run a supposedly zero-write doctor and trigger upstream lock-directory creation or managed-install staging cleanup. A relocated `PI_CODING_AGENT_DIR` does not relocate the launcher's installation-maintenance root, so a temporary agent root is not complete filesystem isolation for that command.

  **Evidence and rationale:** Pi 1.4.0 `dist/main.js:466–469` runs `cleanupManagedInstall()` and constructs a settings manager before handling `parsed.version` at `:503`. `dist/package-manager-cli.js:117–150` acquires an installation update lock and removes matching staging directories. `FileSettingsStorage.withLock` (`dist/core/settings-manager.js:148–178`) also locks an existing settings file during reads. The managed launcher at `~/.pi/agent/bin/pi` sets `PI_MANAGED_INSTALL_ROOT` from its own location, independently of the config-root override. This was established by source inspection; the real launcher was not executed.

  **Counterevidence considered:** The version path does not start an agent session or load/connect MCP servers, and it does not request package installation. Status and dry-run avoid this issue entirely because they do not launch Pi. The finding concerns the absolute filesystem guarantee, not a claim that doctor normally rewrites personal settings.

  **Smallest sufficient correction:** Keep strict zero-write guarantees for status/dry-run. Describe doctor as making no hub-owned configuration/ownership changes while allowing upstream startup locks and installation maintenance during its version probe. Disclose that a temporary HOME/agent root alone does not isolate an explicitly selected installed launcher. Align doctor tests and the smoke-test instructions with that scope; do not imply a mocked version boundary proves upstream side-effect freedom.

### Strengths

- ✅ `pi_handler/` has a bounded purpose, direct modules, and service-owned orchestration; neither skill distribution nor behavior persistence is absorbed into the new controller.
- ✅ Adoption distinguishes tracking from destructive ownership: preexisting packages are retained on release, adopted-package version changes are rejected, and managed drift blocks cleanup.
- ✅ Status/dry-run do not resolve or run Pi, missing state never authorizes deletion, and an empty fresh manifest produces no writes or subprocesses.
- ✅ The plan explicitly models partial progress, verifies declarations even after exit 0, retries interrupted installs rather than treating declarations as installation proof, and avoids unsafe reverse package operations.
- ✅ Tests isolate HOME/roots/launcher fallback, target ownership edges at planner/apply level, and reserve CLI tests for dispatch, exit codes, privacy, and a round trip. Fake-runtime coverage is not presented as proof of live package compatibility.
- ✅ The baseline selects no packages or preferences, bootstrap keeps credentials machine-local, and documentation includes release-before-uninstall and explicit checkout-relocation handling.

### Recommended Changes

1. Add package-write compatibility preflight and migration/numeric-preservation contract tests before implementing Phase 3. Retain fail-closed preservation unless the user explicitly chooses broader migration authority. (Addresses: PHF-01.)
2. Define timeout/interruption process-tree shutdown, lock-release ordering, and descendant-aware crash recovery; add a delayed-child mutation regression. (Addresses: PHF-02.)
3. Narrow doctor's zero-write wording while retaining status/dry-run's strict guarantee; disclose installed-launcher maintenance in the smoke-test guide. (Addresses: PHF-03.)

The plan and feature code remain unchanged. The only authored artifact is this review. After agreed targeted edits, re-review the affected safety/correctness/testing lenses and the newly constrained compatibility, portability, documentation, and runtime interfaces; append a dated re-review pass here.

## Re-Review (Pass 2) — 2026-10-24

**Verdict:** APPROVE

The user requested revalidation and direct plan fixes where warranted. All three original findings remain supported by the inspected Pi 1.4.0 source; targeted corrections have now been applied to `meta/plans/2026-10-24-pi-handler-foundation.md`. The revised plan has no remaining confirmed findings within this re-review's scope. This verdict approves the plan, not an implementation or permission to install/apply configuration on this machine.

### Coverage

| Lenses / interfaces | Result |
|---|---|
| Correctness, Safety, Security — Pi persistence, preflight, postconditions, journals | Checked the revised full plan against `SettingsManager.migrateSettings` and `persistScopedSettings`. Package-write compatibility is now checked before mutation and on fresh snapshots; unexpected unrelated-value changes require manual repair and cannot auto-clear on managed pre/post equality. Unrelated snapshots remain memory-only. Pi-written file corruption is explicitly outside journal restoration. |
| Correctness, Safety, Test Coverage — subprocess lifetime, deadlines, locks, recovery | Checked runtime/service responsibilities and tests against Pi's separate npm child execution. The plan requires isolated POSIX groups, bounded output collection and shutdown/escalation, direct-child reaping, descendant checks before lock release/retry, and retained locks/journals when shutdown is uncertain. Delayed writers, retained pipes, interruption, forced escalation, and fail-closed uncertainty have acceptance tests. |
| Compatibility, Portability — version eligibility, numeric subset, platform support, previews | Checked the new interface constraints and their scope. Package subprocesses, including interrupted-install retries, require a validated version (initially 1.4.0), writer-compatible observed settings, and supported POSIX control. Pure previews report known compatibility blockers without resolving/running Pi; setting-only and no-subprocess adoption/release are not blanket-rejected. |
| Architecture, Code Quality — changed responsibility placement | Checked the affected plan sections: pure compatibility checks remain in planning; process lifecycle belongs to runtime; lock/journal finalization belongs to service/state. No new framework, dependency, generic serializer, migration engine, or sandbox is introduced. Existing skill/behavior boundaries are unchanged. |
| Documentation, Usability, Test Coverage — doctor, bootstrap, smoke test | Checked startup ordering in `dist/main.js`, maintenance in `dist/package-manager-cli.js`, and revised doctor/test/smoke-test wording. Strict zero-write scope remains status/dry-run; doctor discloses upstream locks/installation maintenance. Temporary config roots are not described as complete isolation of an installed launcher. |
| Other original-review areas | Unchanged and covered by the original review. Database and a separate performance review remain not applicable for the previously stated reasons. |
| Implementation, platform execution, fixture accuracy after authoring, real package lifecycle | Unverified: this pass edits Markdown requirements only. No handler implementation, installer, real Pi launcher, npm/network operation, or personal-configuration mutation was run. Future implementation and smoke-test acceptance remain required. |

### Finding Disposition

| ID / original title | Result | Applied correction |
|---|---|---|
| PHF-01 — Delegated package writes do not preserve every unrelated JSON value | **Resolved in plan** | Added version-specific migration/numeric preflight, eligible-version gating, fresh-snapshot rechecks, unrelated-value postconditions, and synthetic version-grounded persistence fixtures with upstream provenance. A failed unrelated-value postcondition persists a manual-repair marker; a subsequent apply cannot silently clear it. |
| PHF-02 — Timeout does not establish that installer children have stopped | **Resolved in plan** | Added POSIX-only package lifecycle support, group shutdown/escalation and bounded pipe collection, service-visible shutdown certainty, lock retention when uncertain, descendant-aware crash recovery, and process-tree failure tests. |
| PHF-03 — Doctor's upstream version check is not literally zero-write | **Resolved in plan** | Scoped zero-write guarantees to status/dry-run; documented doctor's upstream startup effects and installed-launcher isolation limits in both design and Phase 4 acceptance work. |

### Cross-Cutting Themes and Tradeoffs

The preservation contract now constrains the delegate as well as the hub's own writer. Rejecting legacy settings or unsafe numeric inputs before package mutation is less convenient than allowing Pi to migrate them, but preserves the stated ownership boundary without persisting unrelated credentials or adding an automatic migrator. A validated-version gate prevents treating a 1.4.0-specific compatibility check as evidence for uninspected versions.

Process shutdown is now a prerequisite for finalization and retry, rather than something inferred from a declaration or direct-child exit. POSIX-only package mutation bounds v1's support honestly; detached/hostile processes and unrelated-file reconstruction remain explicitly excluded rather than promised by the journal.

### Findings

No remaining confirmed P0, P1, or P2 findings in the revised scope.

### Strengths

- ✅ The added requirements are attached to the existing planner/runtime/service responsibilities and phase tests rather than introducing a second orchestration or migration system.
- ✅ Preview remains subprocess-free, while package mutation gets explicit compatibility and process-lifetime gates.
- ✅ Recovery now distinguishes ordinary retryable pre/post states from manual-repair failures and uncertain live installers.

### Validation and Deliberate Exclusions

- Read the complete revised plan and rechecked the affected upstream persistence, child-process, and startup source. The prior synthetic probe evidence remains applicable; no additional real runtime operation was needed.
- Checked Markdown whitespace/fence integrity and required correction markers. No application tests were run because no application code changed; this is not a claim that future acceptance tests pass.
- Deliberately did not add automatic migration, full-file credential-bearing backups, cross-platform process-tree machinery, a nonexecuting version-discovery framework, or a sandbox. The plan uses fail-closed checks and explicit support limits instead.
- Only the plan and this review were edited; unrelated working-tree changes were preserved.

No further plan corrections are required by this pass. Implementation remains a separate, explicitly authorized task.
