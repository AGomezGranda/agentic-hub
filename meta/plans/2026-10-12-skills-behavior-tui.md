---
date: 2026-10-12
title: Skills and Behavior tabs for the tactical TUI
status: complete
---

# Skills and Behavior tabs

Give persistent agent behavior controls a second top-level page beside Skills.
Coding coach is the first control on Behavior. Keep the tactical appearance
and make navigation, focus, and available actions predictable.

The user has agreed to the two-tab direction and the two implementation phases
below. Both implementation phases and verification are complete; results are
recorded below.

## Implementation progress

- [x] Phase 1: navigation, interaction, tests, documentation, and usability checks.
- [x] Phase 2: tactical presentation, shared status, tests, documentation, and visual checks.

Baseline: 175 tests passed; Ruff lint, changed-file formatting, and Pyrefly
passed before implementation. Existing uncommitted coach changes are retained.

Phase 1: 39 TUI tests passed; scoped Ruff and Pyrefly passed. Pilot-driven
checks cover keyboard/click/tab-arrow navigation, filter/selection/preview/scroll
retention, Enter activation, empty skills/no matches, and pending writes with
both filter focus and no content focus. Navigation and action-scope tests failed
before implementation; the no-focus worker case exposed hidden-button restoration.
The retention and filter-typing tests passed after the native-page move and
serve as regression coverage. Visual inspection follows with phase 2.

Phase 2: the indicator/copy/short-terminal tests failed before implementation.
Final verification: 180 tests passed; full Ruff lint, formatting of the changed
Python files, Pyrefly, and `git diff --check` passed. Existing controller,
persistence, failure, retry, and theme coverage remains green.

Inspected rendered Textual screens for Skills and Behavior at 120×30, 40×24,
and 40×16 in tactical and Nord, selected and saved through `ctrl+p`. Scenarios
included ON/OFF, mixed/stale, a failed host, long diagnostics before/after
scrolling, focused tabs/buttons, disabled controls, filter/preview, no matches,
and empty skills. Diagnostics scroll while actions and the reminder stay visible;
Skills regains the body space. Visual QA prompted clearer card-title and disabled
button text. SVG/PNG evidence is in `/private/tmp/agentic-hub-tui-visual/`.

Manual interactions were driven with Textual Pilot and existing temporary-home
fixtures; no live host paths were mutated and no physical-terminal session was
used. Color previews unset `NO_COLOR` only in the disposable QA environment;
the automated suite also covers the existing no-color environment. A temporary
SVG renderer was used for QA without adding a project dependency. No substantive
plan deviations or preexisting check failures were found.

## Current State

- `src/agentic_hub/tui.py:109`, `AgenticHubApp.compose()`, mounts the coach
  summary and buttons above the filter, stats, skill cards, and preview. Its
  CSS at `tui.py:63` caps the summary at 40% of the screen, so coaching takes
  space from skills even when the user is managing skills.
- `src/agentic_hub/tui.py:76`, `BINDINGS`, defines app-wide skill and coach
  actions. There is no page navigation or page-specific action availability.
- `src/agentic_hub/tui.py:97`, `__init__()`, owns skill selection, filter,
  cursor, sorting, preview visibility, and coach busy state. These values
  already provide the state to retain across page switches.
- `src/agentic_hub/tui.py:131`, `refresh_coach()`, derives ON, OFF, MIXED, or
  ERROR from observed per-host states and renders diagnostic details.
- `src/agentic_hub/tui.py:169`, `_set_coach()`, runs mutations off the UI
  thread, prevents overlapping writes, disables the buttons, reports failed
  results, and conditionally restores button focus. That last step needs to
  respect the active page after navigation is introduced.
- `src/agentic_hub/tui.py:403`, `action_refresh()`, refreshes skills and coach
  status, skipping coach inspection while a write is in progress.
- `src/agentic_hub/tui.py:25` defines the tactical theme; `tui.py:46` and
  `tui.py:53` load and save theme preferences. Both pages can reuse this.
- `tests/test_tui.py:24`, `setup_fixture()`, isolates skill, host, and theme
  paths. `tests/conftest.py:9`, `isolated_coach_home()`, isolates coaching
  roots and the profile. Existing tests cover persistence, errors, busy
  controls, focus, empty skills, filters, previews, and theme selection.
- `README.md:90` describes coach controls above the skill filter and must
  describe the new location and shortcut scope.
- The installed Textual source provides `TabbedContent`, `TabPane`,
  `TabActivated`, `check_action()`, and `refresh_bindings()`. Its tab widget
  handles left/right when focused. Programmatically focusing a child in a
  hidden pane activates that pane, making worker focus restoration a concrete
  navigation risk.

## Design Decisions

| Area | Decision and rationale |
|---|---|
| Information structure | Skills manages installed capabilities; Behavior manages persistent instructions such as coding coach. The label accommodates similar controls without adding any now. |
| Initial page | Skills opens on every launch, preserving the primary entry point. |
| Navigation | Use Textual's native `TabbedContent` and two `TabPane` containers. Keep both mounted to preserve widget state and existing selectors. |
| Page selection | Read the selected page from `TabbedContent.active`; avoid a second page-state variable. |
| Keyboard access | `1` opens Skills and `2` opens Behavior. Bindings must allow these characters to be typed normally into the filter. Tabs also remain clickable and reachable with Tab/Shift+Tab. |
| Arrow keys | Preserve the skill cursor within skills content and native left/right navigation when the tab bar has focus. Behavior allows native scrolling and button navigation. |
| State retention | Switching pages retains filter text and visibility, selections, cursor, sorting, preview visibility, and scroll position. Navigation does not rebuild the grid or inspect coaching. |
| Action scope | Skills actions operate only on Skills; `c`/`C` operate only on Behavior. The footer reflects the available actions. Refresh, quit, theme selection, and page navigation remain shared. |
| Status visibility | A compact shared status strip shows `COACH: ON`, `OFF`, `MIXED`, or `ERROR` on both pages. It describes installed instructions, rather than whether a running agent loaded them. |
| Behavior actions | Retain explicit Enable all and Disable all buttons and existing `c`/`C` semantics. The scope remains all configured hosts. |
| Visual language | Reuse theme variables, square heavy borders, dense spacing, and amber focus. Distinguish the active page from keyboard focus, with text labels supporting color. |
| Refresh | Keep explicit `ctrl+r` refresh and post-operation status updates. The shared indicator represents the last observed result; there is no background polling. |

### Intended layout

```text
 AGENTIC HUB
 COACH: ON
 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Skills       [ Behavior ]
 ───────────────────────────────────────────
 ┏ Coding coach ━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃ Guidance, hints, and review while       ┃
 ┃ you write the implementation.           ┃
 ┃ Scope: all hosts                       ┃
 ┃                                        ┃
 ┃ Coding coach: ON                       ┃
 ┃ claude ON   pi ON   opencode ON         ┃
 ┃ codex  ON                              ┃
 ┃                                        ┃
 ┃ [ Enable all ]    [ Disable all ]       ┃
 ┃ Restart your agent and start a new chat.┃
 ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 Page-specific footer
```

The description, per-host states, and diagnostics share a scrollable region.
Actions and the restart reminder remain outside that region. Skills retains
its existing cards, stats, filter, empty state, and optional preview.

## Implementation Phases

1. **Navigation and interaction:** introduce the pages, preserve state, scope
   actions, and keep worker completion from changing the active page.
2. **Tactical presentation and usability:** style the Behavior card, add the
   shared status strip, and ensure controls remain reachable in short terminals.

Both phases include their own tests, documentation, and manual checks. Phase 2
depends on phase 1; each phase can be reviewed and reverted independently.

## Phase 1 — Navigation and interaction

### Overview

Introduce the two pages using native Textual widgets. Move the existing
controls into their respective panes while preserving current operation
semantics and skill-view state.

### Changes

**`src/agentic_hub/tui.py`**

- Import `TabbedContent` and `TabPane` from `textual.widgets`.
- Update `compose()` with `TabbedContent(id="pages", initial="skills-page")`:
  - `TabPane("Skills", id="skills-page")` contains the existing `#filter`,
    `#stats`, `#empty-state`, and `#body` with `#grid` and `#detail`.
  - `TabPane("Behavior", id="behavior-page")` contains the existing
    `#coach-summary`, `#coach-status`, `#coach-buttons`, `#coach-enable`, and
    `#coach-disable`.
  - Keep Header and Footer outside the tabbed content. Retain existing widget
    IDs so rendering and operation code continue to address the same widgets.
- Give the tabbed content and panes the available body height. Retain
  `AUTO_FOCUS = None` so the initial skills cursor remains usable as today.
- Add `action_show_skills(self) -> None` and
  `action_show_behavior(self) -> None`, bound to `1` and `2` without priority
  over input. Keyboard navigation enters the visible content: the open filter
  on Skills, otherwise the existing cursor interaction; an enabled coach
  button on Behavior, or its summary when both buttons are busy.
- Add `on_tabbed_content_tab_activated(self, event:
  TabbedContent.TabActivated) -> None` to refresh binding availability and
  resolve focus left on hidden content. Keep native tab-bar focus usable for
  arrow navigation. Switching alone must not call `refresh_grid()`,
  `coach.inspect()`, or a mutation.
- Add `check_action(self, action: str, parameters: tuple[object, ...]) ->
  bool | None` using Textual's existing dynamic-action contract:
  - Skills owns `install`, `remove`, `install_all`, `remove_all`,
    `toggle_select`, `open_filter`, `close_filter`, `toggle_preview`,
    `cycle_sort`, `flip_sort`, and `cursor_up/down/left/right`.
  - Behavior owns coach toggle/disable; show these actions as unavailable
    during a coach write.
  - Hide inactive-page actions from the footer and reject their bindings.
  - Retain shared refresh, quit, navigation, and inherited palette actions.
- Update `_set_coach()` to refresh binding availability when busy state
  changes. Restore prior button focus only while Behavior remains active and
  the existing no-focus-stolen condition holds. A write continues when the
  user leaves Behavior; completion updates its result without navigating.
- Keep `action_refresh()` available on both pages, with its existing busy
  guard and refresh semantics. Preserve worker exception handling and retry.

**`tests/test_tui.py`**

- Reuse `setup_fixture()` and `isolated_coach_home()` for every new scenario.
- Update existing coach tests to enter Behavior before shortcuts or button
  interactions, and return to Skills before exercising skill operations.
- Adapt `test_coach_buttons_and_keyboard_focus_work_with_empty_filter` so
  filtering on Skills, operating coaching on Behavior, and returning to the
  same filter/selection view are exercised explicitly.
- Extend
  `test_coach_busy_blocks_overlapping_mutations_and_keeps_filter_responsive`
  to switch to Skills while a write is pending and verify completion retains
  both the selected page and filter focus. Include a no-content-focus case
  that would otherwise allow the old button-focus restoration to reactivate
  Behavior.
- Keep skill-only scenarios on the default page. Preserve existing
  persistence, mixed/stale repair, partial-failure, and retry assertions.

**`README.md`**

- Update Usage with `1`/`2` and mark `c`/`C` as Behavior shortcuts.
- Replace the above-filter description with Skills/Behavior navigation,
  retained view state, and shared refresh behavior.

### Tests first

Add headless UI component tests in `tests/test_tui.py` before changing the UI:

| Test | Behavior and edge cases |
|---|---|
| `test_skills_is_default_and_navigation_does_not_write` | Skills opens first; keyboard and mouse switching work; navigation calls neither skill mutations nor coach inspection/mutation. Use mocked boundaries to catch accidental side effects even when resulting state would be unchanged. |
| `test_tab_switch_preserves_skill_view` | A filtered view with a selection, nonzero cursor, changed sorting, open preview, and scrolled grid survives a round trip. Reuse enough skills to make scrolling observable. |
| `test_shortcuts_and_footer_follow_active_page` | Skill shortcuts on Behavior and coach shortcuts on Skills are inert and absent from available footer bindings; shared actions remain available. Native tab navigation remains usable. |
| `test_filter_keeps_navigation_keys_as_text` | With filter input focused, typing `1`, `2`, `c`, and `C` changes input only; no navigation or coach write occurs. |

Extend the existing busy-worker test rather than creating another concurrency
harness. Keep the existing controller tests as the unit coverage for file
persistence; do not duplicate their internals in navigation tests.

### Success criteria

**Automated**

- Start with the focused failing test:
  `rtk proxy uv run pytest -q tests/test_tui.py -k skills_is_default_and_navigation_does_not_write`.
- After implementation: `rtk proxy uv run pytest -q tests/test_tui.py`.
- `rtk proxy uv run ruff check src/agentic_hub/tui.py tests/test_tui.py`.
- `rtk proxy uv run pyrefly check`.
- Record preexisting failures before implementation and report them separately.

**Manual**

- Navigate with `1`/`2`, clicks, and focused-tab arrows. Tab/Shift+Tab reaches
  visible controls, and Enter activates buttons.
- Return to a filtered and selected skill view and confirm its cursor,
  preview, and scroll position are retained.
- Switch during a pending coach write and confirm completion neither changes
  pages nor takes focus from the current control.
- Verify coach and skill operations work on their own pages, including empty
  skills and no filter matches. Use disposable host paths for mutation checks.

### What we're not doing

Saved page preferences, navigation history, additional behavior controls,
new dependencies, controller changes, or a new test harness.

## Phase 2 — Tactical presentation and usability

### Overview

Give Behavior a clear card layout and keep observed coaching status visible
while managing skills. Bound scrolling so long errors cannot hide actions.

### Changes

**`src/agentic_hub/tui.py`**

- Add a shared `Static(id="coach-indicator")` between Header and the tabs.
  Keep it one line, with a textual `COACH: ON/OFF/MIXED/ERROR` label and
  supporting theme color. Ensure the full label fits at 40 columns.
- Import `Vertical` from `textual.containers` and wrap the Behavior controls
  in `Vertical(id="coach-card")`, with a square heavy border and border title
  `Coding coach`. Reuse the skill cards' spacing and palette.
- Keep `#coach-summary` as the scrolling area containing `#coach-status`.
  Include the short description, `Scope: all hosts`, combined state, per-host
  states, and diagnostic details there.
- Move the restart reminder out of `refresh_coach()`'s scrolling summary
  into a separate `Static(id="coach-restart")` below the actions. Its text
  remains: `Restart the harness and start a new chat to apply changes.`
- Update `refresh_coach()` to render the shared indicator and card from the
  same existing combined-state calculation. Preserve notifications,
  per-host error details, retained operation failures, and observed-state
  reporting. Rendering a hidden pane must not focus or activate it.
- Update CSS for `#pages`, its tab bar, `#coach-card`, `#coach-summary`,
  `#coach-buttons`, and `#coach-restart`. Replace the summary's 40% height cap
  with the remaining card height and allow wrapping/scrolling; keep buttons
  and reminder reachable.
  Scope tab and coach styling so it does not alter skill-card focus classes.
- Style active tabs and keyboard focus distinctly. Use theme variables so
  saved themes continue to work. Keep disabled-button feedback visible.

**`tests/test_tui.py`**

- Add shared-indicator assertions for initial status, completed operations,
  and explicit refresh. Preserve the existing real-controller integration
  within temporary paths for persistence and CLI refresh.
- Replace
  `test_long_coach_errors_keep_controls_and_skills_visible_in_narrow_terminal`
  with `test_behavior_controls_remain_reachable_in_short_terminal`: the two
  pages now use separate space, so simultaneous grid/coach visibility is no
  longer an appropriate assertion.
- Extend `test_coach_controls_default_off_without_skills` to verify Behavior
  remains accessible, explains its scope and restart requirement, and has
  enabled controls even when the Skills page is empty.
- Retain the existing tactical-default and saved-theme tests.

**`README.md`**

- Describe the shared coach indicator, installed-instruction meaning,
  per-host diagnostics, busy controls, and explicit refresh.
- Document that page switching preserves the skill view and that actions
  belong to their respective pages.

### Tests first

Use the existing headless component-test patterns:

| Test | Behavior and edge cases |
|---|---|
| `test_coach_indicator_tracks_results_and_refresh` | ON, OFF, MIXED, and ERROR have the same meaning in the card and shared indicator. CLI changes appear after `ctrl+r`; operation completion updates the indicator while Skills is active without navigating. Reuse existing refresh and worker scenarios where they already prove the behavior. |
| `test_behavior_controls_remain_reachable_in_short_terminal` | At 40×16, all hosts can report long diagnostics while both buttons and the restart reminder remain within the visible pane. Diagnostics scroll; switching back leaves usable space for skill cards. |

Put static copy assertions in the existing empty-skills scenario. Do not add
separate tests for each decorative style or duplicate controller unit tests.

### Success criteria

**Automated**

- `rtk proxy uv run pytest -q`.
- `rtk proxy uv run ruff check src tests`.
- `rtk proxy uv run ruff format --check src/agentic_hub/tui.py tests/test_tui.py`.
- `rtk proxy uv run pyrefly check`.
- Scope formatting checks to changed Python files; record unrelated failures
  separately rather than repairing them as part of this UI change.

**Manual**

- Inspect both pages at 120×30, 40×24, and 40×16. Check ordinary status,
  mixed/stale results, a failed target, and long diagnostics using disposable
  host paths for mutation/error exercises.
- Verify descriptions and errors can scroll while actions and the restart
  reminder remain reachable. Check keyboard focus and button activation.
- Check the tactical theme and another saved theme through `ctrl+p`. Confirm
  active-page, focus, status, and disabled-control distinctions are legible.
- Confirm Skills regains the body space previously occupied by coach controls
  and its empty/filter/preview states still work.

### What we're not doing

Animations, a general settings page, a reusable behavior-card framework,
new themes, automatic status polling, per-host coaching toggles, or additional
agent behaviors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Hidden-page shortcuts modify files | Gate their availability through native dynamic actions and test mutation boundaries on both pages. |
| Worker completion unexpectedly switches pages | Make button-focus restoration conditional on Behavior still being active; test both focused and unfocused Skills cases. |
| Tab focus interferes with skill arrows | Keep native tab-bar navigation and explicitly verify skill-content cursor behavior after page entry. |
| Active coaching becomes easy to overlook | Keep the textual shared status indicator visible on both pages. |
| Indicator becomes stale after external changes | Document last-observed status and preserve `ctrl+r`; never imply live model status or automatic refresh. |
| Short terminals hide actions | Give diagnostic content the scrolling region and verify button/reminder geometry at 40×16, followed by visual inspection. |
| UI tests pass but appearance is poor | Inspect the stated terminal sizes and two themes before marking the phase complete. |
| Existing uncommitted work is displaced | Make focused edits around the current coach feature and retain its error handling, isolation fixtures, and persistence coverage. |

## Migration and rollback

There is no stored-state migration. Navigation does not change installed
skills or coaching instructions, and the theme preference file keeps its
existing format. Reverting this UI change restores the previous layout;
installed coaching state remains as observed before the revert.

Controller, profile, CLI, packaging, dependency, and export changes are outside
the implementation surface. Preserve the existing temporary-home fixtures.
The implementation and verification recorded above change only the TUI, its
tests, README, and this plan; existing uncommitted coach work is retained.
