import asyncio
from pathlib import Path

import pytest

from agentic_hub import agents, catalog, tui


def make_skill(src_dir: Path, name: str) -> None:
    d = src_dir / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\ndescription: test {name}\n---\nBody.\n")


def setup_fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    with_skill: bool = True,
    multi_agent: bool = False,
) -> None:
    src = tmp_path / "skills"
    src.mkdir()
    monkeypatch.setattr(catalog, "SKILLS_DIR", src)
    fake_agents: dict[str, tuple[Path, agents.Mode]]
    if multi_agent:
        fake_agents = {
            "fake1": (tmp_path / "fake1", "symlink"),
            "fake2": (tmp_path / "fake2", "symlink"),
        }
    else:
        fake_agents = {"fake": (tmp_path / "fake", "symlink")}
    monkeypatch.setattr(agents, "AGENTS", fake_agents)
    monkeypatch.setattr(tui, "_THEME_FILE", tmp_path / "theme.txt")
    if with_skill:
        make_skill(src, "demo")


def test_table_shows_rows_and_agent_column(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test():
            table = app.query_one(tui.DataTable)
            assert table.row_count == 1
            row = table.get_row_at(0)
            assert row[0] == "[ ] demo"
            assert str(row[1]) == "\u00b7 missing"

    asyncio.run(scenario())


def test_install_and_remove_bindings_update_status_and_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)

            await pilot.press("i")
            assert agents.status("fake", "demo") == "linked"
            assert str(table.get_row_at(0)[1]) == "\u2713 linked"

            await pilot.press("r")
            assert agents.status("fake", "demo") == "missing"
            assert str(table.get_row_at(0)[1]) == "\u00b7 missing"

    asyncio.run(scenario())


def test_zero_skills_renders_empty_table_and_bindings_dont_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)
            assert table.row_count == 0

            await pilot.press("i")
            await pilot.press("r")
            assert table.row_count == 0

    asyncio.run(scenario())


def test_status_glyphs_cover_every_status() -> None:
    for status in ("linked", "stale", "missing", "conflict"):
        glyph, style = tui.STATUS_GLYPHS[status]
        assert glyph and style


def test_empty_state_placeholder_shown_only_when_no_skills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test():
            placeholder = app.query_one("#empty-state")
            assert placeholder.display is True
            assert str(catalog.SKILLS_DIR) in str(placeholder.render())

    asyncio.run(scenario())


def test_empty_state_placeholder_hidden_when_skills_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test():
            placeholder = app.query_one("#empty-state")
            assert placeholder.display is False

    asyncio.run(scenario())


def test_cell_level_i_r_target_only_the_cursor_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)
            table.move_cursor(row=0, column=2)  # fake2 column

            await pilot.press("i")
            assert agents.status("fake2", "demo") == "linked"
            assert agents.status("fake1", "demo") == "missing"

            await pilot.press("r")
            assert agents.status("fake2", "demo") == "missing"
            assert agents.status("fake1", "demo") == "missing"

    asyncio.run(scenario())


def test_shift_i_r_always_target_all_agents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)
            table.move_cursor(row=0, column=2)  # fake2 column

            await pilot.press("I")
            assert agents.status("fake1", "demo") == "linked"
            assert agents.status("fake2", "demo") == "linked"

            await pilot.press("R")
            assert agents.status("fake1", "demo") == "missing"
            assert agents.status("fake2", "demo") == "missing"

    asyncio.run(scenario())


def test_column_zero_i_targets_all_agents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("i")
            assert agents.status("fake1", "demo") == "linked"
            assert agents.status("fake2", "demo") == "linked"

    asyncio.run(scenario())


def test_space_selects_and_bulk_action_applies_to_all_selected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)
    make_skill(catalog.SKILLS_DIR, "second")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)
            await pilot.press("space")
            await pilot.press("down")
            await pilot.press("space")
            await pilot.press("i")

            assert agents.status("fake1", "demo") == "linked"
            assert agents.status("fake2", "demo") == "linked"
            assert agents.status("fake1", "second") == "linked"
            assert agents.status("fake2", "second") == "linked"

            for row_index in range(table.row_count):
                assert not str(table.get_row_at(row_index)[0]).startswith("[x]")

    asyncio.run(scenario())


def test_slash_filters_rows_by_substring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True, with_skill=False)
    make_skill(catalog.SKILLS_DIR, "alpha")
    make_skill(catalog.SKILLS_DIR, "beta")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)
            assert table.row_count == 2

            await pilot.press("/")
            await pilot.press("a")
            await pilot.press("l")
            assert table.row_count == 1
            assert table.get_row_at(0)[0] == "[ ] alpha"

            await pilot.press("escape")
            assert table.row_count == 2

    asyncio.run(scenario())


def test_detail_panel_reflects_highlighted_skill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True, with_skill=False)
    make_skill(catalog.SKILLS_DIR, "alpha")
    make_skill(catalog.SKILLS_DIR, "beta")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            detail = app.query_one("#detail")
            assert "test alpha" in str(detail.render())

            await pilot.press("down")
            assert "test beta" in str(detail.render())

    asyncio.run(scenario())


def test_ctrl_r_picks_up_a_skill_added_after_mount(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            table = app.query_one(tui.DataTable)
            assert table.row_count == 1

            make_skill(catalog.SKILLS_DIR, "second")
            await pilot.press("ctrl+r")
            assert table.row_count == 2

    asyncio.run(scenario())


def test_failed_action_notifies_without_crashing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)
    conflict_dir = tmp_path / "fake1" / "demo"
    conflict_dir.mkdir(parents=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            notifications: list[tuple[tuple[str, ...], dict[str, object]]] = []
            monkeypatch.setattr(
                app, "notify", lambda *a, **k: notifications.append((a, k))
            )

            table = app.query_one(tui.DataTable)
            table.move_cursor(row=0, column=1)  # fake1 column
            await pilot.press("i")

            assert agents.status("fake1", "demo") == "conflict"
            assert notifications
            assert "demo" in notifications[-1][0][0]

    asyncio.run(scenario())
