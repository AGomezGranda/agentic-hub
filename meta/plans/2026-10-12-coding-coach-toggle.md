---
date: 2026-10-12
title: Persistent coding coach toggle in the CLI and TUI
status: in-progress
---

# Persistent coding coach toggle

## Objective

Add a personal coding-coach mode that starts off, can be enabled quickly in
the CLI or TUI, and remains enabled across subsequent chats until disabled.
The coach helps the user implement an objective, reviews their attempts, and
teaches relevant engineering principles without writing or revealing the
implementation. Support Claude Code, OpenCode, Pi, and Codex using one shared
instruction document.

This is an instruction profile, not an installed skill. The hub writes its
coaching instructions into the global instruction files that the harnesses
already load. The activation contract is **restart the harness and start a
new chat**; toggling cannot reliably change context in an existing process.

## Current state

- [catalog.py:6](/Users/alvarogomez/code/python/agentic-hub/src/agentic_hub/catalog.py:6)
  locates the skill source directory; `discover_skills()` only discovers
  directories containing `SKILL.md`. There is no profile catalog or toggle.
- [agents.py:16](/Users/alvarogomez/code/python/agentic-hub/src/agentic_hub/agents.py:16)
  defines the four supported hosts. `install_one()` and `remove_one()` manage
  skill directories, links, and generated skill files; they do not manage
  global instructions. Reuse the host names, not those skill-specific writers.
- [cli.py:105](/Users/alvarogomez/code/python/agentic-hub/src/agentic_hub/cli.py:105)
  builds the argparse commands. Bare invocation opens the TUI. Existing
  install/remove/sync commands should retain their current meaning.
- [tui.py:101](/Users/alvarogomez/code/python/agentic-hub/src/agentic_hub/tui.py:101)
  composes the header, filter, statistics, skill grid, preview, and footer.
  `refresh_grid()` rebuilds the skills, and `action_refresh()` provides the
  existing explicit refresh action. Theme persistence is independent.
- [tests/test_cli.py:15](/Users/alvarogomez/code/python/agentic-hub/tests/test_cli.py:15)
  and [tests/test_tui.py:20](/Users/alvarogomez/code/python/agentic-hub/tests/test_tui.py:20)
  already isolate filesystem targets with pytest's `tmp_path` and monkeypatch.
  TUI tests use Textual's `run_test()` and pilot keyboard actions.
- [pyproject.toml:22](/Users/alvarogomez/code/python/agentic-hub/pyproject.toml:22)
  configures pytest. Textual and development checks are already available;
  this feature needs no additional dependency.

The working tree already contains an unrelated untracked `skills/clear-doc/`
directory. Leave it untouched.

## Design decisions

### One profile, one controller, existing host names

Add `src/agentic_hub/profiles/coding-coach.md` as the single authored source,
and `src/agentic_hub/coach.py` for target resolution, owned-block updates, and
status inspection. Keep the resource inside the package so a built install
can read it without depending on the repository checkout. Do not create a
general profile registry, adapter class hierarchy, or plugin mechanism.

Both frontends call `coach.inspect()` and `coach.set_enabled(enabled)`.
Each returns a dictionary keyed by the existing `agents.AGENTS` names. Use a
small `CoachStatus` dataclass with `state`, `path`, and optional `detail`:
`state` is `off`, `on`, `stale`, or `error`; `path` is the selected instruction
path, or `None` when resolution fails. Detail carries actionable error or
drift information, never the full contents of personal instruction files.

Version one applies a change to all four hosts in the current user's local
environment, matching the hub's existing all-host default. There is no
per-project or per-host coaching switch. Shared fallback files make separate
host switches misleading, and the requested control is global.

### Persist through the instruction files themselves

Do not add a separate saved boolean. An owned coaching block is the saved
state. A new CLI process or TUI instance inspects the files again; it cannot
mistake a failed write for successful activation.

- `off`: no owned block in the effective file and no unclaimed owned blocks
  in shadowed candidates.
- `on`: the effective file contains the current profile, and there are no
  unclaimed owned blocks in shadowed candidates.
- `stale`: the effective owned block is older/edited, or an unclaimed owned
  block exists in a shadowed candidate. Report whether coaching remains in
  the effective file.
- `error`: resolution, reading, marker validation, or a requested update
  failed. Do not convert unreadable files into `off`.

Resolve all hosts before classifying shared blocks. A shadowed block is
unclaimed when its physical path is not an effective target for any
successfully resolved host. A block selected by another host does not affect
this host's `off`/`on`/`stale` state; report its profile drift for the hosts
that actively select it. Reading and marker-validation errors still affect
every host whose candidate set contains that path. If resolution is incomplete,
describe unclaimed blocks as potentially leftover; that uncertainty does not
authorize cleanup.

The combined display is `OFF` only when every host is off, `ON` only when all
are on, `ERROR` if any host has an error, and `MIXED` otherwise. Always show
the per-host states. These labels describe the hub's installed instructions,
not proof that a running model loaded or obeyed them.

`on` also refreshes stale instructions. `off` requires no access to the profile
source, so removal still works if that resource is missing. Skill `sync`
neither enables coaching nor refreshes it implicitly.

### Use the instruction file already selected by the harness

Resolve all targets before writing and deduplicate shared physical paths.
Compute the union of effective targets across hosts; a path may be effective
for one host while shadowed for another. Use that same union for status and
enable cleanup, without adding per-host markers or a saved boolean.
Do not introduce a higher-priority file that hides existing instructions.

| Host | Resolution for this implementation | Evidence |
|---|---|---|
| Claude Code | `CLAUDE.md` under `CLAUDE_CONFIG_DIR`, otherwise `~/.claude`. Create it if absent. | [User instruction scope](https://code.claude.com/docs/en/memory), [alternate root](https://code.claude.com/docs/en/claude-directory) |
| Codex | Under `CODEX_HOME`, otherwise `~/.codex`, select the first nonempty `AGENTS.override.md` or `AGENTS.md`. If neither supplies instructions, use `AGENTS.md`; never create an override merely to enable coaching. | [Discovery and precedence](https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| Pi | Under `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`, select the first existing readable regular file in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Empty files count. If none exists, use `AGENTS.md`. | [Configuration](https://pi.dev/docs/latest/configuration), [loader source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts#L172) |
| OpenCode | Use existing `~/.config/opencode/AGENTS.md`; otherwise use existing `~/.claude/CLAUDE.md` if Claude compatibility is enabled. If neither exists, create native `AGENTS.md`. Respect `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` when set to `1` or `true`. | [Global rules and fallback](https://opencode.ai/docs/rules/) |

For safety, an unreadable or unsuitable higher-priority candidate is an error
for the hub, rather than a reason to create a replacement and silently alter
the user's setup. Resolve documented environment roots at call time. Empty
root values use defaults; relative nonempty roots resolve against the hub's
working directory and expand `~`. Include selected paths in CLI status.

OpenCode's custom-directory precedence and interaction with a relocated Claude
directory were not established by the available official sources. Version one
supports its documented default layout: if `OPENCODE_CONFIG_DIR` is nonempty,
`XDG_CONFIG_HOME` points somewhere other than `~/.config`, or OpenCode would
need the Claude fallback while `CLAUDE_CONFIG_DIR` is relocated, report an
explicit unsupported-layout error for OpenCode before changing its candidates.
Other hosts may still be updated. Do not guess at alternate OpenCode roots or
edit its JSON/JSONC config. Extending that scope requires a source or installed
version check and a resolver test, not another user preference decision.

Environment support covers the environment visible to the hub. A harness
started elsewhere with different roots or context-disabling flags is outside
that activation claim. Display this boundary in the README.

### Own a marked section, preserve everything around it

Use explicit `agentic-hub: coding-coach begin` and `... end` HTML-comment
markers. The opening marker records whether the hub created the file.
The profile text is embedded, rather than referenced through `@file`, whose
automatic expansion is not shared by all four harnesses.

1. Read the original bytes and validate UTF-8 before mutation. Parse only the
   hub's exact markers. No markers is ordinary user text; a missing, reversed,
   duplicate, or malformed marker pair is an error and must not be repaired
   by guessing. Treat an existing owned body edited by the user as stale;
   `on` replaces that owned body from the canonical profile.
2. Include the separator bytes added by the hub in its owned span. Specify the
   framing once in the parser/writer so `on` followed by `off` restores an
   existing file byte-for-byte, including CRLF and no final newline. Preserve
   all other bytes, including user edits added before or after the section.
3. Preserve the original created-file flag when updating an existing block.
   On removal, delete a file only if the marker says the hub created it and
   removing the owned span leaves no bytes, and it is not reached through a
   user symlink. Keep an emptied symlink target to avoid leaving a dangling
   link. Preserve preexisting empty files;
   preserve any new user content in hub-created files. Leave parent directories.
4. Follow an existing symlink to a regular file while leaving the symlink
   intact; resolve and deduplicate shared targets. Reject dangling links,
   loops, non-regular targets, and multiply hard-linked targets. Deduplicate
   case aliases by filesystem identity where files exist, so Pi's `AGENTS.md`
   and `AGENTS.MD` are not treated as two files on a case-insensitive filesystem.
5. Prepare updates in a temporary sibling, preserve existing permission bits,
   then use atomic replacement. Recheck the original bytes and target identity
   before replacing or deleting; if they changed, report a conflict. Clean up
   temporary files after errors. This protects ordinary interruption and
   detectable concurrent edits; it is not a cross-process transaction system.
6. On disable, inspect all known candidates in the configured roots, not just
   the currently effective file, and remove valid owned blocks. This prevents
   an old block from reappearing when an override is later removed. Validate
   a host's candidate set before modifying it. On enable, put the current
   profile in each effective physical target once. Remove shadowed owned
   blocks only outside the union of effective targets. For example, retain
   Claude's block when OpenCode selects its native `AGENTS.md`; Claude's
   active file is then OpenCode's shadowed fallback, not an unclaimed block.
   Apply the same rule to cross-host symlinks and other aliases.
7. If any host's candidate set cannot be fully resolved and validated, skip
   all shadowed-block cleanup during that enable operation. Still update
   independently validated effective targets; preserve candidate errors and
   report deferred cleanup wherever an unclaimed block remains. Such a block
   keeps that host stale, so an unmet requested postcondition cannot report
   success. An unreadable or unresolved host must not make a shared block
   eligible for removal. Retry after resolving the error; explicit disable
   still removes valid blocks from fully validated candidate sets.
8. Deduplicate all shared files before mutation, including OpenCode/Claude.
   A write failure affecting a shared path is reported for every host whose
   candidate set contains that path. Attempt independent targets, then reread
   actual state and retain operation errors. There is no all-host rollback:
   report partial success and allow retry or `off`.

### Coaching contract

The shared Markdown must state the following without harness names or commands:

- Coach the current coding objective. Establish the user's starting knowledge
  only where needed, and agree on observable completion criteria.
- Inspect relevant code and conventions. Give a short roadmap, then one
  manageable next step with an observable result; wait for the user's attempt.
- Do not write/edit files, apply patches, supply implementation code, provide
  replacement snippets, or delegate implementation. Avoid pseudocode that
  gives away the solution. File/symbol references and prose are allowed.
- Explain concepts directly when knowledge is missing. Increase hint
  specificity when the user is stuck; do not force every response into a quiz.
- Review the user's actual changes before moving on. Prioritize correctness,
  error handling, boundaries, readability, and meaningful tests; explain the
  concrete consequence behind a principle or pattern. Distinguish defects
  from preferences and acknowledge sound decisions.
- Guide the user to run checks and interpret their results. Do not execute
  tests, formatters, builds, installs, or other potentially writing commands
  on their behalf. Reading/searching code or inspecting a diff is allowed.
- Preserve the objective across turns. A request such as "help me fix this"
  does not silently switch to implementation. Never alter the persistent
  toggle from inside the coaching conversation. An explicit request to leave
  coaching may change that chat, but cannot claim to change future chats;
  persistent changes belong to the hub's CLI/TUI.
- Apply coaching to coding work; answer unrelated questions normally. Do not
  add progress files, learner databases, mandatory design patterns, or skill
  dependencies. Completion means the user implements and verifies the result.

This contract guides behavior; it does not enforce tool permissions or take
precedence over higher-priority harness instructions. Conflicting project
instructions, excluded user files, and context limits require live checks.

## Implementation phases

- [x] Phase 1 — Shared profile and persistent activation.
- [x] Phase 2 — CLI and operating instructions.
- [ ] Phase 3 — TUI control and cross-harness acceptance.

### Phase 1 — Shared profile and persistent activation

**Overview:** Implement safe instruction-file management with truthful status,
independent of both frontends.

**Changes**

- Add the profile at `src/agentic_hub/profiles/coding-coach.md` with the contract
  above. Locate it relative to `coach.py`; do not change skill discovery.
- Add `coach.py` with `CoachStatus`, `instruction_candidates(agent)`,
  `inspect()`, and `set_enabled(enabled)`. Keep private resolution, block
  parsing, and file-writing helpers in that module. `instruction_candidates`
  returns ordered `Path` candidates; host-specific selection rules remain
  explicit rather than hidden in a generic priority framework.
- Use `agents.AGENTS` for the supported host keys. Leave its skill paths and
  installation modes unchanged. Unknown test/custom host keys yield an
  explicit unsupported-host result unless the resolver is replaced by a fixture.
- Add `tests/test_coach.py`. Isolate home paths, environment variables, and
  the profile resource under `tmp_path`; never touch real global instructions.

**Tests first**

Write one focused failing test at a time, implement its smallest complete
behavior, and rerun. Parameterize data cases instead of duplicating scenarios:

- `test_default_off_is_read_only`: no files/directories created by inspection
  or by disabling an untouched installation.
- `test_resolves_effective_global_instruction_file`: table-driven host roots,
  precedence, empty-file behavior, Pi aliases, and OpenCode compatibility flags.
- `test_unsupported_opencode_layout_is_reported_without_guessing`.
- `test_toggle_round_trip_preserves_user_bytes`: missing file, preexisting
  empty file, LF/CRLF, no final newline, and later user text outside the block.
- `test_repeated_enable_is_idempotent_and_refreshes_stale_profile`.
- `test_disable_removes_shadowed_blocks_without_profile_source`.
- `test_shared_claude_opencode_target_is_updated_once`: preserve fallback
  behavior and associate a shared failure with both hosts.
- `test_native_opencode_preserves_claude_coaching`: with both native OpenCode
  and Claude instruction files present, repeated enable writes the current
  profile to both, reports all hosts on without shadowed drift, and disable
  removes both blocks while preserving user bytes. If only Claude's block
  remains after a partial failure, a fresh inspection reports OpenCode off
  rather than stale merely because its fallback is coached; the mutation
  result still retains OpenCode's operation error. Editing Claude's owned
  body makes Claude stale while OpenCode stays on if its native block is
  current.
- `test_symlink_target_and_case_aliases_preserve_identity`: valid links remain
  links, aliases are handled once, and invalid targets are left untouched.
  Include Pi's effective file linked to Codex's shadowed base while Codex
  selects an override: enable preserves both effective blocks, status reports
  both hosts on, and disable removes the blocks once while keeping the link.
- `test_malformed_markers_and_invalid_utf8_are_not_overwritten`.
- `test_failed_or_conflicting_write_preserves_original`: inject failure before
  replacement and a detectable concurrent edit; verify cleanup and mode bits.
- `test_partial_failure_keeps_independent_success_and_reports_actual_state`:
  also inject a candidate-resolution/validation failure; independent effective
  targets still enable, all shadowed cleanup is deferred, and retained
  unclaimed blocks stay stale with actionable detail. Retry after fixing the
  error removes only unclaimed blocks and reaches all-on; explicit disable
  still clears valid blocks in independently validated candidate sets.

These are unit tests using real temporary files and injected failure points.
Do not add a second test layer that repeats the same parser assertions.

**Success criteria**

- [x] Automated: `uv run pytest -q tests/test_coach.py tests/test_agents.py tests/test_catalog.py`.
- [x] Automated: build with `uv build --wheel --out-dir /tmp/agentic-hub-coach-dist`
  and inspect the wheel with standard-library `zipfile` to confirm the profile
  resource is included. If uv_build excludes it, add only the necessary package
  include setting in `pyproject.toml` and repeat the packaging check.
- [x] Manual: inspect an isolated before/on/off sample; original instruction text
  survives and no new higher-priority file hides an existing fallback.

**Phase 1 completion — 2026-10-12**

- Added the packaged profile, controller, and temporary-home tests. No frontend,
  skill-installation, dependency, or live instruction-file changes.
- Phase checks: 90 tests passed. Full regression suite: 150 tests passed.
  `ruff check src tests` and `pyrefly check` passed; both new Python files pass
  `ruff format --check`.
- Repository-wide formatting has one preexisting failure in unchanged
  `tests/test_skills.py:335`; left untouched.
- Built the wheel and verified `agentic_hub/profiles/coding-coach.md` using
  `zipfile`; no packaging configuration change was needed.
- Inspected a temporary-home before/on/off sample with CRLF and no final
  newline. All hosts reached on/off, OpenCode retained its existing Claude
  fallback, and the original bytes were restored exactly.
- Pi alias tests compare filesystem identity because this filesystem is
  case-insensitive. Owned framing is two leading LF bytes, the opening marker
  with `created=0` or `created=1`, LF, the exact profile bytes, LF, the closing
  marker, and one trailing LF. Those framing bytes are removed with the block.
- Failure checks cover shared targets, invalid candidates, deferred cleanup,
  byte/identity/symlink conflicts, deletion conflicts, permission bits, and
  temporary-file cleanup. Multiple errors for a host are retained together.

**Not doing:** skill installation changes, global permission changes, new
dependencies, profile frameworks, or changes to live user configuration in tests.

### Phase 2 — CLI and operating instructions

**Overview:** Expose persistent on/off/status actions with clear failure output.

**Changes**

- In `cli.py`, add `cmd_coach()` and an argparse `coach` subcommand with a
  required `on`, `off`, or `status` action. All four hosts are targeted; no
  per-host filter in this version.
- `status` calls `coach.inspect()`. Mutations call `coach.set_enabled()`.
  Print the combined state and one row per host, including path and detail.
  Keep diagnostics on stderr and status data on stdout, following existing CLI
  conventions. Never print personal instruction content.
- Return exit status 1 for operation errors or failed requested postconditions;
  return 0 when the requested on/off state is reached for every host. An ordinary
  `status` result may be mixed/stale and still exit 0; inspection errors exit 1.
  Missing/invalid argparse actions retain argparse's exit status 2.
- Mutation output says to restart the harness and start a new chat. Idempotent
  operations succeed. Do not change existing commands' exit-status behavior.
- Update `README.md` with the three commands, global scope, source location,
  paths/fallbacks, environment limits, state meanings, restart requirement,
  recovery by retry/off, and the distinction between guidance and enforced
  permissions. Explain that a shadowed block required by another host is
  retained and does not count as stale; profile edits require running
  `coach on` again.

**Tests first**

Add CLI tests for default status without writes, enable/status/disable across
separate `cli.main()` calls, idempotence, a partial failure with named hosts
and nonzero exit, invalid actions, and profile removal with missing source.
Use `tests/test_coach.py` fixtures/helpers where useful. Keep existing skill
CLI tests as regression coverage; add one assertion that `sync` does not
activate coaching. Use existing native OpenCode and Claude files in the
on/status/off lifecycle case: assert all-on output, exit status 0, retained
blocks after enable, and all-off after disable.

**Success criteria**

- [x] Automated: `uv run pytest -q tests/test_coach.py tests/test_cli.py`.
- [x] Manual: in an isolated home, invoke `agentic-hub coach on`, start a separate
  CLI process for `agentic-hub coach status`, then run `agentic-hub coach off`.
  Inspect files and exit codes; ensure stderr explains a deliberately failed
  target while successful targets retain their actual state.

**Phase 2 completion — 2026-10-12**

- Added `coach on|off|status`, combined/per-host states and paths on stdout,
  named diagnostics on stderr, mutation restart guidance, and exit status 1
  for errors or unmet requested states. Existing command exit behavior stays
  unchanged; missing/invalid actions use argparse's exit status 2.
- Covered read-only default status, repeated on/status/off calls with native
  OpenCode and Claude files, idempotence, partial failures, stale/mixed status,
  unmet mutation postconditions, invalid actions, missing-source removal, and
  skill sync independence. Moved the existing temporary-home/profile fixture
  to `tests/conftest.py` for reuse by controller and CLI tests; controller
  behavior and TUI remain unchanged.
- Phase checks: 82 tests passed. Full regression suite: 163 tests passed.
  `ruff check src tests` and `pyrefly check` passed. All changed Python files
  pass formatting; repository-wide formatting still reports only the known
  preexisting failure in unchanged `tests/test_skills.py:335`.
- Invoked the actual CLI executable in separate processes under a temporary
  home: on/status/off returned 0, preserved the Claude fallback, and restored
  CRLF/no-final-newline user bytes. A deliberately invalid Codex target
  returned 1 with its diagnostic on stderr while the other hosts stayed on;
  disable cleared independent hosts and status returned all-off after the
  invalid candidate was removed. No live instruction files were changed.
- README now documents commands, scope, resolution/environment limits, state
  meanings, refresh/restart requirements, recovery, and instruction-only
  behavior. Phase 3 and live harness acceptance remain pending.

**Not doing:** a daemon, launcher wrappers, live-process control, machine sync,
per-project/per-host toggles, or a JSON output interface.

### Phase 3 — TUI control and cross-harness acceptance

**Overview:** Add a persistent visible control outside the skill grid and use
the same controller as the CLI.

**Progress**

- [x] TUI status, buttons, keyboard actions, refresh, and error recovery.
- [x] Isolated headless tests and README usage/keybindings.
- [x] Automated checks (known preexisting formatting failure excluded).
- [x] Normal/narrow rendered-terminal checks and keyboard/mouse interactions.
- [ ] Per-harness runtime acceptance; record results below before completing phase 3.

**Changes**

- In `AgenticHubApp.compose()`, add a compact coach area below the header and
  above the skill filter: a `Static` status summary plus ordinary Textual
  `Button` controls for **Enable all** and **Disable all**. Show the combined
  state, all four host states, and the restart/new-chat note. Allow text to
  wrap; keep keyboard focus and labels accessible.
- Add `c` for `action_toggle_coach`: if all hosts are on, disable; otherwise
  enable/refresh all. Add `C` for `action_disable_coach`, which is always an
  explicit off action, including mixed/error states. Mouse buttons use those
  same enable/disable paths. Do not let these bindings intercept typing in the
  existing filter input.
- Add `refresh_coach()` and a small shared `_set_coach(enabled)` action helper.
  Read status on mount, after coach actions, and on `ctrl+r`. Keep ordinary
  skill navigation/filtering free of repeated global-instruction I/O. Disable
  buttons while a mutation is running to avoid overlapping operations.
- Show per-host failure details in the coach area and a warning/error
  notification; keep the TUI usable after an exception. No success toast may
  report all hosts enabled when a write failed. Do not derive status from a
  local widget boolean.
- Coach controls work with zero skills, an empty filtered grid, or skill
  selections. Skill install/remove actions never change coaching state.
- Update `tests/test_tui.py:setup_fixture` to isolate the coach controller's
  targets as well as the theme and skill paths. Every existing TUI test must
  remain isolated from the real home directory. Extend README usage/keybindings.

**Tests first**

Add headless Textual tests for visible default-off controls with no skills,
`c` on/off persistence after remount, enable/disable buttons, mixed-state
enable repair and explicit `C` disable, partial-error rendering, `ctrl+r`
reflecting a CLI change, and typing `c` into the filter without activation.
Verify skill selection and install/remove behavior still work with the coach
area present. Include native OpenCode plus Claude files in one persistence
scenario: both blocks survive enable/remount, the combined state is ON, and
explicit disable reaches OFF. Reuse existing `run_test()`/pilot patterns.

**Success criteria**

- [x] Automated: `uv run pytest -q`; `uv run ruff check src tests`;
  `uv run ruff format --check src tests`; `uv run pyrefly check`.
  Establish any preexisting failures before implementation and report them
  separately; do not repair unrelated files as part of this feature.
- [x] Manual: check a normal and narrow terminal, keyboard-only navigation,
  button clicks, empty/filter states, and a failed target. Close and reopen the
  TUI, and alternate CLI/TUI actions to confirm the same observed state.
- [ ] Manual, per harness: record the installed version and run the acceptance
  exercise below after enabling and again after disabling. OpenCode requires
  a machine where it is installed; do not substitute a filesystem-only test
  for its runtime check or claim it passed before it runs.

**Not doing:** a TUI redesign, additional screens, a skill picker entry for
coaching, automatic polling, or a new automated model-evaluation framework.

**Phase 3 implementation and verification — 2026-10-12**

- Added the persistent coach summary, all-host buttons, `c`/`C`, and explicit
  refresh. Mutations run off the UI thread, disable both buttons, and reject
  overlapping actions. Status comes from the shared controller, including its
  retained operation errors; unexpected exceptions leave the app usable.
- Reused the temporary-home fixture for every TUI test and isolated fake-host
  instruction paths in `setup_fixture`. Added coverage for empty skills and
  filters, typing shortcuts as filter text, native OpenCode/Claude persistence,
  CLI refresh, mixed/stale repair, explicit disable, failures, retries, busy
  controls, focus, and skill-operation independence.
- Baseline: 163 tests passed. Final suite: 175 tests passed; lint and type
  checks passed. Changed Python files pass formatting. Repository-wide
  formatting still reports only the preexisting `tests/test_skills.py:335`
  failure; that file remains untouched.
- Inspected rendered terminal output at 120×30 and 40×24 with normal and failed
  targets; exercised keyboard/mouse controls with Textual's pilot. A 40×16
  regression check exposed long errors hiding the controls: the summary now
  scrolls within 40% of the screen. Disabled buttons restore their former focus
  only when the user has not focused another control during the write.
- README now documents the buttons, shortcuts, and shared CLI/TUI refresh.
  No dependency, controller, profile, or live instruction-file changes were
  needed for this phase. Existing work from phases 1/2 and unrelated files was
  preserved.
- Runtime checks use separate disposable repositories and homes, the packaged
  profile, and only the authentication needed by each installed harness.
  CLI enable and TUI disable exercise both frontends. Runtime results are
  recorded below; phase 3 stays open until all four harnesses are checked.

**Runtime acceptance — 2026-10-12**

| Host | Installed version | Observed instruction path (under isolated home) | Result |
|---|---|---|---|
| Codex | `codex-cli 0.162.1` | `.codex/AGENTS.md` | Passed the complete smoke exercise. |
| OpenCode | `1.18.35` (`github-copilot/gpt-6.1-sol`) | `.config/opencode/AGENTS.md` | Passed the complete smoke exercise. |
| Claude Code | No `claude` executable on PATH | Not observed at runtime | Not run; requires an installed/authenticated runtime. |
| Pi | No `pi` executable on PATH | Not observed at runtime | Not run; requires an installed/authenticated runtime. |

Both installed harnesses inspected the sample, gave a roadmap and next step, supplied a prose
hint, reviewed the deliberately flawed edit with concrete consequences, and
declined to format/fix while coached. A separate fresh process kept coaching
without reactivation. Source/diff checks found no agent edits during coached
turns, and the tool transcript contained no tests or other writing commands.
After TUI disable, original instructions were restored byte-for-byte; fresh
chats implemented the fix and ran the existing test function directly (pytest
was unavailable in the disposable runtimes). No coaching bypass was observed.

Network-restricted attempts were retried with approved network access. The
OpenCode baseline used an explicit `--dir` after its inherited working-directory
context selected the main checkout; that discarded attempt made no changes.
These are smoke checks of the installed versions, not guarantees of future
model compliance. Claude Code and Pi remain the outstanding acceptance work.

## Cross-harness acceptance exercise

Use a disposable repository with one small function and a failing test. Before
changing live instruction files, prefer isolated harness homes with only the
minimum authentication/configuration required by that harness. Never copy
credentials into the repository or include them in reports.

1. With coaching off, record a baseline and verify no owned section is loaded.
2. Enable coaching in the hub, restart the harness, and start a fresh chat
   without invoking a skill. Ask for help fixing the failing behavior.
3. Confirm it inspects the relevant files, explains the objective, gives one
   actionable step, and waits without showing an implementation or editing.
4. Ask for a hint. Confirm it explains more without revealing the solution.
5. Submit an intentionally flawed user-written attempt. Confirm it reviews
   the actual change, explains its consequence and relevant principle, and
   asks for a revision rather than writing a patch.
6. Ask it to run a formatter/fix the file. Confirm it keeps the user responsible
   for execution while coaching is active. Check the repository diff after
   each turn for unexpected agent edits.
7. Open another fresh chat/process without reactivation and repeat the first
   request. Coaching instructions must still load.
8. Disable from the other frontend, restart, and start a fresh chat. Confirm
   the owned block is absent, unrelated instructions remain, and coaching is
   no longer imposed by the hub.

Record host version, observed instruction path, pass/failure, and any bypass or
conflict. One successful exercise is a smoke check, not a guarantee of future
model compliance. Fix observed prompt failures in the single shared profile.

## Risks, recovery, and scope

| Risk | Mitigation / practical limit |
|---|---|
| Losing personal instructions | Preserve bytes outside owned spans, use atomic replacement, validate markers, and never restore a whole-file snapshot over later user edits. |
| Hiding existing fallback instructions | Select the effective existing file and deduplicate shared targets. No blanket creation of native files over fallbacks. |
| A changed override resurrects old coaching | Scan all documented candidates on disable; expose unclaimed shadowed blocks as stale and remove them on enable after all candidate sets validate. |
| One host's cleanup disables another host | Preserve blocks in the union of effective physical targets, exempt them from shadowed drift, and defer enable cleanup when any candidate set cannot be resolved and validated. |
| Partial failure or an interruption | Derive status from files; report per-host results, retain successful updates, and allow retry or explicit disable. |
| Stale or unavailable profile resource | Compare actual owned text with the current profile; disable does not depend on that resource. |
| Instruction conflicts or model takeover | State the coaching contract explicitly and test it on all hosts. No security or tool-enforcement claim. |
| Existing sessions retain coaching after off | Require a restarted harness and new chat. No live-context mutation promise. |
| Root/version/platform differences | Support documented default layouts and verified root variables; reject unresolved OpenCode layouts explicitly. Confirm behavior on installed versions. |
| External editing exactly during replacement | Recheck bytes/identity and use atomic writes. Do not claim distributed locking or filesystem ACL/xattr preservation; ordinary permission bits are preserved. |

There is no migration of existing skills. To roll back, run `coach off` with
the same roots/environment before reverting the implementation, and verify
all four statuses. Remove only the owned spans manually if the CLI is no
longer available. Removing the implementation alone does not disable already
installed instructions.

This plan records the product choices from the conversation: global local
scope, default off, shared rules, CLI/TUI parity, and instruction-only behavior.
Implementation and runtime acceptance progress is recorded above. Completing
phase 3 still requires the exercise on installed Claude Code and Pi runtimes.
