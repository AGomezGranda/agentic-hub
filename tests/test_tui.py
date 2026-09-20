import asyncio
from pathlib import Path

import pytest
from textual.widgets.markdown import MarkdownBlock

from agentic_hub import agents, catalog, tui


def make_skill(src_dir: Path, name: str) -> None:
    d = src_dir / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\ndescription: test {name}\n---\nBody.\n")


def card(app: tui.AgenticHubApp, name: str) -> tui.Static:
    return app.query_one(f"#card-{name}", tui.Static)


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
            assert app._visible == ["demo"]
            rendered = str(card(app, "demo").render())
            assert "\u00b7 missing" in rendered

    asyncio.run(scenario())


def test_install_and_remove_bindings_update_status_and_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("i")
            assert agents.status("fake", "demo") == "linked"
            assert "\u2713 linked" in str(card(app, "demo").render())

            await pilot.press("r")
            assert agents.status("fake", "demo") == "missing"
            assert "\u00b7 missing" in str(card(app, "demo").render())

    asyncio.run(scenario())


def test_zero_skills_renders_empty_table_and_bindings_dont_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert app._visible == []

            await pilot.press("i")
            await pilot.press("r")
            assert app._visible == []

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
            app._cursor_row = 0
            app._cursor_col = 2  # fake2 column
            await app.refresh_grid()

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
            app._cursor_row = 0
            app._cursor_col = 2  # fake2 column
            await app.refresh_grid()

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
            await pilot.press("space")
            await pilot.press("down")
            await pilot.press("space")
            await pilot.press("i")

            assert agents.status("fake1", "demo") == "linked"
            assert agents.status("fake2", "demo") == "linked"
            assert agents.status("fake1", "second") == "linked"
            assert agents.status("fake2", "second") == "linked"

            for name in app._visible:
                assert not str(card(app, name).border_title).startswith("[x]")

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
            assert app._visible == ["alpha", "beta"]

            await pilot.press("/")
            await pilot.press("a")
            await pilot.press("l")
            assert app._visible == ["alpha"]

            await pilot.press("escape")
            assert app._visible == ["alpha", "beta"]

    asyncio.run(scenario())


def detail_text(app: tui.AgenticHubApp) -> list[str]:
    detail = app.query_one("#detail", tui.Markdown)
    return [str(c.render()) for c in detail.walk_children(MarkdownBlock)]


def test_detail_panel_reflects_highlighted_skill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True, with_skill=False)
    make_skill(catalog.SKILLS_DIR, "alpha")
    make_skill(catalog.SKILLS_DIR, "beta")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("p")
            assert any("test alpha" in t for t in detail_text(app))

            await pilot.press("down")
            assert any("test beta" in t for t in detail_text(app))

    asyncio.run(scenario())


def test_preview_hidden_by_default_and_toggles_with_p(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True, with_skill=False)
    make_skill(catalog.SKILLS_DIR, "alpha")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert app.query_one("#detail", tui.Markdown).display is False

            await pilot.press("p")
            assert app.query_one("#detail", tui.Markdown).display is True

            await pilot.press("p")
            assert app.query_one("#detail", tui.Markdown).display is False

    asyncio.run(scenario())


def test_preview_shows_full_skill_body_not_just_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)
    d = catalog.SKILLS_DIR / "demo"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\ndescription: test demo\n---\n\nExtra body paragraph.\n"
    )

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("p")
            assert any("Extra body paragraph." in t for t in detail_text(app))

    asyncio.run(scenario())


def test_detail_pane_survives_folded_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)
    d = catalog.SKILLS_DIR / "demo"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\ndescription: >\n  line one\n  line two\n---\n\nBody.\n"
    )

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("p")  # must not raise

    asyncio.run(scenario())


def test_ctrl_r_picks_up_a_skill_added_after_mount(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert app._visible == ["demo"]

            make_skill(catalog.SKILLS_DIR, "second")
            await pilot.press("ctrl+r")
            assert app._visible == ["demo", "second"]

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

            app._cursor_row = 0
            app._cursor_col = 1  # fake1 column
            await app.refresh_grid()
            await pilot.press("i")

            assert agents.status("fake1", "demo") == "conflict"
            assert notifications
            assert "demo" in notifications[-1][0][0]

    asyncio.run(scenario())


def test_cursor_arrow_keys_move_and_clamp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True, with_skill=False)
    make_skill(catalog.SKILLS_DIR, "alpha")
    make_skill(catalog.SKILLS_DIR, "beta")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert app._cursor_row == 0

            await pilot.press("down")
            assert app._cursor_row == 1
            await pilot.press("down")
            assert app._cursor_row == 1  # clamped at last row

            for _ in range(4):
                await pilot.press("right")
            assert app._cursor_col == len(agents.AGENTS)

    asyncio.run(scenario())


def test_default_theme_is_tactical_when_no_theme_file_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test():
            assert app.theme == "tactical"

    asyncio.run(scenario())


def test_saved_theme_choice_is_not_overridden(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)
    tui._THEME_FILE.parent.mkdir(parents=True, exist_ok=True)
    tui._THEME_FILE.write_text("nord")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test():
            assert app.theme == "nord"

    asyncio.run(scenario())


def test_s_cycles_sort_field_and_shift_s_flips_direction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True, with_skill=False)
    make_skill(catalog.SKILLS_DIR, "alpha")
    make_skill(catalog.SKILLS_DIR, "beta")
    # fake1: beta linked, alpha missing -> sorted by fake1 gives beta, alpha
    agents.install_one("fake1", "beta")
    # fake2: alpha linked, beta missing -> sorted by fake2 gives alpha, beta
    agents.install_one("fake2", "alpha")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert app._visible == ["alpha", "beta"]  # sorted by name

            await pilot.press("s")
            assert app._visible == ["beta", "alpha"]  # sorted by fake1 status

            await pilot.press("s")
            assert app._visible == ["alpha", "beta"]  # sorted by fake2 status

            await pilot.press("s")
            assert app._visible == ["alpha", "beta"]  # wraps back to name

            await pilot.press("S")
            assert app._visible == ["beta", "alpha"]  # name, reversed

    asyncio.run(scenario())


def test_stats_strip_reflects_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            stats = app.query_one("#stats", tui.Static)
            assert "LINKED 0" in str(stats.render())
            assert "MISSING 1" in str(stats.render())

            await pilot.press("i")
            assert "LINKED 1" in str(stats.render())
            assert "MISSING 0" in str(stats.render())

    asyncio.run(scenario())
