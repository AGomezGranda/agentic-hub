---
date: 2026-10-24
title: Portable Pi handler foundation
status: awaiting-smoke-approval
---

# Portable Pi handler foundation

## Goal

Make agentic-hub the Git-backed source of truth for a portable, explicitly owned subset of personal Pi configuration. Provide the machinery to curate packages later, but ship no selected packages, extension configuration, or opinionated Pi settings.

Delivery is CLI-first: one shared baseline with unmanaged machine-local settings preserved. This plan does not authorize implementation or installation on the current machine.

## Current State

- `src/agentic_hub/cli.py:171` builds the argparse command tree; `:209` dispatches commands. Skills, behavior, and TUI entry points are separate.
- `src/agentic_hub/catalog.py:6` resolves skill sources relative to the checkout rather than the caller's working directory. The documented installation is editable (`README.md`, Install section); this foundation retains the checkout-based distribution model.
- `src/agentic_hub/behavior.py:88–101` resolves Pi's agent directory at call time, honoring `PI_CODING_AGENT_DIR`. `:272–295` demonstrates temporary-file writes, metadata preservation, conflict checks, and atomic replacement.
- `src/agentic_hub/agents.py:10–18` has an older import-time home-directory mapping for skill installation. Do not expand this task into refactoring skill distribution.
- `src/agentic_hub/tui.py:159–167` contains separate Skills and Behavior pages. No Pi page exists or is required in this delivery.
- `tests/conftest.py:9` isolates behavior configuration using temporary HOME and cleared root overrides. Pi tests need equivalent isolation, without relying on real user state.
- `.github/workflows/ci.yml:16–22` runs pyrefly, Ruff, and pytest. Reuse those checks and the existing test layout.
- Installed Pi 1.4.0 documentation establishes personal `settings.json`, `PI_CODING_AGENT_DIR`, pinned npm package declarations, and `pi install` / `pi remove`. Resource filters are supported upstream, but are outside this foundation. Commands such as `pi update` have other meanings and must not be used as a generic package installation operation.

## Design Decisions

### Module and configuration boundaries

Add `src/agentic_hub/pi_handler/` with small, directly imported Python modules: `config.py`, `state.py`, `planner.py`, `runtime.py`, and `service.py`. No plugin framework, daemon, new dependency, or generic harness configuration engine.

Keep `agents.py`, `behavior.py`, and their public behavior unchanged. `sync`, skill install/remove, and mode commands never call the Pi handler. Pi apply never installs skills, changes instructions, or modifies existing subagent definitions.

Add `pi/manifest.json` at the checkout root:

```json
{
  "version": 1,
  "packages": [],
  "settings": {},
  "required_env": []
}
```

Default lookup is relative to the installed module's resolved checkout, not the working directory. Each Pi subcommand accepts `--manifest PATH` for an explicit alternative; relative overrides resolve from the caller's working directory. A missing default manifest is an error explaining the editable-checkout requirement, not an empty configuration.

`packages` initially accepts only npm sources with exact semantic versions, including prerelease/build components. Reject ranges, tags, unversioned names, duplicate package names, object-form resource filters, local paths, and git sources. This deliberate first-version restriction avoids inventing path expansion or cross-source identity rules. Adding other Pi-native source kinds is a later compatible feature.

`settings` is a nested JSON object. Flatten nonempty objects into leaf paths; treat arrays, scalar values, and null as indivisible leaves. Reject empty nested objects, duplicate JSON keys, nonfinite numbers, reserved top-level keys (`packages`, `$schema`), and overlapping leaf/container shapes. Arrays are replaced only as explicitly managed leaves; they are not union-merged. No string interpolation, secret resolution, or shell evaluation.

`required_env` contains unique environment-variable names. Doctor reports missing/empty variables by name only. No values are displayed, persisted, or injected. Documentation prohibits literal credentials in the tracked manifest; validation cannot reliably detect every secret-shaped value.

### Ownership and adoption

Store private local metadata at `<agent-dir>/agentic-hub/pi-state.json`, outside Git. Use a schema version and bind the state to the canonical manifest path; refuse a different manifest until the previous manifest's ownership has been released. Relocating a checkout requires an explicit, documented state migration after verifying the old path, not automatic takeover.

For each managed setting leaf record its path, last applied value, original presence/value, and ownership state. For each package record its name, exact source, and whether the hub introduced the declaration or adopted it. Do not persist unrelated settings or credentials in ownership/recovery metadata; fresh in-memory observations may be used for preservation checks.

On first application:

- Absent setting leaves can be created; existing identical leaves can be adopted without rewriting.
- Existing different unowned leaves are conflicts. No force/adopt-overwrite switch in v1: the user must explicitly edit local configuration or change the manifest.
- An identical npm declaration can be adopted. A different version, filtered object entry, or ambiguous declaration of the same package is a conflict, never silently replaced.
- Adoption of an existing identical package claims configuration tracking, not permission to delete that preexisting package later.

On subsequent application:

- Update a managed leaf or package only if the observed value/source still equals the last applied value/source. Divergent local edits are conflicts, even if a different manifest change is also pending.
- A missing owned leaf/declaration can be recreated when still desired.
- When a setting leaves the manifest, restore its original value if originally present, otherwise remove the introduced leaf. Preserve unrelated siblings; prune only empty containers introduced by the hub and recorded as such.
- When a package leaves the manifest, remove it through Pi only if introduced by the hub. Release adopted package ownership without deleting its declaration or installation. An explicitly managed version change to an adopted package is rejected in v1; release it and resolve the declaration manually before introducing a new version.
- Refuse cleanup when the owned value/source has drifted. Never infer ownership from a package being in the current manifest alone.

An empty manifest and no prior state produce no writes and no Pi subprocess. An empty manifest with prior ownership is an explicit release/reconciliation request, subject to these safeguards.

### Read-only planning and CLI contract

Expose:

```text
agentic-hub pi status [--manifest PATH]
agentic-hub pi doctor [--manifest PATH]
agentic-hub pi apply [--manifest PATH] [--dry-run]
```

Status compares declarations and managed settings, not runtime extension loading. Report `in-sync`, `pending`, `conflict`, or `error`, with paths and setting names/package identities, never arbitrary setting values or raw settings/subprocess dumps. Separate planned creation, adoption, update, restoration, removal, and ownership release.

Exit codes: 0 for successful inspection (including ordinary pending changes), dry-run without conflicts, and completed apply; 1 for conflicts, invalid input, inspection/apply failures, interrupted recovery, or failed doctor checks; argparse retains 2 for invalid command syntax. `status` exits 1 on conflicts/errors. Diagnostics go to stderr; status and planned actions go to stdout.

`status` and dry-run never create directories, ownership state, backups, or install packages, and never resolve or launch Pi. Doctor makes no hub-owned configuration or ownership changes and may run only `pi --version`; it does not start an agent session, connect MCP servers, or request package installation. This is not an absolute zero-write guarantee for doctor: upstream startup can create transient settings/installation locks and clean managed-install staging before reporting its version. A temporary HOME or agent root does not isolate maintenance performed in an explicitly selected launcher's installation tree.

Doctor checks manifest/state/settings readability and validity, agent-root layout, Pi executable/version availability, and declared environment-variable presence. Do not promise model authentication, package runtime compatibility, or individual extension readiness.

### Pi process boundary and safe writes

Resolve the launcher with `shutil.which("pi")`, then `~/.pi/agent/bin/pi`; do not derive the installation launcher from a relocated config directory. Use argument-vector subprocess calls, no shell, explicit timeout, and the resolved `PI_CODING_AGENT_DIR` in the child environment.

Run package commands from a neutral temporary working directory without project `.pi` resources and pass the documented `--no-approve` flag. Confirm against Pi 1.4.0 help during the isolated manual smoke test. The initial compatibility contract targets Pi 1.4.0; doctor rejects older versions and reports newer versions as unverified rather than promising compatibility. Package mutations require a version whose settings-persistence contract has been validated; initially only 1.4.0 is eligible. Reject unverified versions before apply creates metadata or makes configuration/package changes; this restriction does not require status, dry-run, or setting-only apply to invoke Pi. npm is required only when package mutations are planned and Pi has no configured alternative `npmCommand`.

Package mutation in v1 is supported only on POSIX platforms with isolated process-group lifecycle control; reject unsupported platforms during preflight, before apply writes. Launch Pi in a new session/process group and keep a bounded deadline covering child output collection as well as process exit. On timeout or handled interruption, terminate the group, escalate to kill after a bounded grace period, reap the direct child, and establish that no ordinary installer descendants remain active before releasing the apply lock or permitting retry. Check for lingering group members before finalizing even a successful command. If shutdown cannot be established, retain the pending journal and lock file, exit 1 with sanitized manual-recovery guidance, and block subsequent apply. This handles ordinary inherited installer children, not deliberately detached or hostile processes; it is not a sandbox guarantee.

For an added package call `pi install <exact-source> --no-approve`. For an introduced package removal call `pi remove <current-source> --no-approve`. Version changes to hub-introduced packages use install with the new exact source and verify that only the desired declaration remains. Do not implement npm caching, package downloads, or automatic version discovery.

Preflight the complete plan before mutating; any known conflict blocks the whole invocation. When the plan contains package subprocesses, including pending-operation install retries, also require the complete observed settings document to be compatible with Pi's version-specific full-file writer. For 1.4.0, reject settings that its `migrateSettings` would change: applicable `queueMode`, `websockets`, legacy object-form `skills`, or `retry.maxDelayMs` migrations. Also reject numbers outside a conservative lossless ECMAScript JSON subset: integers must be within the safe-integer range (±9007199254740991) and noninteger values must be finite binary64 values. Compare JSON values semantically, not formatting or integer-versus-float spelling. Report affected paths and reasons without values; instruct the user to migrate/repair locally and replan. Do not migrate unowned values or persist their originals. These are blockers for planned package subprocesses, not blanket validity restrictions on observed settings. Status and dry-run report known incompatibilities only when such an operation is planned, without launching Pi. Setting-only apply and package adoption/release without a subprocess remain usable with these otherwise valid settings.

Execute package operations sequentially, re-read settings after each, then apply setting changes against a fresh snapshot. Repeat the delegated-write compatibility check on each fresh snapshot before another package subprocess. Preserve all unrelated JSON values and package entries; formatting may normalize when settings are actually changed. Verify both the expected managed post-state and preservation of unrelated values against the in-memory pre-operation snapshot, even after exit 0. Unexpected upstream changes stop execution with a sanitized error and retained pending journal. Persist a manual-repair-required marker with reason/path only; managed pre/post equality alone must not clear it on a later apply. Require explicit local inspection and documented state repair, not a new force command or automatic restoration of unrelated values. Successful earlier operations remain when a later operation fails; stop and report rather than attempting unsafe reverse package operations.

Use an exclusive handler lock only during apply, atomically created in the private metadata directory. Concurrent hub apply fails clearly; no stale-lock auto-deletion. Record the owning PID and, when available, the active package process-group identity in private recovery metadata without command output or environment values. Do not release the lock while installer shutdown is uncertain. After an abrupt hub crash, journal pre/post equality is insufficient to authorize retry: document checking the hub process and installer descendants/group before manual lock removal, including when process metadata is incomplete. PID/group identifiers are investigation aids, not proof against PID reuse or detached processes. Recheck file identity/content before each hub write; atomic replacement is not a cross-process transaction with Pi, so instruct users not to edit settings concurrently.

Reject symbolic-link or multiply hard-linked managed settings/state files, nonregular files, malformed JSON, invalid UTF-8, and unsuitable target roots rather than replacing them. This is narrower than behavior's supported symlink handling and must be documented. Keep state files owner-readable/writable only. Preserve existing settings permissions and atomically replace using a same-directory temporary file with cleanup on failure.

Before each mutation, atomically record a pending operation with its expected pre/post managed values in the ownership file. After verified success, checkpoint ownership and clear the pending operation. On an interrupted/failed operation, status reports recovery required. After any necessary descendant-aware manual lock recovery, a later apply resolves the journal only when observed managed state equals the expected pre-state or post-state, then resumes/retries; an ambiguous state blocks and requires manual correction. The journal does not recover unrelated contents from malformed/truncated files left by Pi's own non-atomic writer; such corruption requires explicit local repair before retry. Never claim that declaration reconciliation proves dependency installation succeeded: retry an interrupted package install through Pi before marking it completed. Do not log raw child output, which can contain sensitive configuration; report sanitized command identity, exit status, and recovery guidance.

## Risks & Mitigations

- Destructive ownership mistakes → per-leaf provenance, explicit adoption rules, conservative conflict detection, and tests for release/restoration.
- Pi mutates the same settings file → version-specific migration/numeric-compatibility preflight, fresh snapshots and unrelated-value postconditions, content checks before hub replacement, and documented concurrency limits. Pi's own writes are not made atomic by the handler; corrupted unrelated contents require explicit local repair, not reconstruction from ownership state.
- Crash between external changes and metadata → durable pending-operation journal, process-group shutdown before lock release, and descendant-aware manual recovery after abrupt crashes; no claim of all-or-nothing package transactions or containment of detached third-party processes.
- Executable code from packages → no packages selected by default, explicit apply, exact pins, no automatic updates, and documentation requiring source review.
- Secrets in configuration → no auth/session management, no value dumps, private state permissions, manifest review guidance. Managed literal values are necessarily recorded locally and in Git; users must not place secrets there.
- Unverified upstream behavior → adapter tests with a fake executable plus one isolated Pi 1.4.0 manual smoke test before trusting real personal configuration.
- Moving the repo or losing metadata → fail closed on owner mismatch; document recovery. With missing state, do not remove resources on the assumption that the hub previously owned them.

## Execution progress

Repository implementation and isolated tests authorized by the user on resume. No real-home apply, live package installation, or installed-launcher invocation authorized.

- [x] Phase 1 — Manifest and portable paths: 42 configuration tests pass; Ruff and pyrefly pass. Inspected `pi/manifest.json`: no packages or preferences selected.
- [x] Phase 2 — Read-only inspection and planning: 80 Pi tests pass; Ruff and pyrefly pass. Temporary-root status/dry-run manually verified to create no files/directories. Doctor subprocess boundary is mocked; no installed launcher invoked.
- [x] Phase 3 — Safe apply and reconciliation: full suite 448 passed; Ruff and pyrefly pass. Temporary-root CLI preview/apply/no-op/release verified from outside the checkout, with launcher resolution explicitly forbidden. Fake executable tests cover package lifecycle, version/platform/npm preflight, partial failures, unrelated-write repair markers, process-group timeout/interruption/escalation and retained uncertain-shutdown locks.
- [ ] Phase 4 — Portability documentation and isolated smoke test
  - [x] Add `docs/pi-handler.md` and update README, preserving the manual subagent example and documenting bootstrap/release/recovery and compatibility limits.
  - [x] Full automated criteria: 448 tests pass; Ruff, pyrefly, `agentic-hub pi --help`, and `git diff --check` pass.
  - [x] Temporary-root setting round trip completed without resolving Pi; baseline manifest remains empty; bootstrap checklist reviewed for credential/path portability.
  - [ ] Installed Pi version/help smoke probe: awaiting separate approval for upstream installation-tree maintenance. No installed launcher has been invoked; real package lifecycle remains explicitly unverified.

### Implementation notes

- Output is discarded to DEVNULL at the package boundary instead of being captured: no child-output secrets are retained and descendants cannot hold collection pipes open. Group quiescence is still checked after direct-child success.
- POSIX group checks use `killpg` plus a bounded system `ps` inspection, excluding zombie-only members that cannot mutate files. Inability to establish shutdown is fail-closed.
- Snapshot comparisons exclude access time (reads can update it) and include inode/content/mode/link count/modification metadata.
- Released containers with unmanaged siblings remain on disk but are no longer tracked after their last managed descendant is released. Missing owned targets can be recreated when desired, but cleanup treats their absence as drift and refuses to silently discard ownership.
- Completed journaled removals need no new subprocess; journaled installs are always retried through Pi. Corrupt pending checkpoints are validated before recovery mutates settings.
- Pi 1.4.0 persistence fixture outputs are source-grounded synthetic transcriptions, not live execution results; provenance and SHA-256 are recorded in the fixture. Real package lifecycle remains unverified.

## Phase 1 — Manifest and portable paths

### Overview

Define validated desired configuration and path resolution independently of any machine mutation.

### Changes

- Add `pi/manifest.json` with the empty version-1 document above.
- Add `src/agentic_hub/pi_handler/__init__.py` without side effects.
- Add `config.py`: `Manifest` and `PiPaths` frozen dataclasses, `load_manifest(path: Path | None = None) -> Manifest`, `resolve_paths(manifest_path: Path) -> PiPaths`, and `flatten_settings(settings: dict) -> dict[tuple[str, ...], object]` with recursive JSON value typing in place of unrestricted `Any`.
- Resolve HOME and `PI_CODING_AGENT_DIR` at invocation time, expanding `~`; empty overrides use the default, relative overrides resolve from the caller's directory.
- Add `tests/test_pi_config.py` using temporary files and homes.

### Tests — write before implementation

Unit tests: `test_empty_manifest_is_valid`, `test_default_manifest_is_independent_of_cwd`, `test_explicit_manifest_resolves_from_cwd`, `test_agent_root_override_resolution`, `test_missing_manifest_is_not_empty_setup`, `test_manifest_rejects_invalid_structure`, `test_packages_require_unique_exact_npm_versions`, and `test_settings_flattening_preserves_arrays_and_null`.

Parameterize invalid input for duplicate keys, unknown schema fields/version, wrong types, nonfinite values, empty nested objects, reserved keys, malformed package names, ranges/tags, and duplicate environment names. No subprocess or real-home access.

### Success criteria

- Automated: `uv run pytest -q tests/test_pi_config.py`; `uv run ruff check .`; `uv run pyrefly check`.
- Manual: inspect the committed manifest and confirm it selects no extensions or preferences.

### What we're NOT doing

No machine writes, template expansion, git/local package sources, automatic adoption, or new CLI command yet.

## Phase 2 — Read-only inspection and planning

### Overview

Produce a deterministic desired-versus-observed plan and expose safe inspection commands.

### Changes

- Add `state.py`: typed `OwnershipState`, `ObservedSettings`, and pending-operation records; `read_settings(paths: PiPaths) -> ObservedSettings` and `read_state(paths: PiPaths) -> OwnershipState`. Missing files yield empty observations without creation; malformed files remain errors.
- Add `planner.py`: typed `Plan` and `Change` records and `build_plan(manifest: Manifest, observed: ObservedSettings, state: OwnershipState) -> Plan`. Include current declaration identity parsing for string npm entries and source-bearing object entries so ambiguous/filter conflicts are detected without claiming support for managing them. For planned package subprocesses, report known Pi 1.4.0 migration/numeric incompatibilities using pure checks; preview never resolves a launcher or verifies the installed version.
- Add `runtime.py`: launcher resolution and bounded version checking for doctor only.
- Add `service.py`: `inspect_setup(manifest_path: Path | None = None) -> Plan` and `doctor(manifest_path: Path | None = None) -> list[Check]`.
- Extend `cli.py` with the required `pi` subparser and `status`, `doctor`, and `apply --dry-run`. Before phase 3, plain `apply` must fail clearly without mutation, explaining that this intermediate release supports preview only.
- Add `tests/test_pi_planner.py` and `tests/test_pi_cli.py`. Add a dedicated `isolated_pi_home` fixture in `tests/conftest.py`, clearing relevant roots/PATH fallback exposure and using fake launchers where needed.

### Tests — write before implementation

Unit planner tests: `test_empty_setup_has_no_changes`, `test_unmanaged_siblings_survive_nested_setting_plan`, `test_unowned_different_value_is_conflict`, `test_equal_existing_values_are_adopted`, `test_owned_drift_blocks_updates_and_cleanup`, `test_release_restores_original_or_removes_introduced_leaf`, `test_only_introduced_empty_containers_are_pruned`, `test_adopted_package_release_preserves_package`, `test_package_identity_conflicts_include_filtered_entries`, and `test_foreign_manifest_state_blocks_takeover`.

Unit doctor tests cover launcher fallback, missing/old/newer Pi versions, missing environment-variable names without values, and malformed state/settings. Assert that doctor makes no handler-owned writes and requests only the version probe; mocking that boundary does not prove upstream startup has no filesystem effects.

CLI integration tests: `test_status_and_dry_run_are_read_only`, `test_status_reports_declared_not_runtime_state`, `test_pi_commands_use_documented_exit_codes`, `test_preview_does_not_resolve_or_run_pi`, and `test_diagnostics_never_print_settings_values`. Snapshot the isolated filesystem to establish no status/dry-run side effects. Add planner tests for package-write incompatibilities and their absence on setting-only/adoption/release-without-subprocess plans. Use real parser/service/planner with temporary files; mock only the version subprocess boundary.

### Success criteria

- Automated: `uv run pytest -q tests/test_pi_config.py tests/test_pi_planner.py tests/test_pi_cli.py`; `uv run ruff check .`; `uv run pyrefly check`.
- Manual: run status and dry-run against a temporary agent directory and verify meaningful paths/actions with no created files.

### What we're NOT doing

No package installation, settings/state writing, TUI work, model authentication checks, or output-format framework.

## Phase 3 — Safe apply and reconciliation

### Overview

Implement explicit application with tracked ownership and recoverable partial progress, delegating package lifecycle to Pi.

### Changes

- Extend `state.py` with `acquire_lock(paths: PiPaths)`, atomic JSON writes, snapshot comparison, and ownership/journal checkpoint helpers. Keep these internal to the handler rather than importing private behavior helpers.
- Extend `runtime.py` with `PiRuntime.install(source: str) -> None` and `PiRuntime.remove(source: str) -> None`, launcher/environment/cwd isolation, version validation, POSIX process-group lifecycle control, bounded shutdown/output collection, and sanitized errors. Keep the service informed of active process identity and shutdown certainty so it owns lock/journal finalization.
- Extend `service.py` with `apply_setup(manifest_path: Path | None = None) -> ApplyResult`: validate/preflight (including package-write compatibility, eligible version, and supported platform when subprocesses are planned), acquire lock, replan, journal each operation, execute, verify managed and unrelated-value postconditions, checkpoint, and return observed outcomes. Replan after taking the lock to avoid acting on a stale preview. Release the lock only after installer shutdown is established; retain it and the pending journal when shutdown is uncertain.
- Wire plain `pi apply` in `cli.py`; keep dry-run on the read-only planning path. A no-op must not create metadata or invoke Pi.
- Add `tests/test_pi_apply.py` and `tests/test_pi_runtime.py`. Runtime tests use a fake executable script rather than network calls.

### Tests — write before implementation

Unit apply tests: `test_apply_empty_setup_has_no_side_effects`, `test_apply_is_idempotent`, `test_conflict_preflight_prevents_all_mutations`, `test_settings_apply_preserves_unmanaged_values`, `test_adopt_and_release_restore_original_presence`, `test_removal_preserves_unmanaged_siblings_and_packages`, `test_managed_local_edits_require_manual_resolution`, `test_existing_permissions_are_preserved`, `test_state_is_private`, and `test_unsafe_file_layout_is_rejected`.

Failure/recovery tests: `test_concurrent_apply_is_rejected`, `test_changed_snapshot_is_not_overwritten`, `test_atomic_write_failure_preserves_original`, `test_package_failure_stops_after_checkpointed_success`, `test_success_exit_requires_expected_declaration`, `test_pending_settings_write_recovers_from_pre_or_post_state`, `test_pending_package_install_is_retried_before_completion`, `test_ambiguous_pending_state_blocks_recovery`, and `test_missing_state_never_authorizes_removal`.

Adapter integration tests: `test_install_uses_exact_argument_vector_and_neutral_cwd`, `test_remove_uses_observed_owned_source`, `test_child_receives_resolved_agent_root`, `test_timeout_and_child_failure_are_sanitized`, and `test_version_change_preserves_unmanaged_package_entries`. Fake Pi mutates a temporary settings file to exercise the actual re-read/write/checkpoint path; no real npm or network.

Add version-grounded persistence contract fixtures with synthetic inputs, Pi 1.4.0 outputs, and upstream version/source provenance. Cover all four settings migrations, safe-integer boundaries and a precision-losing integer, and unaffected nested settings/package entries. Derive fixtures from the inspected upstream persistence behavior, not from the handler's own serializer; the default suite must not require a local Pi/Node installation. Test that package-write incompatibilities, unverified Pi versions, and unsupported process-control platforms block the entire apply before writes/subprocess mutation; setting-only and no-subprocess adoption/release remain usable. Include a fake-runtime mode that unexpectedly changes unrelated settings and verify that postcondition failure stops execution, retains a manual-repair marker, and blocks a subsequent apply even when managed values match the expected post-state.

Extend the fake executable to spawn an ordinary delayed-writing child and, separately, a child retaining output pipes. Add `test_timeout_stops_installer_group_before_unlock`, `test_interruption_stops_installer_group_before_retry`, `test_output_collection_respects_deadline`, and `test_uncertain_shutdown_retains_lock_and_journal`. Exercise graceful termination and forced escalation, assert no delayed descendant mutation after confirmed shutdown, and assert retry is blocked while shutdown remains uncertain. Skip actual process-group execution tests only on unsupported platforms; test their fail-closed preflight with a simulated platform.

Extend existing CLI tests with one isolated apply/status/release round trip using a synthetic manifest and fake runtime. Assert unrelated skill/mode commands never call the handler; do not duplicate planner edge cases at CLI level.

### Success criteria

- Automated: `uv run pytest -q`; `uv run ruff check .`; `uv run pyrefly check`.
- Manual: apply a synthetic nonsecret setting to a temporary agent directory, repeat and observe no-op, empty the synthetic manifest, and verify restoration without touching real personal settings.

### What we're NOT doing

No force overwrite, automatic adoption of different values, global rollback of package effects, manual npm installation, automatic updates, resource filters, managed extension-specific files, or stale-lock auto-repair.

## Phase 4 — Portability documentation and isolated smoke test

### Overview

Document the complete lifecycle and verify upstream command assumptions without selecting an extension for the shared baseline.

### Changes

- Add `docs/pi-handler.md` covering manifest schema, exact ownership rules, exit codes, doctor's upstream lock/maintenance exception, version-specific delegated-write restrictions, POSIX-only package mutation, launcher lookup, concurrency, secret exclusions, checkout relocation, and partial-failure recovery. Explain process-group shutdown, retained locks on uncertain shutdown, descendant-aware manual crash recovery, and the limits for detached processes and Pi-written file corruption.
- Update `README.md` with the Pi command group, empty-by-default behavior, editable-checkout requirement, and link to the detailed guide. Retain the existing manual subagent example and clarify that it is not automatically managed or migrated.
- Document second-machine bootstrap: install prerequisites/Pi separately, clone the same revision, run `uv tool install --editable .`, doctor, dry-run, and explicit apply; authenticate locally outside the repo.
- Document release: remove managed entries from the same manifest and apply before uninstalling the handler. If state is missing/corrupt, inspect and repair explicitly; do not reconstruct destructive ownership from current settings.
- Document a manual smoke-test procedure using a temporary HOME/agent directory and explicit installed launcher. Before any version/help invocation, disclose that upstream installation maintenance is outside that temporary-root isolation; use a separate disposable Pi installation if complete filesystem isolation is required. Use a temporary synthetic manifest with a nonsecret setting for the mandatory test. Package lifecycle testing is optional and requires a separately reviewed disposable package, never an addition to the committed baseline.
- Record smoke-test observations in `docs/pi-handler.md`, including actual tested Pi version and whether real package lifecycle was exercised. If not exercised, mark it unverified rather than suggesting that fake-runtime tests prove runtime compatibility.

### Tests — write before implementation

Reuse the CLI round-trip from phase 3; add only `test_pi_help_documents_subcommands_and_manifest_override` if the documentation exposes parser details not already checked. No new test harness and no live-provider tests.

### Success criteria

- Automated: `uv run pytest -q`; `uv run ruff check .`; `uv run pyrefly check`; `uv run agentic-hub pi --help`.
- Manual: complete the isolated setting round trip; verify installed Pi help accepts the adapter's package flags without executing a package install; confirm the repository's default manifest remains empty. Read bootstrap instructions as a second-machine checklist and confirm none require copying credentials or hardcoded checkout paths.

### What we're NOT doing

No specific extension recommendation becomes a dependency. No real-home apply, package smoke test, or credential inspection without separate user approval. No Pi TUI page, multiple named profiles, background synchronization, Pi binary installer, or workbench-kernel implementation.

## Delivery and rollback

Land phases in order; each phase includes its tests. Phase 2's read-only intermediate CLI is explicitly guarded, not a partially functional mutator. Phase 3 is the first release that may change local Pi state.

The repository starts with zero selected packages/settings, so updating agentic-hub alone changes no personal Pi configuration. Applying is always explicit. For later configured machines, release owned entries and verify status before removing/downgrading the application. Package installation can have third-party side effects outside settings; handler release does not promise to undo those effects.

## Nonblocking assumptions and validation

- Editable checkout distribution is acceptable for this personal tool. Validate the documented bootstrap from another working directory; standalone wheel asset distribution is deferred.
- Exact npm pins cover the initial curation need. Validate by using a synthetic scoped/unscoped source in parser tests; add other source kinds only with a concrete use case and identity tests.
- Settings and ownership are the observable configuration contract. Validate any extension's runtime behavior separately when that extension is adopted.
- Pi-native package commands preserve unrelated declarations only within the validated settings-persistence subset and supported runtime/version boundary. Validate migration/numeric restrictions using version-grounded contract fixtures, failure handling with the fake-executable suite, and, before first real package adoption, an isolated real-package lifecycle trial. New Pi versions require explicit persistence-contract validation before enabling package mutation; fake-runtime tests alone do not establish upstream compatibility.
