---
date: 2026-09-19
title: Modernize the agentic-hub TUI (theming, granular actions, multi-select/filter/detail)
status: implemented
---

## Context

The current TUI (`src/agentic_hub/tui.py`, 53 lines) is a `Header` + `DataTable`
+ `Footer` with two bindings: `i` installs the cursor's skill to **all**
agents, `r` removes it from **all** agents. Verified while reading the code:

- Status cells (`agents.py:33-44`, four possible values: `linked`/`stale`/
  `missing`/`conflict`) render as plain text, no color/icon
  (`tui.py:29`: `agents.status(agent, name)` passed straight to `add_row`).
- `catalog.parse_frontmatter` (`catalog.py:14-27`) already extracts a skill's
  `description`, used today only by `agents.py:73` for the Codex flatten —
  the TUI never surfaces it.
- Real bug: `cli.py:120` sets up `logging.basicConfig(stream=sys.stderr)`
  before `tui.run()`, but Textual's `App.run()` wraps its event loop in
  `redirect_stdout`/`redirect_stderr` (confirmed in `textual.app` source) —
  every `log.warning`/`log.info` from `install_one`/`remove_one` is
  silently swallowed while the TUI runs, and `action_install_row` ignores
  the bool `install_one`/`remove_one` return. A failed install (e.g. target
  path is a real file, not ours — `agents.py:58-60`) looks identical to a
  successful no-op today.
- Textual 8.2.8 (already the only dependency, `pyproject.toml`) ships,
  unused today: builtin themes (`nord`, `gruvbox`, `dracula`, `tokyo-night`,
  `catppuccin-*`, ... — confirmed via `textual.theme.BUILTIN_THEMES`), a
  command palette on by default (`ctrl+p`, `App.ENABLE_COMMAND_PALETTE`),
  `self.notify()` toasts, `DataTable.sort()`, `cursor_type="cell"`,
  `DataTable.coordinate_to_cell_key()` (returns the row/column *keys* we set
  at `add_row(..., key=name)`/`add_column(agent, key=agent)`, independent of
  what's displayed), `RowHighlighted`/`HeaderSelected` messages, and an
  `app.theme_changed_signal` instance signal fired on every theme change
  (including via the command palette's built-in theme picker) — all
  confirmed interactively against the installed version, no new
  dependencies needed anywhere in this plan.
- `tests/test_tui.py` monkeypatches `catalog.SKILLS_DIR`/`agents.AGENTS` to
  a temp fixture with one fake single-agent dict; extending it to
  multi-agent fixtures is needed to actually exercise per-cell targeting.

Decisions resolved with the user (no open questions remain):
1. Granular: cursor moves cell-by-cell over the grid; `i`/`r` act on the one
   `(skill, agent)` cell under the cursor. Standing on the `Skill` column
   (column 0) has no single agent to target, so `i`/`r` there act on **all**
   agents for that skill — deliberate, not a fallback error state. `I`/`R`
   (shift+i/shift+r) always act on all agents for the cursor's skill,
   reachable from any column, so the old "whole row" behavior stays one key
   away without moving the cursor back to column 0.
2. A description side panel, sourced from the frontmatter already parsed by
   `catalog.parse_frontmatter`.
3. `space` multi-select (toggle, cosmetic checkbox prefix in the `Skill`
   column) + `/` substring filter; when the selection set is non-empty,
   `i`/`r`/`I`/`R` apply to every selected skill instead of just the cursor
   row, and clear the selection afterward.
4. Theme is switched via Textual's existing command palette (`ctrl+p` →
   "Change theme") — no new picker UI — and persisted to a one-line file so
   the choice survives restarts.
5. `ctrl+r` rescans `skills/` from disk (cheap: `refresh_table()` already
   re-reads `catalog.discover_skills()` fresh every call, no caching to
   invalidate).

## Implementation Phases

1. Visual modernization — persisted theme choice, color/icon status cells,
   sortable columns, empty-state placeholder. No behavior change.
2. Granular actions + feedback — cell-level install/remove, all-agents
   shortcut, `notify()` toasts wired to every result (fixes the swallowed
   logging).
3. Multi-select + filter + detail panel + manual refresh.

---

## Phase 1 — Visual modernization ✅ done

### Overview
Make the grid itself look modern (color-coded status, sortable columns,
themeable) without touching interaction logic.

### Changes
- `src/agentic_hub/tui.py`:
  - `STATUS_GLYPHS: dict[str, tuple[str, str]]` mapping each of the 4
    `agents.status()` values to `(glyph, rich_style)`:
    `linked → ("✓", "bold green")`, `stale → ("↻", "bold yellow")`,
    `missing → ("·", "dim")`, `conflict → ("✗", "bold red")`.
  - `render_status(status: str) -> Text` (from `rich.text import Text`) —
    `Text(f"{glyph} {status}", style=style)`.
  - `refresh_table()` uses `render_status(...)` for the agent cells instead
    of the raw string.
  - `_THEME_FILE = Path.home() / ".config" / "agentic-hub" / "theme.txt"`;
    `_load_theme() -> str` reads it (default `"textual-dark"`, Textual's
    own default, on missing/unreadable file — no new default imposed);
    `_save_theme(name: str) -> None` writes it, creating the parent dir.
  - `on_mount`: `self.theme = _load_theme()`, then
    `self.theme_changed_signal.subscribe(self, lambda theme: _save_theme(theme.name))`
    — persists any theme picked via the command palette, no custom UI.
  - `on_data_table_header_selected(event: DataTable.HeaderSelected) -> None`
    — toggles ascending/descending per column
    (`self._sort_reverse: dict[ColumnKey, bool] = {}`) and calls
    `table.sort(event.column_key, key=str, reverse=...)` (`key=str` because
    the agent cells are now `Text` objects, which don't support `<`;
    verified interactively).
  - Empty-state: add `Static(id="empty-state")` to `compose()`; in
    `refresh_table()`, set its `display` to `table.row_count == 0` and its
    text to `f"No skills found in {catalog.SKILLS_DIR}"`.
- `README.md`: no change yet (bindings still `i`/`r`/`q` at this point).

### Tests
- `tests/test_tui.py`:
  - Update the two existing assertions comparing `table.get_row_at(0)` to a
    plain status string — compare `str(table.get_row_at(0)[1])` to the
    glyph-prefixed text (e.g. `"· missing"`, `"✓ linked"`) instead.
  - `test_status_glyphs_cover_every_status()` — pure function test, no
    mounting: assert `tui.STATUS_GLYPHS` has an entry for each of
    `{"linked", "stale", "missing", "conflict"}` (the 4 literals returned by
    `agents.status()`) — cheap guard against silently rendering a blank
    cell for a state nobody styled.
  - Extend `test_zero_skills_renders_empty_table_and_bindings_dont_raise`
    to also assert the `#empty-state` `Static` is visible and mentions the
    skills dir; add a sibling assertion that it's hidden once a skill
    exists (mount with `with_skill=True`).
- Not unit-tested: header-click column sorting. It's a two-line call
  straight into `DataTable.sort()` (already covered by Textual's own test
  suite) — verified manually instead (see below).

### Success Criteria
**Automated**: `uv run pytest -q` — all pass.

**Manual**: `uv run agentic-hub` — status cells show colored glyphs; `ctrl+p`
→ "Change theme" → pick one → quit and relaunch → same theme loads; click a
column header twice → rows sort ascending then descending; empty a fixture
skills dir → placeholder message shown instead of a blank grid.

### What We're NOT Doing
- Not picking/forcing a specific "cool" default theme — Textual's own
  default stands until the user picks one via the command palette.
- Not adding a custom theme-picker widget — the command palette already has
  one.

---

## Phase 2 — Granular actions + feedback ✅ done

### Overview
Replace "one binding = every agent" with per-cell targeting plus an
explicit all-agents shortcut, and make every install/remove result visible
in the TUI (fixes the swallowed-logging bug from Context).

### Changes
- `src/agentic_hub/tui.py`:
  - `on_mount`: `table.cursor_type = "cell"` (was `"row"`; DataTable already
    supports left/right cell navigation out of the box, confirmed via its
    existing `action_cursor_left`/`action_cursor_right` bindings — no extra
    navigation code needed).
  - `_cursor_cell() -> tuple[str, str] | None` — replaces `_cursor_skill()`:
    `table.coordinate_to_cell_key(table.cursor_coordinate)` →
    `(row_key.value, column_key.value)`, i.e. the skill name and either an
    agent name or `"skill"` (the column-0 key set at `add_column("Skill",
    key="skill")`), independent of any cosmetic text in the cell.
  - `_run(fn, verb: str, force_all: bool) -> None` — shared by all four
    actions:
    ```
    hit = self._cursor_cell()
    if hit is None: return
    name, col = hit
    targets = list(agents.AGENTS) if force_all or col == "skill" else [col]
    ok = sum(fn(agent, name) for agent in targets)
    self.refresh_table()
    if ok == len(targets):
        self.notify(f"{name}: {verb} ({ok}/{len(targets)})")
    elif ok == 0:
        self.notify(f"{name}: {verb} failed for all {len(targets)} agent(s)", severity="error")
    else:
        self.notify(f"{name}: {verb} {ok}/{len(targets)} agent(s)", severity="warning")
    ```
  - `action_install/action_install_all/action_remove/action_remove_all` —
    thin wrappers calling `_run` with `(agents.install_one, "installed",
    False/True)` / `(agents.remove_one, "removed", False/True)`.
  - `BINDINGS` becomes:
    `i`→install, `r`→remove, `I`→install_all, `R`→remove_all, `q`→quit
    (each with a short description for the `Footer`).
- `README.md`: update the bare-invocation line to mention `i`/`r` (cell) and
  `I`/`R` (all agents).

### Tests
- `tests/test_tui.py`: change `setup_fixture` to register **two** fake
  agents (`fake1`, `fake2`) so cell-vs-row targeting is actually
  observable; keep a single-agent variant only where a test doesn't care
  (the existing zero-skills test can stay single-agent).
  - `test_cell_level_i_r_target_only_the_cursor_agent()` — move cursor to
    the `fake2` column (`table.move_cursor(column=2)`), press `i`; assert
    `agents.status("fake2", "demo") == "linked"` and `fake1` is still
    `"missing"`; press `r`; assert back to `missing`, `fake1` untouched.
  - `test_shift_i_r_always_target_all_agents()` — cursor on `fake2` column,
    press `I`; assert both `fake1` and `fake2` are `linked`; press `R`;
    assert both back to `missing`.
  - `test_column_zero_i_targets_all_agents()` — cursor stays at the default
    `(0, 0)`, press `i`; assert both agents linked (documents the
    resolved column-0 behavior from Context item 1).
  - `test_failed_action_notifies_without_crashing()` — pre-create a real
    (non-symlink) file at the `fake1` target path (same setup as
    `test_agents.py::test_remove_only_deletes_our_own`'s stray-file case),
    monkeypatch `app.notify` on the mounted instance to a list-appending
    stub before pressing `i`, assert no exception, `agents.status("fake1",
    "demo")` is unchanged (`"conflict"`), and the recorded notification
    text mentions the skill name (proves the previously-silent failure is
    now visible).

### Success Criteria
**Automated**: `uv run pytest -q` — all pass.

**Manual**: `uv run agentic-hub` against the real skill set — move across a
row, `i`/`r` a single agent cell and watch only that column change with a
toast; `I`/`R` from any column flips the whole row with one toast; trigger a
real conflict (e.g. `touch ~/.claude/skills/<some-skill>` first) and confirm
an error toast appears instead of a silent no-op.

### What We're NOT Doing
- No confirmation modal before remove — symlink/generated-file operations
  are cheap and reversible by reinstalling; add one if removal ever becomes
  destructive (e.g. deletes real content).
- No change to `cli.py`'s scripting subcommands (`list`/`install`/`remove`/
  `sync`) — this phase is `tui.py`-only.

---

## Phase 3 — Multi-select, filter, detail panel, manual refresh ✅ done (used `CellHighlighted`, not `RowHighlighted`, since `cursor_type="cell"` doesn't fire row-highlight events)

### Overview
Round out the TUI with the remaining requested functionality, all built on
widgets/messages already shipped by Textual.

### Changes
- `src/agentic_hub/tui.py`:
  - `from textual.containers import Horizontal`; `from textual.widgets import
    DataTable, Footer, Header, Input, Static`.
  - `compose()`:
    ```
    yield Header()
    yield Input(placeholder="filter skills…", id="filter")
    with Horizontal(id="body"):
        yield DataTable()
        yield Static(id="detail")
    yield Footer()
    yield Static(id="empty-state")
    ```
    (`id="filter"` starts `display: none` via `CSS`; `id="detail"` is a
    fixed-width side panel via `CSS`.)
  - `CSS = """#filter { dock: top; display: none; } #body { height: 1fr; }
    #detail { width: 32; border: round $primary; padding: 1; }"""`.
  - `self._selected: set[str] = set()` — multi-select state.
  - `self._filter: str = ""` — current filter substring (lowercased).
  - `refresh_table()`: filter with
    `[n for n in catalog.discover_skills() if self._filter in n.lower()]`
    (empty filter matches everything, no special-casing needed); prefix the
    `Skill` cell with `"[x] "` if `name in self._selected` else `"[ ] "`.
    Empty-state text distinguishes "no skills at all" vs "none match
    filter '<x>'".
  - `action_toggle_select()` (bound to `space`) — toggle the cursor's skill
    name in `self._selected`, `refresh_table()`.
  - `_run()` (Phase 2) gains: `names = sorted(self._selected) or [name]`
    up front, loops `_apply` per name, aggregates `ok`/`total` across all
    `(name, agent)` pairs for one summary toast, then
    `self._selected.clear()` before the final `refresh_table()` — bulk
    action always clears selection, single-item path is a no-op clear.
  - `action_toggle_filter()` (bound to `/`) — show + focus `#filter` if
    hidden; if already visible, hide it, clear it, refocus the table.
  - `on_input_changed(event)` (for `#filter`) — `self._filter =
    event.value.strip().lower()`; `refresh_table()`.
  - `on_input_submitted`/`key="escape"` handling on the filter input —
    hide + clear + refocus table (mirrors `action_toggle_filter`'s close
    path).
  - `on_data_table_row_highlighted(event: DataTable.RowHighlighted)` —
    `self._update_detail(event.row_key.value)`.
  - `_update_detail(name: str) -> None` — read
    `(catalog.SKILLS_DIR / name / "SKILL.md").read_text()`,
    `fm, _ = catalog.parse_frontmatter(text)`, set `#detail`'s renderable to
    `f"[b]{name}[/]\n\n{fm.get('description', '(no description)')}"`.
  - `action_refresh()` (bound to `ctrl+r`) — `self.refresh_table()`;
    `self.notify("rescanned skills/")`.
  - `BINDINGS` gains `space`→toggle_select, `/`→toggle_filter,
    `ctrl+r`→refresh.
- `README.md`: replace the bare-invocation usage line with the final
  binding set (`i`/`r` cell, `I`/`R` all agents, `space` select, `/`
  filter, `ctrl+r` refresh, `ctrl+p` theme, `q` quit).

### Tests
- `tests/test_tui.py`:
  - `test_space_selects_and_bulk_action_applies_to_all_selected()` — two
    skills, cursor on the first, `space`, `down`, `space`, `i`; assert both
    skills are `linked` on every fake agent and that the `Skill` column no
    longer shows the `[x]` marker (selection cleared) after the action.
  - `test_slash_filters_rows_by_substring()` — skills `alpha`/`beta`;
    press `/`, type `"al"` (via `pilot.press` per character or
    `input.value = "al"` + posting `Input.Changed`), assert
    `table.row_count == 1` and the visible row is `alpha`; press `escape`,
    assert both rows return.
  - `test_detail_panel_reflects_highlighted_skill()` — skill with
    `description: test demo` in frontmatter; assert `#detail`'s text
    contains `"test demo"` right after mount (row 0 auto-highlighted);
    `down` to a second skill, assert the panel text changes to match.
  - `test_ctrl_r_picks_up_a_skill_added_after_mount()` — mount with 1
    skill, create a second skill directory directly on disk (bypassing the
    app), press `ctrl+r`, assert `table.row_count == 2` — proves it's a
    real rescan, not relying on any cache.

### Success Criteria
**Automated**: `uv run pytest -q` — all pass, full suite green.

**Manual**: `uv run agentic-hub` — select two skills with `space`, bulk
install with `i`, confirm both flip and selection markers clear; `/`
+ typing narrows the grid live, `escape` restores it; moving the cursor
updates the description panel; add a new `skills/<name>/SKILL.md` on disk
while the TUI is open, `ctrl+r`, confirm it appears without restarting.

### What We're NOT Doing
- No fuzzy matching for the filter — plain case-insensitive substring, add
  fuzzy scoring only if plain substring proves too limiting in practice.
- No persistence of the filter text or selection across restarts (only the
  theme choice persists, per the resolved scope in Context).
- No agent-column filtering/hiding — all 4 agent columns always show; add a
  column toggle only if a 5th agent ever makes the grid too wide.
