import asyncio
from pathlib import Path
from threading import Event
from unittest.mock import Mock

import pytest
from textual.widgets import TabbedContent, Tabs
from textual.widgets.markdown import MarkdownBlock

from agentic_hub import agents, catalog, cli, coach, tui

pytestmark = pytest.mark.usefixtures("isolated_coach_home")


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
    real_hosts: bool = False,
) -> None:
    src = tmp_path / "skills"
    src.mkdir()
    monkeypatch.setattr(catalog, "SKILLS_DIR", src)
    fake_agents: dict[str, tuple[Path, agents.Mode]]
    if real_hosts:
        fake_agents = {
            host: (tmp_path / "installed" / host, mode)
            for host, (_, mode) in agents.AGENTS.items()
        }
    elif multi_agent:
        fake_agents = {
            "fake1": (tmp_path / "fake1", "symlink"),
            "fake2": (tmp_path / "fake2", "symlink"),
        }
    else:
        fake_agents = {"fake": (tmp_path / "fake", "symlink")}
    monkeypatch.setattr(agents, "AGENTS", fake_agents)
    if not real_hosts:
        monkeypatch.setattr(
            coach,
            "instruction_candidates",
            lambda host: [tmp_path / "instructions" / host / "AGENTS.md"],
        )
    monkeypatch.setattr(tui, "_THEME_FILE", tmp_path / "theme.txt")
    if with_skill:
        make_skill(src, "demo")


def test_skills_is_default_and_navigation_does_not_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)
    inspect = Mock(wraps=coach.inspect)
    mutate = Mock()
    install = Mock()
    remove = Mock()
    monkeypatch.setattr(coach, "inspect", inspect)
    monkeypatch.setattr(coach, "set_enabled", mutate)
    monkeypatch.setattr(agents, "install_one", install)
    monkeypatch.setattr(agents, "remove_one", remove)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            pages = app.query_one("#pages", TabbedContent)
            assert pages.active == "skills-page"
            assert app.focused is None
            inspect.reset_mock()
            refresh = Mock(wraps=app.refresh_grid)
            monkeypatch.setattr(app, "refresh_grid", refresh)
            await pilot.press("2")
            assert pages.active == "behavior-page"
            assert app.focused is app.query_one("#coach-enable")
            await pilot.press("1")
            assert pages.active == "skills-page"
            assert app.focused is None
            await pilot.click(pages.get_tab("behavior-page"))
            assert pages.active == "behavior-page"
            await pilot.click(pages.get_tab("skills-page"))
            assert pages.active == "skills-page"
            for boundary in (inspect, mutate, install, remove, refresh):
                boundary.assert_not_called()

    asyncio.run(scenario())


def test_tab_switch_preserves_skill_view(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False)
    for index in range(12):
        make_skill(catalog.SKILLS_DIR, f"skill-{index:02}")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.press("s", "S", "down", "right", "space", "p", "/", "s")
            grid = app.query_one("#grid", tui.VerticalScroll)
            grid.scroll_end(animate=False)
            await pilot.pause()
            assert grid.scroll_y > 0
            cards = list(grid.children)
            scroll = grid.scroll_y
            visible = app._visible.copy()
            selected = app._selected.copy()
            cursor = (app._cursor_row, app._cursor_col)
            await pilot.click(
                app.query_one("#pages", TabbedContent).get_tab("behavior-page")
            )
            await pilot.press("1")
            assert app.query_one("#filter", tui.Input).value == "s"
            assert app.focused is app.query_one("#filter")
            assert app._filter == "s" and app._visible == visible
            assert app._selected == selected
            assert (app._cursor_row, app._cursor_col) == cursor
            assert app._sort_index == 1 and app._sort_reverse
            assert app._preview_visible and app.query_one("#detail").display
            assert grid.scroll_y == scroll and list(grid.children) == cards

    asyncio.run(scenario())


def test_shortcuts_and_footer_follow_active_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)
    inspect = Mock(wraps=coach.inspect)
    mutate = Mock()
    install = Mock()
    remove = Mock()
    monkeypatch.setattr(coach, "inspect", inspect)
    monkeypatch.setattr(coach, "set_enabled", mutate)
    monkeypatch.setattr(agents, "install_one", install)
    monkeypatch.setattr(agents, "remove_one", remove)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            inspect.reset_mock()
            assert "i" in app.active_bindings
            assert {"c", "C"}.isdisjoint(app.active_bindings)
            await pilot.press("c", "C")
            inspect.assert_not_called()
            mutate.assert_not_called()
            await pilot.press("2")
            assert {"c", "C"} <= app.active_bindings.keys()
            assert {"i", "r", "I", "R", "space", "/", "p", "s", "S"}.isdisjoint(
                app.active_bindings
            )
            assert {"1", "2", "ctrl+r", "ctrl+p", "q"} <= app.active_bindings.keys()
            await pilot.press(
                "i", "r", "I", "R", "/", "escape", "p", "s", "S", "down", "right"
            )
            assert not app._selected and not app._preview_visible
            assert app._sort_index == 0 and not app._sort_reverse
            assert (app._cursor_row, app._cursor_col) == (0, 0)
            assert not app.query_one("#filter").display
            install.assert_not_called()
            remove.assert_not_called()
            tabs = app.query_one(Tabs)
            tabs.focus()
            await pilot.press("left")
            assert app.query_one("#pages", TabbedContent).active == "skills-page"
            assert app.focused is tabs
            await pilot.press("right")
            assert app.query_one("#pages", TabbedContent).active == "behavior-page"
            assert app.focused is tabs
            await pilot.press("1", "right")
            assert app._cursor_col == 1
            assert app.query_one("#pages", TabbedContent).active == "skills-page"

    asyncio.run(scenario())


def test_filter_keeps_navigation_keys_as_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)
    mutate = Mock()
    monkeypatch.setattr(coach, "set_enabled", mutate)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("/", "1", "2", "c", "C")
            assert app.query_one("#filter", tui.Input).value == "12cC"
            assert app.query_one("#pages", TabbedContent).active == "skills-page"
            mutate.assert_not_called()

    asyncio.run(scenario())


def test_coach_controls_default_off_without_skills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False, real_hosts=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert "COACH: OFF" in str(app.query_one("#coach-indicator").render())
            await pilot.press("2")
            rendered = str(app.query_one("#coach-status", tui.Static).render())
            assert "Coding coach: OFF" in rendered
            for host in agents.AGENTS:
                assert f"{host}: off" in rendered
            assert "Scope: all hosts" in rendered
            assert "Guidance, hints, and review" in rendered
            assert "Restart the harness and start a new chat" in str(
                app.query_one("#coach-restart").render()
            )
            for id_, label in (
                ("coach-enable", "Enable all"),
                ("coach-disable", "Disable all"),
            ):
                button = app.query_one(f"#{id_}", tui.Button)
                assert str(button.label) == label
                assert button.can_focus and not button.disabled
            assert all(status.state == "off" for status in coach.inspect().values())

    asyncio.run(scenario())


def test_coach_keyboard_persists_with_native_opencode_after_remount(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, with_skill=False, real_hosts=True)
    paths = [tmp_path / ".claude/CLAUDE.md", tmp_path / ".config/opencode/AGENTS.md"]
    for path in paths:
        path.parent.mkdir(parents=True)
        path.write_bytes(b"Personal instructions\r\n")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            assert "Coding coach: ON" in str(app.query_one("#coach-status").render())
            assert all(status.state == "on" for status in coach.inspect().values())
            for path in paths:
                assert b"coding-coach begin" in path.read_bytes()

        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert "Coding coach: ON" in str(app.query_one("#coach-status").render())
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            assert "Coding coach: OFF" in str(app.query_one("#coach-status").render())
            for path in paths:
                assert path.read_bytes() == b"Personal instructions\r\n"

    asyncio.run(scenario())


def test_coach_buttons_and_keyboard_focus_work_with_empty_filter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test(size=(40, 24)) as pilot:
            await pilot.press("/", "c", "C")
            assert app.query_one("#filter", tui.Input).value == "cC"
            assert app._visible == []
            assert all(s.state == "off" for s in coach.inspect().values())
            await pilot.click(
                app.query_one("#pages", TabbedContent).get_tab("behavior-page")
            )
            await pilot.click("#coach-enable")
            await app.workers.wait_for_complete()
            assert all(s.state == "on" for s in coach.inspect().values())
            await pilot.click("#coach-disable")
            await app.workers.wait_for_complete()
            assert all(s.state == "off" for s in coach.inspect().values())
            app.query_one("#coach-enable").focus()
            await pilot.press("enter")
            await app.workers.wait_for_complete()
            assert all(s.state == "on" for s in coach.inspect().values())
            await pilot.press("tab", "enter")
            await app.workers.wait_for_complete()
            assert all(s.state == "off" for s in coach.inspect().values())
            await pilot.press("1")
            assert app.query_one("#filter", tui.Input).value == "cC"
            assert app._visible == []
            await pilot.press("escape", "space")
            assert app._selected == {"demo"}

    asyncio.run(scenario())


@pytest.mark.parametrize("drift", ["missing", "stale"])
def test_coach_indicator_tracks_results_and_refresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, drift: str
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            cli.main(["coach", "on"])
            assert "Coding coach: OFF" in str(app.query_one("#coach-status").render())
            assert "COACH: OFF" in str(app.query_one("#coach-indicator").render())
            await pilot.press("ctrl+r")
            assert "Coding coach: ON" in str(app.query_one("#coach-status").render())
            assert "COACH: ON" in str(app.query_one("#coach-indicator").render())
            codex = tmp_path / ".codex/AGENTS.md"
            if drift == "missing":
                codex.unlink()
            else:
                codex.write_text(
                    codex.read_text().replace(
                        coach.PROFILE_PATH.read_text(), "Old profile"
                    )
                )
            await pilot.press("ctrl+r")
            assert "Coding coach: MIXED" in str(app.query_one("#coach-status").render())
            assert "COACH: MIXED" in str(app.query_one("#coach-indicator").render())
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            assert all(s.state == "on" for s in coach.inspect().values())
            assert "COACH: ON" in str(app.query_one("#coach-indicator").render())
            codex.unlink()
            await pilot.press("ctrl+r", "C")
            await app.workers.wait_for_complete()
            assert all(s.state == "off" for s in coach.inspect().values())
            assert "COACH: OFF" in str(app.query_one("#coach-indicator").render())

    asyncio.run(scenario())


def test_coach_partial_failure_shows_details_and_preserves_operation_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)
    original_write = coach._write

    def fail_codex(target, *args):
        if target.path.parent.name == ".codex":
            raise OSError("blocked [target]")
        return original_write(target, *args)

    monkeypatch.setattr(coach, "_write", fail_codex)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            notifications = []
            monkeypatch.setattr(
                app, "notify", lambda *a, **kw: notifications.append((a, kw))
            )
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            rendered = str(app.query_one("#coach-status").render())
            assert "Coding coach: ERROR" in rendered
            assert "COACH: ERROR" in str(app.query_one("#coach-indicator").render())
            assert "claude: on" in rendered and "codex: error" in rendered
            assert "blocked [target]" in rendered and "observed state: off" in rendered
            assert notifications[-1][1]["severity"] == "error"
            assert "codex" in notifications[-1][0][0]
            await pilot.press("C")
            await app.workers.wait_for_complete()
            assert coach.inspect()["claude"].state == "off"
            await pilot.press("1", "space", "i", "r")
            assert agents.status("claude", "demo") == "missing"

    asyncio.run(scenario())


@pytest.mark.parametrize("operation", ["inspect", "set_enabled"])
def test_coach_exception_keeps_app_usable_and_allows_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)
    original = getattr(coach, operation)

    def fail(*args):
        raise RuntimeError("unexpected controller failure")

    monkeypatch.setattr(coach, operation, fail)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            rendered = str(app.query_one("#coach-status").render())
            assert "Coding coach: ERROR" in rendered
            assert "unexpected controller failure" in rendered
            assert not app.query_one("#coach-enable", tui.Button).disabled
            assert not app.query_one("#coach-disable", tui.Button).disabled
            monkeypatch.setattr(coach, operation, original)
            await pilot.press("C")
            await app.workers.wait_for_complete()
            assert "Coding coach: OFF" in str(app.query_one("#coach-status").render())
            await pilot.press("1", "i")
            assert agents.status("claude", "demo") == "linked"

    asyncio.run(scenario())


def test_coach_warns_when_requested_state_is_not_reached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)
    monkeypatch.setattr(coach, "set_enabled", lambda enabled: coach.inspect())

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            notifications = []
            monkeypatch.setattr(
                app, "notify", lambda *a, **kw: notifications.append((a, kw))
            )
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            assert "Coding coach: OFF" in str(app.query_one("#coach-status").render())
            assert notifications[-1][1]["severity"] == "warning"
            assert "requested on" in notifications[-1][0][0]

    asyncio.run(scenario())


@pytest.mark.parametrize("filter_focused", [True, False])
def test_coach_busy_blocks_overlapping_mutations_and_keeps_filter_responsive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filter_focused: bool
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)
    released = Event()
    original = coach.set_enabled
    calls = []

    def delayed(enabled):
        calls.append(enabled)
        assert released.wait(timeout=5)
        return original(enabled)

    monkeypatch.setattr(coach, "set_enabled", delayed)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            try:
                await pilot.press("2")
                await pilot.click("#coach-enable")
                assert app.query_one("#coach-enable", tui.Button).disabled
                assert app.query_one("#coach-disable", tui.Button).disabled
                assert not app.active_bindings["c"].enabled
                assert not app.active_bindings["C"].enabled
                await pilot.press("c", "C", "1", "2")
                assert app.focused is app.query_one("#coach-summary")
                await pilot.press("1")
                if filter_focused:
                    await pilot.press("/", "c")
                    assert app.query_one("#filter", tui.Input).value == "c"
                else:
                    assert app.focused is None
                inspect = Mock(wraps=coach.inspect)
                monkeypatch.setattr(coach, "inspect", inspect)
                await pilot.press("ctrl+r")
                inspect.assert_not_called()
            finally:
                released.set()
            await app.workers.wait_for_complete()
            assert calls == [True]
            await pilot.pause()
            assert not app.query_one("#coach-enable", tui.Button).disabled
            assert app.query_one("#pages", TabbedContent).active == "skills-page"
            assert "COACH: ON" in str(app.query_one("#coach-indicator").render())
            assert app.focused is (app.query_one("#filter") if filter_focused else None)

    asyncio.run(scenario())


def test_skill_navigation_selection_and_install_do_not_read_or_change_coach(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch)
    coach.set_enabled(True)
    inspect = Mock(wraps=coach.inspect)
    monkeypatch.setattr(coach, "inspect", inspect)

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert inspect.call_count == 1
            await pilot.press("space", "i", "r", "down", "s", "/", "c", "escape")
            assert inspect.call_count == 1
            assert all(s.state == "on" for s in inspect().values())

    asyncio.run(scenario())


def test_behavior_controls_remain_reachable_in_short_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, real_hosts=True)
    monkeypatch.setattr(
        coach,
        "inspect",
        lambda: {
            host: coach.CoachStatus(
                "error", None, f"Cannot read {'nested/' * 20}AGENTS.md"
            )
            for host in agents.AGENTS
        },
    )

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test(size=(40, 16)) as pilot:
            await pilot.press("2")
            pane = app.query_one("#behavior-page")
            for id_ in ("coach-enable", "coach-disable", "coach-restart"):
                widget = app.query_one(f"#{id_}")
                assert widget.region.height > 0
                assert pane.region.contains_region(widget.region)
            indicator = app.query_one("#coach-indicator")
            assert indicator.size.height == 1
            assert "COACH: ERROR" in str(indicator.render())
            summary = app.query_one("#coach-summary", tui.VerticalScroll)
            assert summary.max_scroll_y > 0
            summary.focus()
            await pilot.press("end")
            assert summary.scroll_y > 0
            await pilot.press("tab")
            assert app.focused is app.query_one("#coach-enable")
            await pilot.press("tab")
            assert app.focused is app.query_one("#coach-disable")
            await pilot.press("shift+tab")
            assert app.focused is app.query_one("#coach-enable")
            await pilot.press("1")
            assert app.query_one("#grid").size.height >= 5
            assert card(app, "demo").region.height > 0

    asyncio.run(scenario())


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
    for status in ("linked", "stale", "missing", "conflict", "error"):
        glyph, style = tui.STATUS_GLYPHS[status]
        assert glyph and style


def test_invalid_skill_utf8_does_not_block_other_skills_or_coaching(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)
    source = catalog.SKILLS_DIR / "demo" / "SKILL.md"
    source.write_bytes(b"\xffinvalid UTF-8")
    make_skill(catalog.SKILLS_DIR, "healthy")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            assert "Cannot read SKILL.md" in str(card(app, "demo").render())
            assert "error" in str(card(app, "demo").render())
            assert "ERROR 2" in str(app.query_one("#stats").render())
            await pilot.press("p")
            assert any("Cannot read SKILL.md" in text for text in detail_text(app))
            await pilot.press("s", "ctrl+r", "down", "i")
            assert all(
                agents.status(host, "healthy") == "linked" for host in agents.AGENTS
            )
            await pilot.press("2", "c")
            await app.workers.wait_for_complete()
            assert all(status.state == "on" for status in coach.inspect().values())
            source.write_text("---\ndescription: repaired\n---\nBody.\n")
            await pilot.press("1", "ctrl+r")
            assert "repaired" in str(card(app, "demo").render())
            assert "ERROR 0" in str(app.query_one("#stats").render())

    asyncio.run(scenario())


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


@pytest.mark.parametrize("select_second", [False, True])
def test_install_vanished_selection_reports_failure_and_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, select_second: bool
) -> None:
    setup_fixture(tmp_path, monkeypatch)
    make_skill(catalog.SKILLS_DIR, "second")

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            await pilot.press("space")
            if select_second:
                await pilot.press("down", "space")
            (catalog.SKILLS_DIR / "demo").rename(tmp_path / "removed-demo")
            await pilot.press("ctrl+r")
            assert app._visible == ["second"]
            notifications = Mock()
            monkeypatch.setattr(app, "notify", notifications)

            await pilot.press("i")

            target = agents.target_path("fake", "demo")
            assert not target.exists() and not target.is_symlink()
            if select_second:
                assert agents.status("fake", "second") == "linked"
                notifications.assert_called_with(
                    "2 skill(s): installed 1/2 action(s)", severity="warning"
                )
            else:
                assert agents.status("fake", "second") == "missing"
                notifications.assert_called_with(
                    "demo: installed failed for all 1 action(s)", severity="error"
                )

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


@pytest.mark.parametrize("failure", ["directory", "branch"])
def test_skill_write_error_notifies_continues_and_allows_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    setup_fixture(tmp_path, monkeypatch, multi_agent=True)
    if failure == "directory":
        blocked = tmp_path / "fake1"
        blocked.write_text("Occupied host directory.\n")
        diagnostic = "File exists"
    else:
        skill_md = catalog.SKILLS_DIR / "demo" / "SKILL.md"
        skill_md.write_text(skill_md.read_text() + agents.FANOUT_MARKER + "\n")
        branches = catalog.SKILLS_DIR / "_shared" / "fanning-out"
        branches.mkdir(parents=True)
        (branches / "fake2.md").write_text("Host instructions.\n")
        blocked = branches / "fake1.md"
        diagnostic = "no fan-out branch"

    async def scenario() -> None:
        app = tui.AgenticHubApp()
        async with app.run_test() as pilot:
            notifications: list[tuple[tuple[str, ...], dict[str, object]]] = []
            monkeypatch.setattr(
                app, "notify", lambda *a, **k: notifications.append((a, k))
            )
            await pilot.press("space", "I")

            assert agents.status("fake1", "demo") == "missing"
            assert agents.status("fake2", "demo") == "linked"
            assert not app._selected
            assert any(
                "fake1/demo" in args[0]
                and diagnostic in args[0]
                and options.get("severity") == "error"
                for args, options in notifications
            )
            assert "1/2" in notifications[-1][0][0]
            assert notifications[-1][1]["severity"] == "warning"

            if failure == "directory":
                blocked.unlink()
            else:
                blocked.write_text("Host instructions.\n")
            await pilot.press("I")
            assert all(
                agents.status(host, "demo") == "linked" for host in agents.AGENTS
            )
            await pilot.press("R")
            assert all(
                agents.status(host, "demo") == "missing" for host in agents.AGENTS
            )

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
