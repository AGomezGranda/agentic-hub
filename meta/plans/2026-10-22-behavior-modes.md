---
date: 2026-10-22
title: Exclusive persistent behavior modes in the CLI and TUI
status: implemented
---

# Exclusive persistent behavior modes

Extend Coding coach with Rubber Duck, Skeptic, and Interviewer, using the
contracts in `docs/behavior-modes.md`. The hub manages one primary behavior
at a time across Claude Code, Pi, OpenCode, and Codex. Off restores the normal
working relationship without executing work discussed under a mode.

The user approved persistent, all-host scope, exclusivity including Coach,
and three phases with a selector followed by an explicit Apply action.
Implementation progress is tracked below; this work does not activate a mode
in live user instruction files.

## Implementation checklist

- [x] Phase 1: controller, profiles, and Coach compatibility.
- [x] Phase 2: mode CLI and operating instructions.
- [x] Phase 3: TUI selector and usability checks.
- [x] Available-harness probes and unavailable-runtime acceptance record.
- [ ] Follow-up: conversational probes on authenticated Claude Code and Pi.

Baseline: Ruff and Pyrefly pass; 217 existing tests pass (33.56 seconds).

## Current State

- `docs/behavior-modes.md:13` defines persistent conversation behavior,
  explicit exits/exceptions, and one primary mode at a time. Its three roles
  differ in tool use as well as conversational style.
- `src/agentic_hub/profiles/coding-coach.md:7` leaves implementation to the
  user. Lines 21–31 allow reading, prohibit executing checks, and distinguish
  a conversation-local exit from the persistent hub setting. Preserve this
  existing Coach contract.
- `src/agentic_hub/coach.py:13` selects one packaged profile and owns a
  `coding-coach` marker pair. `CoachStatus` at line 24 has freshness/error
  state but no mode identity. `combined_state()` at line 30 would incorrectly
  call different active modes uniformly on if extended without that identity.
- `coach.py:45` resolves existing host instruction candidates and environment
  overrides. `_scan()` at line 132 deduplicates physical files: OpenCode may
  share Claude's file, and symlinks may connect other hosts' candidates.
- `coach.py:172` inspects actual installed text rather than a saved boolean.
  `_write()` at line 219 checks for concurrent changes and replaces each
  physical file atomically. `_updated()` at line 245 preserves outside bytes
  and ownership provenance. `set_enabled()` at line 268 retains successful
  independent writes and reports failures; there is no all-host transaction.
- `src/agentic_hub/cli.py:110` exposes `coach on|off|status`, stdout status,
  stderr diagnostics, restart guidance, and mutation postcondition checks.
- `src/agentic_hub/tui.py:144` already separates Skills and Behavior.
  `refresh_coach()` at line 227 renders a shared indicator and diagnostic
  card; `_set_coach()` at line 262 runs writes outside the UI thread.
  `check_action()` at line 196 scopes shortcuts, and worker completion at
  line 289 avoids navigating away from Skills or stealing focus.
- `tests/test_coach.py:146` covers byte-preserving round trips; lines 195,
  252, 309, 344, and 412 cover shared files, aliases, corrupt blocks,
  conflicting writes, and partial failure. Extend these tests rather than
  replace the safety model.
- `tests/test_tui.py:60`, `:98`, `:134`, `:436`, and `:505` cover navigation
  without I/O, retained Skills state, scoped bindings, pending workers, and
  40×16 terminals. `tests/conftest.py:9` isolates instruction roots and
  profile content. `pyproject.toml:13` already includes Textual.
- Existing plans under `meta/plans/` describe the implemented coach and
  two-page TUI. Their historical line references/layouts are not the current
  source of truth. The coach plan records incomplete runtime acceptance on
  Claude Code and Pi; do not assume those harnesses have been validated.

## Design Decisions

### Scope and lifecycle

Use the existing global instruction files as the persistent source of truth.
The choices are **Off, Coach, Rubber Duck, Skeptic, Interviewer**. Coach is
the existing tutor behavior; do not introduce a separate Tutor mode or rename
the existing command/profile.

Applying a choice targets every configured host in the hub's current local
environment. Restart the harness and start a new chat after changing the
installed default. A user may explicitly leave a mode, request a one-time
exception, or request another role in the current chat; that does not write
the hub's persistent setting or guarantee changes to future chats. Routine
agreement does not end a mode. Off never executes an earlier suggestion.

These profiles guide behavior; they do not enforce tool permissions or
override higher-priority instructions. Preserve the current Coach rules;
the new modes use the exception/exit contract from the concept document.

### One controller, one block, four authored profiles

Move the persistence implementation from `coach.py` to
`src/agentic_hub/behavior.py`, updating all repository callers and tests.
Keep user-facing `coach` command syntax; there is no documented Python API
requiring a second controller or a compatibility module.

The controller's public surface is:

```python
BehaviorMode = Literal["coach", "rubber-duck", "skeptic", "interviewer"]
PROFILES: dict[BehaviorMode, Path]

@dataclass
class BehaviorStatus:
    state: Literal["off", "on", "stale", "error"]
    path: Path | None
    mode: BehaviorMode | None = None
    detail: str | None = None
```

| Function signature | Responsibility |
|---|---|
| `inspect() -> dict[str, BehaviorStatus]` | Read actual per-host installed state without writes. |
| `set_mode(mode: BehaviorMode \| None) -> dict[str, BehaviorStatus]` | Replace/remove the primary block and return observed results with operation errors. |
| `combined_state(statuses: dict[str, BehaviorStatus]) -> str` | Aggregate freshness and mode identity using the rules below. |
| `mode_label(mode: BehaviorMode) -> str` | Render the built-in identifier as a human-readable label. |

`None` means off, not another profile. `mode_label()` renders the identifier
as title-cased words. `PROFILES` is a fixed mapping to the existing
`coding-coach.md` and three new files beside it: `rubber-duck.md`,
`skeptic.md`, and `interviewer.md`. Each profile is self-contained; add no
profile plugin loader, template engine, separate saved selection, or mode
fields to `agents.AGENTS`. Its existing `agents.Mode` means skill installation
strategy, so the new type must have a distinct name.

There is at most one owned primary block per instruction file. Continue
writing Coach with its existing `coding-coach` framing, so unchanged Coach
installations remain current and repeated application stays idempotent.
For the three new modes write:

```text
\n\n<!-- agentic-hub: behavior-mode begin mode=skeptic created=0 -->\n
<exact profile bytes>
\n<!-- agentic-hub: behavior-mode end -->\n
```

The notation above shows framing bytes; installed files contain actual LF
characters, not literal backslash sequences. Preserve the existing two
leading and one trailing LF ownership convention.

Read existing `coding-coach` blocks as mode `coach`; read the named format
with an explicit recognized identifier. Inspection never rewrites either
format. A switch replaces the owned span in one write, preserving its
`created` provenance. Switching back to Coach restores its existing framing.
Off removes either recognized format without loading profile sources.

Malformed framing, unknown mode identifiers, duplicate blocks, or a file
containing both formats are errors; leave that file untouched. Preserve
host selection, alias deduplication, symlinks, ordinary permission bits,
concurrent-edit checks, deferred shadowed cleanup, and independent success.
Validate only the requested profile before enabling; an unavailable unrelated
profile must not block a switch away from it or off. Inspection of a present
mode whose source is unavailable reports an error with its known mode.

### Status semantics

`BehaviorStatus.mode` identifies the effective owned block even if its body
is stale. It is `None` when no effective block exists or identity cannot be
established. A failed mutation retains any known observed mode plus the
operation error; details include observed freshness and mode. Paths and
diagnostics must never expose personal instruction contents.

| Combined result | Meaning |
|---|---|
| `OFF` | Every host is off. |
| `COACH`, `RUBBER DUCK`, `SKEPTIC`, `INTERVIEWER` | Every host is on with the same current profile. |
| `MIXED` | Different installed modes, on/off differences, stale blocks, or no hosts. |
| `ERROR` | Any host has an inspection or operation error. |

Keep the current rule that a shadowed block used by another host is not an
unclaimed leftover. Do not infer success from a requested target or TUI value.

### CLI contract and compatibility

Add the following commands in phase 2:

```text
agentic-hub mode set coach
agentic-hub mode set rubber-duck
agentic-hub mode set skeptic
agentic-hub mode set interviewer
agentic-hub mode status
agentic-hub mode off
```

Retain `coach on`, `coach off`, and `coach status` as aliases for setting
Coach, turning all primary behavior off, and inspecting primary behavior.
`coach on` therefore replaces another active mode; `coach off` is the same
global off operation as the TUI. Document these effects explicitly.

Both command families print `Behavior: <combined result>` followed by each
host's mode, freshness/error state, and selected path to stdout. Diagnostics
stay on stderr, with the restart/new-chat reminder after mutations. The
command syntax remains compatible; the old coach-only output header changes
to this mode-aware format. Do not promise exact legacy output compatibility.

Status exits 0 for ordinary mixed/stale results, 1 for errors. Set/off exit
0 only when every host reaches the requested mode and current state, or off;
otherwise 1. Invalid/missing arguments exit 2. No per-host flag is added.

### TUI flow

Keep Skills as the launch page, `1`/`2` navigation, and mounted page contents.
Extend the existing Behavior card with one native Textual `Select[str]`:
Off, Coach, Rubber Duck, Skeptic, Interviewer. A visible label identifies
this as the **Selected mode**, while the summary identifies **Installed**
status. Selection previews the role and its tool boundaries without writing
files or re-inspecting host instructions.

```text
MODE: SKEPTIC
  Skills    [Behavior]
┏ Behavior ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ Selected mode: [Rubber Duck       v] ┃
┃ Reflect and clarify your thinking.  ┃
┃ Scope: all hosts                    ┃
┃ Installed: SKEPTIC                  ┃
┃ claude: skeptic / on                ┃
┃ pi: skeptic / on                    ┃
┃ opencode: skeptic / on              ┃
┃ codex: skeptic / on                 ┃
┃ [ Apply all ]   [ Turn off all ]    ┃
┃ Restart harness; start a new chat.  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

The global `MODE:` line always shows observed installed status. It never
changes merely because the pending selection changes. Descriptions and
per-host diagnostics scroll; the selector, buttons, and restart reminder
remain reachable at 40×16. Use the native compact Select presentation if
needed to preserve the existing short-terminal guarantee.

Initialize the selector once from a uniform current mode or Off. For
`MIXED`/`ERROR`, show the native empty-selection prompt and disable Apply
until a target is chosen. Use the string `"off"` for the Off option and
translate it to controller `None`; do not confuse Off with the widget's
empty-selection sentinel. Refresh updates observed status without replacing
the user's pending choice. Operation completion also retains that choice;
Turn off all can therefore leave a different pending mode visible above
`Installed: OFF`.

On Behavior, `c` becomes **Apply mode** and `C` becomes **Turn off**. Applying
an already active mode refreshes it, rather than toggling it off. Enter in
the selector chooses an option; Enter on Apply performs the write. While
the native selector menu is open, its search/navigation keys must not bubble
into mode mutations or page switches. Escape closes that menu. No numeric
mode shortcuts compete with page navigation.

On page entry focus the selector, or the summary while busy. Tab/Shift+Tab
reach the selector, summary, and buttons. One busy guard disables all mode
controls and actions during a write; shared navigation and Skills remain
usable. Completion restores focus only if Behavior is still active, focus
has not moved elsewhere, and the old focused control was disabled. Keep
explicit `ctrl+r`, no polling, and no behavior reads in skill navigation.

## Implementation Phases

### Phase 1 — Shared controller, profiles, and existing Coach compatibility

**Overview**

Generalize the existing persistence engine and provide all four profiles.
Keep the existing Coach entry points usable, including accurate reporting
when they encounter instructions for another mode.

**Changes**

- Move `src/agentic_hub/coach.py` to `behavior.py`. Replace `PROFILE_PATH`
  with `PROFILES`, `CoachStatus` with `BehaviorStatus`, and
  `set_enabled(enabled)` with `set_mode(mode)`. Preserve
  `instruction_candidates()`, `_scan()`, `_unchanged()`, and `_write()`
  contracts. `_profile(mode)` loads and validates one source, rejecting both
  owned marker prefixes in authored profile text.
- Add `_parse_block(data: bytes, path: Path) -> _Block | None` and a small
  internal `_Block` dataclass holding `start`, `end`, `mode`, `created`, and
  `body`. `_File.block` uses this normalized form for either framing.
  `_updated(target, mode, profile)` replaces/removes the normalized span
  and emits Coach or named framing as specified above. Validate `mode`
  against the fixed registry before any mutation, even for direct callers;
  an invalid direct-call identifier raises `ValueError` without writing.
- Implement mode-aware `inspect()`, `combined_state()`, and `mode_label()`.
  `set_mode()` checks the requested mode as well as freshness in its observed
  result and preserves partial-failure diagnostics and modes.
- Keep `profiles/coding-coach.md`'s learning, implementation, and execution
  restrictions. Add the other three authored profiles, distilled from the
  concept document with the following acceptance contracts:

  | Profile | Contract |
  |---|---|
  | Rubber Duck | Reflect briefly, ask one focused question, distinguish observation from interpretation, disclose concrete contradictions, and ask before giving advice. Do not proactively search repositories or run experiments; user-requested context support is allowed. |
  | Skeptic | Restate the strongest proposal, challenge consequential assumptions with concrete evidence, distinguish demonstrated defects from risks/questions, inspect relevant code for code-based proposals, and accept resolved concerns. Propose experiments; execute changing experiments only on explicit request. |
  | Interviewer | Establish topic/difficulty/feedback timing with reasonable defaults; present one constrained challenge; preserve independent work and stable criteria; answer clarifications without revealing the approach; provide labeled, progressively stronger requested hints; assess the actual attempt and distinguish hinted work. Inspect submitted code and run checks when appropriate and requested; do not expose repository reference solutions early. |

  Each new profile states persistence across follow-ups, conflict handling,
  explicit one-time exceptions that resume the role afterward, explicit
  chat-local exits without reconfirmation, and the absence of implicit code
  edits/commits. Chat instructions never modify persistent host files.
- Update `src/agentic_hub/cli.py:cmd_coach()` to call the new API. Introduce
  `_report_behavior(statuses, requested)` with `requested` equal to a mode,
  `"off"`, or `"status"`; share formatting, exit rules, and postcondition
  checking. Keep existing argparse command syntax in this phase.
- Update `src/agentic_hub/tui.py` imports, status types, worker calls, and
  refresh code to use `behavior`. Rename coach-specific methods/IDs/state
  consistently to behavior names, including `refresh_behavior()`,
  `_set_behavior(mode)`, `_behavior_busy`, and `#behavior-indicator`.
  Render the generic indicator and per-host modes now so phase 2's CLI
  choices cannot be mistaken for Coach. Until phase 3, label the existing
  controls **Enable coach / Turn off all**; `c` switches to Coach unless
  every host is currently Coach, in which case it turns behavior off.
- Move `tests/test_coach.py` to `tests/test_behavior.py`, adapting the
  existing safety suite rather than duplicating it. Update imports and
  mocks throughout `tests/test_cli.py`, `tests/test_tui.py`, and
  `tests/conftest.py`. Rename the fixture `isolated_behavior_home` and give
  it four isolated profile files. Preserve temporary instruction-root
  isolation and native/shared-host scenarios.
- Update README's controller/profile/status description and existing
  command output semantics; mark the additional modes as not yet selectable
  from the frontends until the following phases.

**Tests first**

Write each failing scenario before its production change; keep one focused
test/change/check loop. Use the existing pytest runner and temporary files.

| Test and level | Behavior pinned down |
|---|---|
| `test_mode_switch_round_trip_preserves_user_bytes` — controller unit | Parameterize all distinct ordered pairs of four modes; switch then off restores CRLF, no-final-newline, empty, and hub-created-file cases. Retain later-user-text cases without multiplying every dimension into the switch matrix. |
| `test_existing_coach_blocks_remain_current_and_idempotent` — controller unit | Existing installed Coach needs no rewrite; Coach → new mode → Coach preserves provenance and restores Coach framing. A current repeated set leaves bytes and metadata unchanged. |
| `test_mode_aggregation_uses_identity_and_freshness` — pure unit | Different active modes are mixed; stale is mixed; an error wins; all-off and uniform current profiles render correctly; empty status is mixed. |
| `test_profile_refresh_and_missing_sources_are_mode_specific` — controller unit | Editing an active source yields stale; reapply refreshes; a missing requested source changes no targets; an unavailable unrelated source does not block selection; off needs no source. |
| `test_conflicting_primary_blocks_are_not_overwritten` — parser/controller unit | Unknown identifiers, duplicate/both-format blocks, mismatched ends, and malformed framing remain errors with unchanged private bytes. |
| `test_switch_failure_retains_observed_modes_and_allows_retry` — controller unit | One target remains on its previous mode while independent hosts switch; error details retain actual mode; retry converges. Shared-target failure reaches both host reports. |
| Existing alias/shadowed/conflict tests — controller unit | Exercise switching through shared Claude/OpenCode files and Pi/Codex aliases; deferred cleanup, mode bits, symlinks, and concurrent edits retain their current guarantees. |
| Existing CLI and TUI scenarios — frontend integration/component | Adapt expected output/types and keep Coach on/off, worker responsiveness, Skills isolation, and all-home isolation green. Add status rendering for another mode without a selector. |

**Success criteria**

Automated:

- Record baseline failures before implementation:
  `rtk proxy uv run pytest -q`, `rtk proxy uv run ruff check src tests`,
  and `rtk proxy uv run pyrefly check`.
- Focused controller checks:
  `rtk proxy uv run pytest -q tests/test_behavior.py`.
- Caller regression:
  `rtk proxy uv run pytest -q tests/test_cli.py tests/test_tui.py`.
- Full checks:
  `rtk proxy uv run pytest -q`, `rtk proxy uv run ruff check src tests`,
  `rtk proxy uv run pyrefly check`.
- Format changed Python files:
  `rtk proxy uv run ruff format --check src/agentic_hub/behavior.py src/agentic_hub/cli.py src/agentic_hub/tui.py tests/test_behavior.py tests/test_cli.py tests/test_tui.py tests/conftest.py`.
- Build the wheel:
  `rtk proxy uv build --wheel --out-dir /tmp/agentic-hub-behavior-dist`.
  Inspect the produced wheel with Python's `zipfile` and assert it contains
  all four `agentic_hub/profiles/*.md` resources. Reuse the current build
  configuration; change `pyproject.toml` only if this check shows exclusions.

Manual:

- In disposable instruction roots, inspect existing Coach, switch to each
  new mode through the controller, switch back, and turn off. Check one
  owned block per file and exact restoration of outside text.
- Open the TUI with a non-Coach installation prepared in that environment;
  verify the installed mode is reported accurately before picker work.

**What we're not doing**

New instruction paths, skill installation changes, a second persistence
engine, automatic startup migration, custom user profiles, permission
enforcement, per-host settings, or changes to live user instruction files.

### Phase 2 — Mode CLI and operating instructions

**Overview**

Expose all modes through argparse while keeping existing Coach commands.
Both frontends continue to read the same installed state.

**Changes**

- In `src/agentic_hub/cli.py:build_parser()`, add the nested `mode`
  subcommands `set`, `status`, and `off`. `set` requires a mode chosen from
  `behavior.PROFILES`; missing subcommands must fail with argparse exit 2,
  rather than fall through to the default TUI action.
- Add `cmd_mode(args: argparse.Namespace) -> None`. Status calls
  `behavior.inspect()`; set/off call `behavior.set_mode()` and pass the
  result to `_report_behavior()`. Reuse that reporter from `cmd_coach()`.
- Update README Usage and the Behavior section with every command, the
  legacy aliases' replacement/global-off effects, mode-specific tool rules,
  state meanings, profile refresh by reapplying, current-host scope,
  restart requirements, and retry/off recovery.
- Update `docs/behavior-modes.md` to distinguish the conversational concepts
  from the approved persistent hub activation design. Keep implementation
  status accurate for each completed phase and retain the examples and role
  boundaries. Do not label the TUI selector implemented before phase 3.

**Tests first**

| Test and level | Behavior pinned down |
|---|---|
| `test_mode_set_status_switch_off` — CLI integration | Parameterize supported identifiers; separate `cli.main()` invocations persist, switch, refresh, and turn off. Check stdout modes/paths and stderr restart guidance without duplicating parser internals. |
| `test_coach_commands_alias_primary_mode_actions` — CLI integration | `coach on` replaces Skeptic with Coach; `coach status` reports Interviewer; `coach off` clears another mode. |
| `test_mode_status_is_read_only_and_reports_mixed_modes` — CLI integration | No filesystem changes on status; distinct host modes and stale results exit 0; inspection errors exit 1. |
| `test_mode_mutation_requires_requested_mode_and_freshness` — CLI unit | Inject an on/current result with the wrong mode: it must exit 1. Off with stale leftovers also fails. Error diagnostics stay on stderr and successful hosts remain visible. Reuse existing partial-failure integration coverage. |
| `test_mode_invalid_arguments_exit_two` — parser unit | Missing action, missing set target, unknown action/mode, and unsupported per-host flags exit 2. |
| Existing skill command tests — regression | Install/remove/sync neither inspect nor mutate primary behavior; patch the new controller boundary in the existing sync test. |

**Success criteria**

Automated:

- `rtk proxy uv run pytest -q tests/test_cli.py tests/test_behavior.py`.
- `rtk proxy uv run ruff check src tests`.
- `rtk proxy uv run ruff format --check src/agentic_hub/cli.py tests/test_cli.py`.
- `rtk proxy uv run pyrefly check`.

Manual:

- Under disposable roots, run actual separate CLI processes for
  `mode set rubber-duck`, `mode status`, `mode set skeptic`, `coach on`,
  and `coach off`. Verify exit codes, installed blocks, and original bytes.
- Introduce one invalid target; confirm a failed switch reports its old
  installed mode where readable and preserves independent successful hosts.
  Repair and retry, then turn off.

**What we're not doing**

Per-project/per-host switches, JSON output, conversation launchers, background
services, or changes to the meaning of skill commands.

### Phase 3 — TUI selector, usability, and behavioral acceptance

**Overview**

Make all modes discoverable and selectable on the existing Behavior page.
Verify frontend interaction separately from the model's conversational
behavior; filesystem tests alone cannot prove profile compliance.

**Changes**

- In `src/agentic_hub/tui.py:compose()`, add `Select[str]` with
  `id="behavior-mode"` and the five options specified above, plus an
  adjacent Selected mode label. Keep `#behavior-summary` as the scrollable
  region containing preview, installed summary, modes, and diagnostics.
  Use `#behavior-apply`, `#behavior-off`, and `#behavior-restart` for the
  fixed controls/reminder, within `#behavior-card`.
- Initialize selection after the initial `behavior.inspect()` using only
  a uniform current result or Off. Leave mixed/error at the native empty
  selection. Do not load a separate saved TUI mode preference.
- Add `on_select_changed(event: Select.Changed) -> None` to update preview
  and Apply availability from the widget value, without controller I/O.
  Keep concise static preview copy for each built-in mode; do not add
  profile parsing or read installed personal text into the preview.
- Replace coach-toggle actions with `action_apply_behavior()` and
  `action_disable_behavior()`. Translate `"off"` to controller `None`;
  an empty selection cannot reach `_set_behavior()`. Both buttons and
  `c`/`C` use those paths. Update footer descriptions and README for
  `c`'s changed apply/refresh semantics.
- Extend `check_action()` to disable apply/off while busy, disable Apply
  for empty selection, and suppress app character actions while the Select
  menu is expanded so type-to-search cannot apply or switch pages.
  Preserve native menu handling, tab-bar navigation, and filter input.
- Extend `_set_behavior(mode)` to freeze the selected target at activation,
  disable the selector and buttons under the existing worker guard, and
  retain actual mode/state in exception and postcondition reporting.
  Render results without replacing the pending selector value. Restore
  control focus only under the existing page/no-focus-stealing conditions.
- Keep `refresh_behavior()` responsible for actual indicator/status and
  notifications, with no pending-selection resets. `action_refresh()`
  skips inspection during a write, refreshes Skills as today, and uses the
  notification text `refreshed skills and behavior status`.
- Update CSS using existing theme variables and heavy borders. Bound the
  scroll region and menu overlay at short terminal sizes. Preserve the
  existing Skills layout, widgets, selection, preview, theme persistence,
  and explicit-refresh policy.
- Update README and `docs/behavior-modes.md` to describe the final UI,
  observed-versus-selected state, keyboard flow, mixed/error recovery,
  pending writes, and chat-local exit versus persistent settings.
- Add `docs/behavior-modes-acceptance.md` during runtime verification.
  Record host/version, mode, isolated instruction path, observed behavior,
  tool/diff evidence, and pass/failure/unavailable results. Missing harness
  access is recorded as unverified, never as a passing filesystem test.

**Tests first**

Use `tests/test_tui.py`'s existing synchronous pytest wrappers around
Textual `run_test()`/pilot scenarios. These are UI component tests with a
small number of existing real-controller integration cases.

| Test and level | Behavior pinned down |
|---|---|
| `test_behavior_selection_previews_without_applying` — UI component | All five choices; selection/Enter in the menu updates the preview only. Indicator remains the installed mode; Apply writes once. Empty selection disables Apply but leaves Turn off available. |
| `test_behavior_initial_selection_and_refresh_preserve_pending_choice` — UI component | Uniform Coach/new mode/Off initialize correctly; mixed/error initialize empty; CLI changes appear on `ctrl+r` without overwriting a pending selection. |
| `test_behavior_apply_persists_after_remount` — UI/controller integration | Parameterize the three new modes through Apply and remount; report the observed mode. Retain one Coach/off case. Do not repeat the controller's byte/symlink matrix here. |
| Existing page/binding/filter tests — UI component | Skills opens first; page switching and selection do no disk I/O; skill state/widget identity survives. `c` applies, `C` turns off on Behavior only; filter accepts shortcut characters. Selector arrows/search/Escape do not move the Skills cursor, switch pages, or trigger writes. |
| Existing failure/retry/postcondition tests — UI component/integration | A wrong observed mode is not success; partial errors show per-host mode/state/details, remain usable, and allow retry or explicit off. Both buttons work with no skills or no matches. |
| Existing pending-worker test — UI component | Disable selector and both buttons; repeated apply/off events issue one controller call; `ctrl+r` skips mid-write inspection. Switch to Skills and type/filter; completion neither navigates nor steals focus. |
| Existing short-terminal test — UI component | At 40×16 with long diagnostics, selector, actions, and reminder remain reachable; summary scrolls; native menu can select every option and close. Verify Tab/Shift+Tab and Return with mouse coverage in the existing control test. |

**Success criteria**

Automated:

- `rtk proxy uv run pytest -q tests/test_tui.py`.
- `rtk proxy uv run pytest -q`.
- `rtk proxy uv run ruff check src tests`.
- `rtk proxy uv run ruff format --check src/agentic_hub/tui.py tests/test_tui.py`.
- `rtk proxy uv run pyrefly check`.
- Broaden checks only for new changes or unresolved failures; do not repair
  unrelated preexisting formatting or suite failures as part of this work.

Manual:

- Inspect Skills and Behavior at 120×30, 40×24, and 40×16 in the tactical
  theme and one alternate saved theme. Exercise keyboard and mouse, open
  selector, long diagnostics, mixed modes, empty skills, and pending writes.
- In isolated instruction roots, alternate CLI and TUI changes, including
  pending choice versus installed mode; reapply, switch, off, and remount.
- For each available authenticated harness, restart with a fresh chat after
  setting each mode. Run the following brief multi-turn acceptance probes:

  | Mode | Observable acceptance |
  |---|---|
  | Coach | Reads relevant context, gives a next step, waits for the user's implementation, reviews an actual attempt, and leaves execution to the user. |
  | Rubber Duck | Reflects an ambiguous bug explanation and asks one focused question without searching or solving. Routine agreement preserves the role. An explicit request for repository support permits the requested inspection; unsolicited solution/patches do not occur. |
  | Skeptic | Restates a code-based proposal, inspects relevant context, separates evidence from risks, and stops reopening a resolved objection. Suggests an experiment but does not execute a changing experiment without an explicit request. |
  | Interviewer | Establishes reasonable exercise defaults, asks one challenge, handles clarification without revealing the algorithm, gives requested labeled hints, and assesses the submitted attempt with stable criteria and independent/hinted work distinguished. Requested checks are allowed; hidden reference implementation is not exposed prematurely. |

- In each new mode, probe a conflicting implementation request, an explicit
  one-time exception followed by another turn, and an explicit exit. Confirm
  ordinary requests keep the role, the bounded exception resumes it, and
  explicit exit needs no further confirmation. Check transcript/diff for
  unauthorized writes and confirm chat-local exit leaves installed defaults
  unchanged. Off from the other frontend removes the block; a fresh chat
  receives no hub-imposed role or queued implementation request.
- Record failures and refine the responsible authored profile, then repeat
  the affected probe. Record unavailable harnesses and required follow-up
  rather than claiming complete cross-harness acceptance.

**What we're not doing**

Separate pages/cards per mode, mode combinations, automatic activation on
selection, automatic polling, a learner database, stored interview scores,
automatic solution grading, or an automated model-evaluation framework.

## PR Strategy

Use three ordered, independently reviewable PRs matching the phases:

1. Controller/profile generalization, safety tests, and necessary caller
   adaptation. Existing Coach CLI/TUI remain functional with accurate generic
   status; extra modes are not yet publicly selectable.
2. CLI mode selection and operating documentation, depending on PR 1.
   The existing TUI can already report a mode installed by the CLI.
3. TUI selection, final documentation, visual checks, and runtime acceptance
   record, depending on PRs 1 and 2. Behavioral checks require installed,
   authenticated harnesses and may expose profile corrections in this PR.

Each PR includes its tests and relevant docs. Before reverting controller
support, use the updated hub to select Coach or Off. Reverting only the UI
does not change installed behavior.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Two roles are loaded together | One normalized owned span; replace on switch; reject duplicate/both-format files rather than guess. |
| Existing Coach installations become stale unnecessarily | Continue recognizing/emitting the existing Coach framing and preserve its profile contract. |
| Private instruction bytes or user edits are lost | Reuse atomic replacement, alias/conflict checks, outside-byte preservation, mode bits, and existing corruption tests. |
| A failed switch looks globally successful | Retain per-host observed mode/freshness plus errors; aggregate identities and require the requested identity in frontend postconditions. |
| Cleaning a fallback disables another host | Preserve effective physical target union and defer shadowed cleanup when any candidate set cannot validate. |
| Preview is mistaken for activation | Label selected and installed values separately; Apply is explicit; the shared indicator follows inspected state only. |
| Refresh discards a pending choice | Initialize once, then refresh installed state without resetting Select. |
| Selector search invokes app shortcuts | Gate app character actions during the expanded menu; exercise search and navigation in component tests. |
| Extra controls hide recovery actions | Reuse the scroll region and compact native Select; assert 40×16 geometry and inspect rendered output. |
| Running chats retain previous instructions | Keep restart/new-chat copy visible; never claim live context mutation. |
| Models over-help or ignore the role | Mode-specific authored contracts and recorded multi-turn probes; do not equate parser tests with behavioral enforcement. |
| Downgrading leaves an unrecognized new-mode block installed | Turn off with the updated hub before downgrade; keep Coach output readable by old releases. |

## Migration, rollback, and assumptions to validate

Existing Coach blocks require no startup migration or first-read write.
Switching adopts the selected mode's framing while retaining `created`;
off removes only owned bytes. A malformed file requires manual inspection.
An interruption can leave different modes across targets; inspect, fix the
reported target, and reapply the desired mode or off. Successful changes
remain in place; no whole-file backup is restored over later user text.

Before uninstalling or reverting mode-aware parsing, run
`agentic-hub mode off` under the same roots/environment and verify all host
states are off. If keeping Coach during downgrade, first run
`agentic-hub mode set coach` and verify uniform current Coach state with no
unclaimed new-format blocks. Removing the package alone does not disable
installed instructions.

Nonblocking assumptions and their checks:

- Existing package resource inclusion also includes the three new Markdown
  profiles. Verify the built wheel in phase 1; add only necessary package
  configuration if it fails.
- Native Textual Select fits the current terminal constraints. Its installed
  source provides an empty-selection sentinel, overlay navigation, change
  events, and compact presentation; verify interaction/geometry in phase 3
  against the project's installed version rather than hard-code sentinel
  names from another release.
- Harness access may differ from the historical Coach acceptance record.
  Check executable/authentication availability when running phase 3 and
  record each unavailable runtime explicitly. This limits acceptance
  evidence, not controller or UI test coverage.

## Requirement coverage

| Requirement | Delivery |
|---|---|
| Three roles with distinct tool/interaction boundaries; existing tutor retained | Phase 1 profiles, phase 3 runtime probes. |
| Persistent default across follow-ups/chats; explicit exceptions/exits | Phase 1 contracts, phase 2 operating docs, phase 3 probes. |
| Exclusive primary selection across all hosts | Phase 1 controller and switching tests. |
| Legacy Coach compatibility, preservation, partial-failure recovery | Phase 1 framing/safety tests; phase 2 command tests. |
| CLI/TUI parity and discoverable selection | Phase 2 CLI; phase 3 Select/Apply flow. |
| Accurate shared status and per-host diagnostics | Phase 1 generic rendering; phases 2/3 frontend checks. |
| Responsive TUI, retained Skills state, narrow-terminal accessibility | Phase 3 component and visual checks, preserving phase 1 regressions. |
| Off executes no previously discussed work | Phase 1 profile contract; phase 3 fresh-chat acceptance. |


## Execution record

### Phase 1

- Baseline: 217 tests passed; Ruff and Pyrefly passed.
- Generalized controller and authored the three profiles; Coach source unchanged.
- 281 tests passed after caller adaptation; Ruff, changed-file formatting, and
  Pyrefly passed (two existing suppressions retained).
- Wheel built and all four Markdown resources verified; no packaging changes.
  uv needed cache access and emitted its existing backend-version range warning.
- Disposable controller round trip verified one block and exact user-byte
  restoration. Textual component check mounted a prepared Skeptic installation
  and verified the observed mode and per-host display.
- No substantive plan deviations. Existing legacy state assertions now include
  mode identity and the generic Behavior/Installed headers.


### Phase 2

- Added the nested mode CLI and documented all role/tool boundaries, aliases,
  persistence, status meanings, recovery, and downgrade requirements.
- CLI/controller checks: 178 passed; Ruff, CLI formatting, and Pyrefly passed.
- Separate disposable CLI processes exercised set/status/switch, Coach aliases,
  and off with exact original-byte restoration. A readable but unwritable Codex
  directory retained Rubber Duck while the other hosts switched to Skeptic;
  diagnostics retained the observed mode. Repair/retry/off converged.


### Phase 3

- Native five-choice Select with explicit Apply/Off, independent preview and
  installed state, retained pending choices, guarded workers, and scoped keys.
- Final automated result: 313 tests passed; Ruff, changed-file formatting, and
  Pyrefly passed. Final wheel resources verified against authored source bytes.
- Inspected 30 headless layouts across tactical/nord and 120×30, 40×24, 40×16,
  including menu, errors, empty Skills, mixed state, and pending controls.
- Actual disposable CLI/TUI alternation verified pending choice versus observed
  installed mode, reapply/switch/off, and remount.
- Codex 0.162.1 completed 28 multi-turn probes without unauthorized tool attempts
  or file changes. OpenCode 1.18.35 initially edited on conflicting requests;
  clarified new-profile wording and repeated affected probes (14 + 17 turns)
  with unchanged file hashes. Interviewer retains a minor explanation-count
  error despite the correct result. See docs/behavior-modes-acceptance.md.
- Claude Code and Pi executables were unavailable; their runtime acceptance is
  explicitly unverified. Available probes required network-enabled execution;
  credentials and instruction roots were disposable, with credential copies
  deleted afterward. Existing Coach source was preserved.
- Implementation is delivered as local changes. The three-PR publication
  strategy remains available; no commits or remote publication were performed.
