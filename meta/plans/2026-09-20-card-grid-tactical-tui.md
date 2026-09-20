---
date: 2026-09-20
title: Card-grid, tactical-themed TUI (replace the DataTable skin)
status: draft
---

## Context

`agentic-hub` is a **terminal** app (Textual 8.2.8), not a web app — "cooler,
modern, different" means a different Textual layout idiom, not web visuals.
Verified while reading the current code:

- `src/agentic_hub/tui.py` widget tree (`compose()`): `Header()` →
  `Input(id="filter")` (hidden until `/`) → `Static(id="empty-state")` →
  `Horizontal(id="body")` containing a `DataTable` (column 0 = `"skill"`,
  one column per `agents.AGENTS` key) and `Static(id="detail")` → `Footer()`.
- `STATUS_GLYPHS` (`tui.py:13-18`) maps the 4 `agents.Status` literals to
  `(glyph, rich style)`; `render_status()` turns one into a `rich.text.Text`.
- `_cursor_cell()` (`tui.py:112-120`) reads `table.coordinate_to_cell_key(
  table.cursor_coordinate)` to get `(skill name, column key)`; `_run()`
  (`tui.py:132-...`) is the single install/remove engine keyed off that pair
  — `col == "skill"` (column 0) or `force_all` targets every agent, any
  other column targets just that agent. This pair-based contract is worth
  preserving byte-for-byte since every binding (`i`/`r`/`I`/`R`) and the
  multi-select bulk path route through it.
- Theme persistence: `_THEME_FILE = ~/.config/agentic-hub/theme.txt`,
  `_load_theme()`/`_save_theme()`, subscribed via
  `self.theme_changed_signal.subscribe(...)` in `on_mount` — this survives
  untouched; only the *fallback* value changes (see Phase 2).
- `catalog.parse_frontmatter()` (`catalog.py:14-27`) already splits a
  `SKILL.md` into `(frontmatter dict, body str)`; the TUI today only ever
  reads `fm["description"]` (`tui.py`'s `_update_detail`) — `body` is parsed
  but unused, free upgrade material for Phase 3.
- `agents.AGENTS` (`agents.py:14-19`) has 4 entries today (`claude`, `pi`,
  `opencode`, `codex`); `skills/` has 7 entries today — small enough that a
  vertically-scrolling single column of cards is plenty, no need for
  multi-column packing (see Phase 1 non-goals).
- `tests/test_tui.py` is built entirely around `tui.DataTable` (`table.
  get_row_at`, `table.move_cursor`, `table.row_count`) — every test needs
  its widget-querying mechanics rewritten; the *behavior* each test asserts
  stays the same.
- Confirmed interactively against the installed Textual 8.2.8 (no version
  bump, no new dependency needed anywhere in this plan):
  - `textual.theme.Theme(name, primary, secondary=None, warning=None,
    error=None, success=None, accent=None, foreground=None, background=None,
    surface=None, panel=None, boost=None, dark=True, ...)` and
    `App.register_theme(theme)` exist and work together with the existing
    `self.theme = "<name>"` / command-palette theme picker.
  - `Widget.border_title`, `Widget.set_class()`, `Widget.remove_children()`,
    `Widget.scroll_visible()` all exist on every widget, including `Static`.
  - `App.BINDINGS` doesn't claim `up`/`down`/`left`/`right` (only `ctrl+q`/
    `ctrl+c`) — free to bind them ourselves once `DataTable`'s built-in
    cell-cursor navigation is gone.
  - `Markdown.update(markdown: str) -> AwaitComplete` works when called
    **without** `await` from a synchronous handler (fire-and-forget, same
    pattern as `self.notify()`) — confirmed by running it from
    `on_input_changed` and reading the result back after `pilot.pause()`.
    `Markdown`'s rendered child blocks are walkable/queryable via
    `md.walk_children()` + `.render()`, so it's just as testable as the
    `Static` it replaces.

Decisions resolved with the user (no open questions remain):
1. Layout: card grid (one bordered card per skill, agent statuses as
   badges inside it) — keeps the "whole matrix at a glance" property of
   today's table, restyled.
2. Every current keybinding's *semantics* is preserved exactly
   (`i`/`r`/`I`/`R`/`space`/`/`/`ctrl+r`/`ctrl+p`); only click-to-sort has
   no card equivalent (no header row) — replaced by `s`/`S` keybindings
   (cycle sort field / flip direction).
3. Visual language: Palantir/military/command-center — dark background,
   one strong accent color, square/heavy borders (not rounded), a
   HUD-style live stats strip. Exact hex values are a starting point, not
   a locked-in choice — the existing `ctrl+p` theme picker still lists
   every other builtin theme, so a "wrong" color call here isn't a dead
   end (see Phase 2 non-goals).
4. New tactical theme becomes the **default only for fresh installs** with
   no `~/.config/agentic-hub/theme.txt` yet; anyone who already picked a
   theme keeps it.

## Implementation Phases

1. Card-grid engine — replace `DataTable` with a scrollable column of
   skill cards and an app-owned 2D cursor, zero visual polish, full
   behavior parity with today.
2. Tactical visual language — dark theme, square borders, stats strip,
   `s`/`S` sort.
3. Preview panel upgrade — `Markdown` widget rendering the full
   `SKILL.md` body instead of just the one-line description.

---

## Phase 1 — Card-grid engine (behavior parity) ✅ done

### Overview
Swap the `DataTable` for a `VerticalScroll` of one card per skill, replacing
`DataTable`'s built-in cell cursor with app-owned `(row, col)` state so every
existing action keeps working unchanged.

### Changes
- `src/agentic_hub/tui.py`:
  - Drop `DataTable` import; add `from textual.containers import Horizontal,
    VerticalScroll` and `from textual.widgets import Footer, Header, Input,
    Static` (no `DataTable`).
  - New state in `__init__`: `self._cursor_row = 0`, `self._cursor_col = 0`
    (`0` = "skill"/all-agents, `1..len(agents.AGENTS)` = that agent),
    `self._visible: list[str] = []` (the currently rendered, filtered order
    — needed so `_cursor_row` maps to a name).
  - `compose()`: `Header()`, `Input(id="filter")`, `Static(id="empty-state")`,
    `Horizontal(id="body")` containing `VerticalScroll(id="grid")` and
    `Static(id="detail")`, `Footer()`.
  - `refresh_grid()` (renamed from `refresh_table`): recompute `self._visible`
    from `catalog.discover_skills()` filtered by `self._filter` (unchanged
    substring logic); clamp `_cursor_row` to `range(len(self._visible))` and
    `_cursor_col` to `range(len(agents.AGENTS) + 1)`; `grid.remove_children()`
    then mount one `_render_card(name, index)` per visible skill; update
    `#empty-state` exactly as today; call `_sync_detail()`.
  - `_render_card(name: str, index: int) -> Static`: build a
    `Static(id=f"card-{name}")` with CSS class `card`, plus `-focused` if
    `index == self._cursor_row`, plus `-selected` if `name in
    self._selected`; `card.border_title = ("[x] " if name in self._selected
    else "[ ] ") + name`; `card.update(...)` with a `rich.text.Text` built
    from: the frontmatter `description` (via `catalog.parse_frontmatter`,
    same read `_update_detail` already does), a blank line, then one
    `render_status(agents.status(agent, name))` span per agent joined with
    `"  "`, each prefixed with the agent name; the span at
    `agent_index == self._cursor_col - 1` gets `style="reverse"` appended
    when `index == self._cursor_row` (the visible cursor).
  - `_cursor_cell() -> tuple[str, str] | None`: `if not self._visible: return
    None`; `name = self._visible[self._cursor_row]`; `col = "skill" if
    self._cursor_col == 0 else list(agents.AGENTS)[self._cursor_col - 1]`;
    return `(name, col)` — same shape `_run()` already expects, so `_run()`,
    `action_install`, `action_remove`, `action_install_all`,
    `action_remove_all`, `action_toggle_select` need **no changes**.
  - `action_cursor_up/down/left/right` (new): adjust `_cursor_row` (up/down)
    or `_cursor_col` (left/right) with clamping, call
    `self.query_one(f"#card-{self._visible[self._cursor_row]}").
    scroll_visible()`, then `refresh_grid()`.
  - `_sync_detail()`/`_update_detail()`: keyed off
    `self._visible[self._cursor_row]` instead of `DataTable.ordered_rows`.
  - Remove `on_data_table_header_selected` and `on_data_table_cell_highlighted`
    (DataTable-only events) and the `_sort_reverse` dict (sort moves to
    Phase 2's single cycling control).
  - `BINDINGS` gains `up`/`down`/`left`/`right` → the four new actions
    (`show=False`, self-explanatory, not worth `Footer` space).
  - `CSS` gains: `.card { border: round $panel; margin: 0 1; padding: 0 1;
    height: auto; } .-focused { border: heavy $accent; } .-selected {
    background: $accent 10%; } #grid { height: 1fr; }`.
- `README.md`: no change (bindings list unchanged; arrow-key navigation is
  self-evident).

### Tests
- `tests/test_tui.py` — same scenarios as today, rewritten mechanics:
  - Helper `def card(app, name): return app.query_one(f"#card-{name}",
    tui.Static)`; assertions read `str(card(app, "demo").render())` instead
    of `table.get_row_at(0)`.
  - Cursor moves via direct state (`app._cursor_row = 1; app._cursor_col =
    2; app.refresh_grid()`) instead of `table.move_cursor(...)` — same
    trust level as today's tests already poking `agents.status(...)`
    directly.
  - Every existing test carries over 1:1 with these mechanical swaps:
    `test_table_shows_rows_and_agent_column`,
    `test_install_and_remove_bindings_update_status_and_table`,
    `test_zero_skills_renders_empty_table_and_bindings_dont_raise`,
    `test_empty_state_placeholder_shown/hidden_...`,
    `test_cell_level_i_r_target_only_the_cursor_agent`,
    `test_shift_i_r_always_target_all_agents`,
    `test_column_zero_i_targets_all_agents`,
    `test_space_selects_and_bulk_action_applies_to_all_selected`,
    `test_slash_filters_rows_by_substring`,
    `test_detail_panel_reflects_highlighted_skill`,
    `test_ctrl_r_picks_up_a_skill_added_after_mount`,
    `test_failed_action_notifies_without_crashing`.
  - `test_status_glyphs_cover_every_status` — unchanged, pure function.
  - New: `test_cursor_arrow_keys_move_and_clamp()` — 2 skills × 2 fake
    agents; `pilot.press("down")` → `_cursor_row == 1`; press again →
    still `1` (clamped); `pilot.press("right")` ×4 → `_cursor_col` clamps
    at `len(agents.AGENTS)`.

### Success Criteria
**Automated**: `uv run pytest -q` — all pass.

**Manual**: `uv run agentic-hub` — arrow keys move a visible focus
indicator across skills and agent badges; `i`/`r`/`I`/`R`/`space`/`/`/
`ctrl+r`/`ctrl+p` all behave exactly as before, just on cards instead of
table rows/columns.

### What We're NOT Doing
- No responsive multi-column card packing — a single scrolling column.
  `# ponytail: single-column card list, add multi-column packing if the
  skill count grows enough that scrolling one column feels worse than
  paging across columns`.
- No mouse click targeting on cards (click-to-select, click-to-sort) —
  not requested; `s`/`S` cover sorting in Phase 2.

---

## Phase 2 — Tactical visual language ✅ done

### Overview
Give the card grid the Palantir/military/command-center look: dark palette,
square borders, a live HUD stats strip, and a keyboard-driven sort control
replacing the old click-to-sort header.

### Changes
- `src/agentic_hub/tui.py`:
  - `TACTICAL_THEME = Theme(name="tactical", primary="#33ff99",
    secondary="#1a8f5c", accent="#ffb000", warning="#ffb000",
    error="#ff4444", success="#33ff99", foreground="#c8ffe0",
    background="#05080a", surface="#0a1210", panel="#101c18", dark=True)`
    — dark near-black base, one green primary + amber accent for
    focus/warnings, matching the existing `STATUS_GLYPHS` colors (green
    linked, yellow/amber stale, red conflict) so nothing clashes.
  - `on_mount`: `self.register_theme(TACTICAL_THEME)` before `self.theme =
    _load_theme()`; `_load_theme()`'s fallback changes from
    `"textual-dark"` to `"tactical"` (only affects a missing/unreadable
    `theme.txt` — an existing saved choice is untouched).
  - `_SORT_FIELDS = ("name", *agents.AGENTS)`; new state `self._sort_index =
    0`, `self._sort_reverse = False`.
  - `refresh_grid()`'s visible-list step gains a sort: `sorted(names, key=
    lambda n: n if _SORT_FIELDS[self._sort_index] == "name" else
    agents.status(_SORT_FIELDS[self._sort_index], n), reverse=
    self._sort_reverse)`.
  - `action_cycle_sort()` (bound to `s`): `self._sort_index = (self.
    _sort_index + 1) % len(_SORT_FIELDS)`; `refresh_grid()`.
  - `action_flip_sort()` (bound to `S`, shift+s — mirrors the app's
    existing i/I, r/R shift convention): `self._sort_reverse = not self.
    _sort_reverse`; `refresh_grid()`.
  - `compose()` gains `Static(id="stats")` between the filter `Input` and
    `Horizontal(id="body")`.
  - `refresh_grid()` updates `#stats` with a `Counter` over `agents.
    status(agent, name) for name in self._visible for agent in
    agents.AGENTS`, rendered as e.g. `"SKILLS 7  LINKED 12  STALE 1
    MISSING 8  CONFLICT 0  SORT name  FILTER —"`.
  - `.card` CSS: `border: round $panel` → `border: heavy $panel`
    (square); `.-focused` stays `border: heavy $accent`.
  - `BINDINGS` gains `s` → cycle_sort, `S` → flip_sort (`show=True` — this
    is the discoverable replacement for the old mouse-only header-click
    sort).
- `README.md`: usage block gains `s`/`S` (cycle/flip sort).

### Tests
- `tests/test_tui.py`:
  - `test_default_theme_is_tactical_when_no_theme_file_exists()` — fresh
    `tmp_path`, no `theme.txt` written, mount, assert `app.theme ==
    "tactical"`.
  - `test_saved_theme_choice_is_not_overridden()` — pre-write `theme.txt`
    with `"nord"`, mount, assert `app.theme == "nord"` (regression guard
    on "existing users unaffected").
  - `test_s_cycles_sort_field_and_shift_s_flips_direction()` — skills/
    statuses picked so each sort field gives a distinguishable order;
    press `s` through all fields asserting `self._visible` order at each
    step; press `S`, assert the current order reverses.
  - `test_stats_strip_reflects_counts()` — after `i` installs one skill on
    one agent, assert `#stats`'s rendered text shows the incremented
    `LINKED` count.

### Success Criteria
**Automated**: `uv run pytest -q` — all pass.

**Manual**: delete `~/.config/agentic-hub/theme.txt` in a scratch config,
launch → tactical theme loads by default, square borders, stats strip
visible; `ctrl+p` still lists/switches every other builtin theme; `s`/`S`
visibly reorder the cards.

### What We're NOT Doing
- Not hand-tuning the exact palette beyond a reasonable starting point —
  it's swappable via the existing `ctrl+p` picker, so a "wrong" color call
  isn't a dead end.
- No animated/scanline/glow effects — outside what Textual CSS renders;
  the tactical feel comes from palette + square borders + the stats strip.

---

## Phase 3 — Preview panel upgrade (full `SKILL.md` body) ✅ done

### Overview
Swap the plain-text description panel for Textual's built-in `Markdown`
widget, showing each skill's full body — a bigger, richer "preview" (the
part the user already said they like), using a widget Textual ships today.

### Changes
- `src/agentic_hub/tui.py`:
  - `from textual.widgets import Markdown` added; `compose()`'s
    `Static(id="detail")` becomes `Markdown(id="detail")`.
  - `_update_detail(name: str)`: read `(catalog.SKILLS_DIR / name /
    "SKILL.md").read_text()`, `fm, body = catalog.parse_frontmatter(text)`,
    call `self.query_one("#detail", Markdown).update(f"# {name}\n\n{fm.get(
    'description', '')}\n\n{body}")` — **not** awaited (confirmed
    fire-and-forget works from a sync handler), so every existing sync call
    site (`_sync_detail`, arrow-key actions, `on_mount`) needs no `async`
    changes.
  - `CSS`: `#detail { width: 44; border: heavy $panel; padding: 1; }`
    (slightly wider so rendered headings/lists stay legible).
- `README.md`: no behavior change; optionally note the preview now shows
  the full skill body.

### Tests
- `tests/test_tui.py`:
  - `test_detail_panel_reflects_highlighted_skill()` (existing, updated):
    assert via `[str(c.render()) for c in app.query_one("#detail",
    tui.Markdown).walk_children()]` containing the expected text, instead
    of `Static.render()`.
  - `test_preview_shows_full_skill_body_not_just_description()`: a skill
    whose `SKILL.md` body has content beyond the one-line description;
    assert that content now appears in the panel's walked children (it
    didn't before this phase).

### Success Criteria
**Automated**: `uv run pytest -q` — all pass, full suite green.

**Manual**: `uv run agentic-hub` — select a skill with a multi-paragraph
`SKILL.md` body; confirm the preview renders real markdown (headings,
bold, lists), not just the one-line description.

### What We're NOT Doing
- Not making the preview interactive (no link-clicking, no scrolling
  beyond `Markdown`'s own default behavior) — read-only preview, same
  scope as today's panel.
