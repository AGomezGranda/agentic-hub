---
date: 2026-09-19
title: Migrate skill-installer into agentic-hub, split into modules, add a Textual TUI
status: draft
---

## Context

`skill-installer` (`/Users/alvaro.gomez/code/skill-installer`) is a single-file
`install.py` (argparse CLI) that symlinks `skills/<name>/` into Claude
Code/Pi/OpenCode's skill dirs and flattens skills into Codex prompt files.
`agentic-hub` is a fresh `uv`-managed scaffold (`src/agentic_hub/`, `uv_build`
backend, `[project.scripts] agentic-hub = "agentic_hub:main"`).

Verified before writing this plan:
- `uv_build` packages non-`.py` files under `src/<pkg>/` into the wheel
  (checked with a throwaway `uv build` + wheel listing), so skill content can
  live at `src/agentic_hub/skills/` and still ship if the tool is ever
  installed rather than run from checkout.
- Every real symlink today (`~/.claude/skills/*`, `~/.pi/agent/skills/*`,
  `~/.config/opencode/skill/*`, 7 skills × 3 agents = 21 links) and every
  generated Codex prompt (7 files in `~/.codex/prompts/`) points at
  `skill-installer/skills/...`. Migrating the source without re-pointing
  these leaves the agents reading a location we're about to delete.

Decisions confirmed with the user:
- Delete the migrated files from `skill-installer` once the cutover is
  verified; leave a one-line README pointer instead of two live copies of
  the same source. `skill-installer` isn't under version control and that's
  fine — the deletion is safe as long as the migration is verified correct
  first, so it's the last step of Phase 2 (gated on a content diff, not on
  git history).
- Bare `agentic-hub` (no subcommand) launches the TUI; `list/install/remove/
  sync` keep working unchanged for scripting.

## Implementation Phases

1. Restructure + migrate — split `install.py` into `catalog.py`/`agents.py`/
   `cli.py`, move `skills/` into the package, port tests to pytest. No real
   machine state touched.
2. Cutover — relink the real, already-installed symlinks/prompts at the new
   source, then retire the duplicated source in `skill-installer`.
3. TUI — add a Textual status/install/remove grid as the default entry point.

---

## Phase 1 — Restructure + migrate

### Overview
Split the single `install.py` into three modules by responsibility (reading
skill sources vs. writing agent targets vs. CLI wiring), move `skills/` into
the package so it's data the package ships with, and port the existing test
suite to pytest instead of its hand-rolled runner.

### Changes
- `src/agentic_hub/skills/` — copy the 7 existing skill directories verbatim
  from `skill-installer/skills/` (`code-quality-audit`, `create-plan`,
  `implement-plan`, `remove-comment-slop`, `research-codebase`,
  `review-plan`, `testing-strategy`), including `testing-strategy`'s extra
  `AUDIT_STRATEGY.md`.
- `src/agentic_hub/catalog.py` — `SKILLS_DIR`, `discover_skills()`,
  `parse_frontmatter(text)`, moved verbatim from `install.py`.
- `src/agentic_hub/agents.py` — `AGENTS`, `CODEX_MARKER`, `target_path()`,
  `is_our_codex_file()`, `status()`, `install_one()`, `remove_one()`, moved
  verbatim except: import `catalog` as a module (`from . import catalog`,
  use `catalog.SKILLS_DIR`) rather than `from .catalog import SKILLS_DIR`,
  so tests can monkeypatch `catalog.SKILLS_DIR` after import — mirrors how
  the original test suite reassigned `install.SKILLS_DIR` directly.
  `CODEX_MARKER` becomes `<!-- agentic-hub: generated, do not edit -->`
  (renamed now, while nothing real points at it yet — see Phase 2 for why
  this matters for the cutover).
- `src/agentic_hub/cli.py` — `pick_interactive()`, `report()`,
  `resolve_agents()`, `cmd_list/cmd_install/cmd_remove/cmd_sync`,
  `build_parser()`, `main()`, moved verbatim, importing from
  `.catalog`/`.agents` (module-qualified, e.g. `catalog.SKILLS_DIR`, same
  reason as `agents.py` above). Logger name becomes `"agentic-hub"`,
  `ArgumentParser(prog=...)` becomes `"agentic-hub"`.
- `src/agentic_hub/__init__.py` — trimmed to empty (drop the placeholder
  `Hello from agentic-hub!` `main()`).
- `pyproject.toml` — `[project.scripts] agentic-hub = "agentic_hub.cli:main"`;
  `uv add --dev pytest`.
- Delete nothing in `skill-installer` yet (that's Phase 2, after the cutover
  is verified).

### Tests
Unit only, fast, no fixtures/framework beyond pytest's built-in `tmp_path`.

- `tests/test_catalog.py`
  - `discover_skills()` finds a dir with `SKILL.md`, ignores a sibling dir
    without one.
  - `parse_frontmatter()` splits a `---\n...\n---\nbody` doc into the dict +
    body; returns `({}, original_text)` unchanged when there's no leading
    `---` (edge case: a skill file with no frontmatter shouldn't crash).
- `tests/test_agents.py` — port the 3 existing scenarios from
  `test_install.py` as plain pytest functions using the `tmp_path` fixture
  directly (delete the hand-rolled `tempfile.TemporaryDirectory()` +
  manual test-list `main()`, since `tmp_path` already gives us that):
  - `test_install_symlinks_native_agents` — claude/pi/opencode get a real
    symlink resolving to source; `status()` reports `linked`.
  - `test_install_flattens_codex_prompt` — Codex prompt has the marker,
    keeps the body, drops the frontmatter.
  - `test_remove_only_deletes_our_own` — a stray symlink/file sharing a
    target name survives `remove_one`; removing something we don't own is a
    no-op, not an error.

### Success Criteria

**Automated**
- `uv run pytest -q` — all tests pass.
- `uv run agentic-hub list` — prints all 7 skills with per-agent status
  against the *real* agent dirs (expect `stale`/`missing` for
  claude/pi/opencode — the real links still point at `skill-installer`
  until Phase 2; expect `conflict` for `codex`, since the renamed
  `CODEX_MARKER` no longer matches the first line of the existing generated
  prompts — that's the correct, expected status here, not a bug).

**Manual**
- Skim `git diff` for `agents.py`/`catalog.py`/`cli.py` against the original
  `install.py` — confirm it's a mechanical split, no logic drift.

### What We're NOT Doing
- Not touching any real symlink/prompt file yet.
- Not deleting anything from `skill-installer` yet.
- Not changing CLI behavior (argparse stays, no TUI, no new subcommands).

---

## Phase 2 — Cutover

### Overview
Point the real, already-installed skill symlinks/prompts at the new source
in `agentic-hub`, verify it, then — as the last step, once verification
passes — retire the now-duplicated source in `skill-installer`.

### Changes
- Because `CODEX_MARKER` changed in Phase 1 (`skill-hub` → `agentic-hub`),
  the 7 existing generated files in `~/.codex/prompts/` won't match the new
  marker, and `install_one` treats a mismatched file as foreign (refuses to
  overwrite). Before removing them, confirm they're actually our old
  generated files and not something hand-edited: `for f in
  code-quality-audit create-plan implement-plan remove-comment-slop
  research-codebase review-plan testing-strategy; do head -1
  ~/.codex/prompts/$f.md; done` — every line should read
  `<!-- skill-hub: generated, do not edit -->` (the *old* marker). Only then
  remove them: `rm ~/.codex/prompts/{code-quality-audit,create-plan,implement-plan,remove-comment-slop,research-codebase,review-plan,testing-strategy}.md`
- Run `uv run agentic-hub sync` from `agentic-hub` — relinks the 21 native
  symlinks (claude/pi/opencode × 7 skills) to
  `.../agentic-hub/src/agentic_hub/skills/<name>` (stale-relink path in
  `install_one` handles this automatically) and regenerates the 7 Codex
  prompts with the new marker.

### Tests
No new code, no new unit tests — this phase is a one-time operational
cutover. Verified via the success criteria below.

### Success Criteria

**Automated**
- `for f in code-quality-audit create-plan implement-plan remove-comment-slop research-codebase review-plan testing-strategy; do readlink ~/.claude/skills/$f ~/.pi/agent/skills/$f ~/.config/opencode/skill/$f; done` — all 21 paths resolve under `.../agentic-hub/src/agentic_hub/skills/`.
- `head -1 ~/.codex/prompts/create-plan.md` (spot-check, and the other 6) equals the new `CODEX_MARKER`.
- `uv run agentic-hub list` (from `agentic-hub`) — all 7 skills show `linked` for all 4 agents.

**Manual**
- Open a fresh Pi/Claude Code session and confirm a migrated skill (e.g.
  `create-plan`) still loads and reads correctly — sanity check that the
  file split in Phase 1 didn't silently break frontmatter parsing or content.

### Cleanup — retire `skill-installer` (only after every Success Criteria above passes)
`skill-installer` has no git history, so this step is a one-way delete —
that's acceptable precisely because it only runs after the checks above
confirm the migration is complete and working, not because it's recoverable
if something was missed.
- `diff -r skill-installer/skills agentic-hub/src/agentic_hub/skills` — must
  print nothing. If it prints a difference, the source drifted after the
  Phase 1 copy; re-copy the changed file(s) into `agentic-hub` before
  continuing, don't delete yet.
- Delete `skills/`, `install.py`, `test_install.py`, `DESIGN.md` in
  `skill-installer`; replace its `README.md` with a one-line pointer to
  `agentic-hub`.
- Confirm `skill-installer` no longer has `skills/`/`install.py`/
  `test_install.py`/`DESIGN.md`, and its `README.md` points at `agentic-hub`.

### What We're NOT Doing
- Not touching the unrelated `risk-ai-infra`-sourced symlinks already in
  `~/.claude/skills` (different source repo, out of scope).
- Not adding new skill content in this phase.
- Not adding a git safety net (`git init`/backup copy) to `skill-installer`
  before deleting — the diff check above is the actual correctness gate;
  a copy of already-migrated files would just be dead weight.

---

## Phase 3 — TUI

### Overview
Add a Textual app as the default `agentic-hub` entry point: a status grid
(skill × agent) with install/remove key bindings, built entirely on top of
`agents.py`/`catalog.py` — no duplicated install/remove/status logic.

### Changes
- `uv add textual`.
- `src/agentic_hub/tui.py`:
  - `AgenticHubApp(App)` — on mount, populate a `DataTable` with one row per
    `catalog.discover_skills()` result; columns are `Skill` + one per
    `agents.AGENTS` key; cells from `agents.status(agent, name)`.
  - `refresh_table()` — re-reads status for every visible row; called after
    every install/remove so the grid never shows stale state.
  - Bindings: `i` install the cursor row to all agents, `r` remove the
    cursor row from all agents, `q` quit. No multi-select in this MVP.
- `src/agentic_hub/cli.py`:
  - `build_parser()` gains a `tui` subcommand (calls into `tui.run()`).
  - Subparsers become non-required; `main()` dispatches to the `tui`
    subcommand when no subcommand is given (bare `agentic-hub`), instead of
    argparse's current "error: required" behavior.
- `pyproject.toml` — `agentic-hub = "agentic_hub.cli:main"` stays as-is (TUI
  is reached through the same entry point, not a second console script).

### Tests
One smoke test — the smallest thing that fails if row population or key
dispatch breaks, not a full Textual snapshot suite.

- `tests/test_tui.py` (sync `def`, wraps `asyncio.run(...)` internally —
  avoids adding `pytest-asyncio` for one test):
  - Monkeypatch `catalog.SKILLS_DIR`/`agents.AGENTS` to a temp fixture with
    one fake skill and one fake agent (same pattern as `test_agents.py`).
  - Mount the app via `App.run_test()` (Pilot); assert the table has 1 row
    and the expected agent column.
  - Press `i`; assert `agents.status()` now returns `linked` for the fake
    agent and the table cell reflects it.
  - Press `r`; assert back to `missing`.
  - Edge case: zero discovered skills — mount with an empty `SKILLS_DIR`,
    assert the table renders with 0 rows and `i`/`r` don't raise.
- `tests/test_cli.py` — the dispatch branch is new logic, not a port, so it
  needs its own test independent of `test_tui.py` mounting `tui.py`
  directly: monkeypatch `tui.run` to a stub, call `main([])`, assert the
  stub was called; call `main(["list"])` against a fixture and assert it
  still dispatches to `cmd_list` (subparsers becoming non-required
  shouldn't change existing subcommand behavior).

### Success Criteria

**Automated**
- `uv run pytest -q` — includes `test_tui.py` and `test_cli.py`, all pass.

**Manual**
- `uv run agentic-hub` (bare, real machine) — TUI launches, shows all 7
  skills × 4 agents as `linked`, toggle one off with `r` and back on with
  `i` and watch the grid update live, `q` exits cleanly back to the shell.

### What We're NOT Doing
- No multi-select/batch actions across rows.
- No agent-filter UI, no in-TUI skill authoring/editing.
- No config file for TUI theme/keybindings.
- Add any of the above only if the MVP actually feels limiting in use.

---

## PR Strategy

Three phases, three units, in this order:
1. **Phase 1** as one PR in `agentic-hub` — pure refactor + migration-prep,
   safe and revertable, touches no real machine state.
2. **Phase 2** as a small follow-up: the `sync` run itself isn't a commit;
   the `skill-installer` cleanup (deletion + README pointer) happens last,
   only after Phase 2's success criteria pass, as its own change in *that*
   repo (separate from `agentic-hub`'s history). `skill-installer` has no
   git history, so this isn't independently revertable — that's accepted,
   since the diff check in Phase 2's Cleanup step is what guarantees
   nothing is lost, not version control.
3. **Phase 3** as one PR in `agentic-hub` — purely additive, no dependency
   on Phase 2 having happened first (could technically ship before Phase 2,
   but do it after so the TUI is exercised against real, linked data during
   manual verification).
