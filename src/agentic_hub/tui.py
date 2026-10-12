import asyncio
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.theme import Theme
from textual.widgets import (
    Button,
    Footer,
    Header,
    Input,
    Markdown,
    Static,
    TabbedContent,
    TabPane,
)

from . import agents, catalog, coach

STATUS_GLYPHS: dict[agents.Status, tuple[str, str]] = {
    "linked": ("✓", "bold green"),
    "stale": ("↻", "bold yellow"),
    "missing": ("·", "dim"),
    "conflict": ("✗", "bold red"),
    "error": ("!", "bold red"),
}

_THEME_FILE = Path.home() / ".config" / "agentic-hub" / "theme.txt"

TACTICAL_THEME = Theme(
    name="tactical",
    primary="#33ff99",
    secondary="#1a8f5c",
    accent="#ffb000",
    warning="#ffb000",
    error="#ff4444",
    success="#33ff99",
    foreground="#c8ffe0",
    background="#05080a",
    surface="#0a1210",
    panel="#101c18",
    dark=True,
)


def render_status(status: agents.Status) -> Text:
    glyph, style = STATUS_GLYPHS[status]
    return Text(f"{glyph} {status}", style=style)


def _load_theme() -> str:
    try:
        return _THEME_FILE.read_text().strip() or "tactical"
    except OSError:
        return "tactical"


def _save_theme(name: str) -> None:
    _THEME_FILE.parent.mkdir(parents=True, exist_ok=True)
    _THEME_FILE.write_text(name)


class AgenticHubApp(App):
    """Textual TUI: a filterable skill/agent grid with install/remove actions."""

    AUTO_FOCUS = None

    CSS = """
    #coach-indicator { height: 1; padding: 0 1; text-style: bold; }
    #coach-indicator.on { color: $success; }
    #coach-indicator.off { color: $text-muted; }
    #coach-indicator.mixed { color: $warning; }
    #coach-indicator.error { color: $error; }
    #pages, #pages > ContentSwitcher, #pages TabPane { height: 1fr; }
    #pages Tabs { background: $surface; }
    #pages Tab.-active { color: $primary; text-style: bold; }
    #pages Tabs:focus Tab.-active { color: $accent; background: $accent 10%; }
    #pages Tabs .underline--bar { color: $primary; }
    #pages Tabs:focus .underline--bar { color: $accent; }
    #coach-card {
        height: 1fr; border: heavy $panel; margin: 0 1; padding: 0 1;
        border-title-color: $foreground; border-title-style: bold;
    }
    #coach-summary { height: 1fr; min-height: 1; }
    #coach-summary:focus { background: $accent 10%; }
    #coach-status { height: auto; }
    #coach-buttons { height: 3; }
    #coach-buttons Button { width: 1fr; min-width: 0; border: heavy $panel; }
    #coach-enable { margin-right: 1; }
    #coach-buttons Button:focus { border: heavy $accent; }
    #coach-buttons Button:disabled {
        color: $text-muted; text-opacity: 1; text-style: none;
    }
    #coach-restart { height: auto; color: $text-muted; }
    #filter { display: none; }
    #body { height: 1fr; }
    #detail { width: 50%; border: heavy $panel; padding: 1; display: none; }
    #grid { height: 1fr; }
    .card { border: heavy $panel; margin: 0 1; padding: 0 1; height: auto; }
    .card.-focused { border: heavy $accent; }
    .card.-selected { background: $accent 10%; }
    """

    BINDINGS = [
        ("1", "show_skills", "Skills"),
        ("2", "show_behavior", "Behavior"),
        ("i", "install", "Install"),
        ("r", "remove", "Remove"),
        ("I", "install_all", "Install (all agents)"),
        ("R", "remove_all", "Remove (all agents)"),
        ("space", "toggle_select", "Select"),
        ("/", "open_filter", "Filter"),
        Binding("escape", "close_filter", "Close filter", show=False),
        ("ctrl+r", "refresh", "Refresh"),
        ("c", "toggle_coach", "Toggle coach"),
        ("C", "disable_coach", "Disable coach"),
        ("p", "toggle_preview", "Preview"),
        ("s", "cycle_sort", "Sort"),
        ("S", "flip_sort", "Reverse sort"),
        ("q", "quit", "Quit"),
        Binding("up", "cursor_up", "Cursor up", show=False),
        Binding("down", "cursor_down", "Cursor down", show=False),
        Binding("left", "cursor_left", "Cursor left", show=False),
        Binding("right", "cursor_right", "Cursor right", show=False),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._selected: set[str] = set()
        self._filter: str = ""
        self._cursor_row = 0
        self._cursor_col = 0
        self._visible: list[str] = []
        self._sort_index = 0
        self._sort_reverse = False
        self._preview_visible = False
        self._coach_busy = False

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="coach-indicator")
        with TabbedContent(id="pages", initial="skills-page"):
            with TabPane("Skills", id="skills-page"):
                yield Input(placeholder="filter skills\u2026", id="filter")
                yield Static(id="stats")
                yield Static(id="empty-state")
                with Horizontal(id="body"):
                    yield VerticalScroll(id="grid", can_focus=False)
                    yield Markdown(id="detail")
            with TabPane("Behavior", id="behavior-page"):
                with Vertical(id="coach-card") as card:
                    card.border_title = "Coding coach"
                    with VerticalScroll(id="coach-summary"):
                        yield Static(id="coach-status")
                    with Horizontal(id="coach-buttons"):
                        yield Button("Enable all", id="coach-enable")
                        yield Button("Disable all", id="coach-disable")
                    yield Static(
                        "Restart the harness and start a new chat to apply changes.",
                        id="coach-restart",
                    )
        yield Footer()

    def _focus_page(self) -> None:
        if self.query_one("#pages", TabbedContent).active == "skills-page":
            input_ = self.query_one("#filter", Input)
            self.set_focus(input_ if input_.display else None)
        else:
            button = self.query_one("#coach-enable", Button)
            self.set_focus(
                self.query_one("#coach-summary") if button.disabled else button
            )

    def action_show_skills(self) -> None:
        self.query_one("#pages", TabbedContent).active = "skills-page"
        self._focus_page()

    def action_show_behavior(self) -> None:
        self.query_one("#pages", TabbedContent).active = "behavior-page"
        self._focus_page()

    def on_tabbed_content_tab_activated(
        self, event: TabbedContent.TabActivated
    ) -> None:
        self.refresh_bindings()
        if self.focused is not None and any(
            not node.display for node in self.focused.ancestors_with_self
        ):
            self._focus_page()

    def check_action(self, action: str, parameters: tuple[object, ...]) -> bool | None:
        if action in {
            "install",
            "remove",
            "install_all",
            "remove_all",
            "toggle_select",
            "open_filter",
            "close_filter",
            "toggle_preview",
            "cycle_sort",
            "flip_sort",
            "cursor_up",
            "cursor_down",
            "cursor_left",
            "cursor_right",
        }:
            return self.query_one("#pages", TabbedContent).active == "skills-page"
        if action in {"toggle_coach", "disable_coach"}:
            if self.query_one("#pages", TabbedContent).active != "behavior-page":
                return False
            return None if self._coach_busy else True
        return super().check_action(action, parameters)

    async def on_mount(self) -> None:
        self.register_theme(TACTICAL_THEME)
        self.theme = _load_theme()
        self.theme_changed_signal.subscribe(self, lambda theme: _save_theme(theme.name))
        self.refresh_coach()
        await self.refresh_grid()

    def refresh_coach(
        self, statuses: dict[str, coach.CoachStatus] | None = None
    ) -> dict[str, coach.CoachStatus]:
        if statuses is None:
            try:
                statuses = coach.inspect()
            except Exception as exc:
                statuses = {
                    host: coach.CoachStatus("error", None, str(exc))
                    for host in agents.AGENTS
                }
        states = {status.state for status in statuses.values()}
        combined = coach.combined_state(statuses)
        indicator = self.query_one("#coach-indicator", Static)
        indicator.update(f"COACH: {combined}")
        indicator.set_classes(combined.lower())
        summary = Text(
            "Guidance, hints, and review while you write the implementation.\n"
            f"Scope: all hosts\n\nCoding coach: {combined}\n"
        )
        summary.append("  ".join(f"{host}: {s.state}" for host, s in statuses.items()))
        for host, status in statuses.items():
            if status.detail:
                summary.append(f"\n{host}: {status.detail}")
        self.query_one("#coach-status", Static).update(summary)
        if states & {"error", "stale"} or any(s.detail for s in statuses.values()):
            details = "\n".join(
                f"{host}: {s.detail or s.state}"
                for host, s in statuses.items()
                if s.detail or s.state in ("error", "stale")
            )
            self.notify(details, severity="error" if "error" in states else "warning")
        return statuses

    @work
    async def _set_coach(self, enabled: bool) -> None:
        if self._coach_busy:
            return
        self._coach_busy = True
        self.refresh_bindings()
        buttons = self.query("#coach-buttons Button")
        focused = self.focused
        buttons.set(disabled=True)
        try:
            try:
                statuses = await asyncio.to_thread(coach.set_enabled, enabled)
            except Exception as exc:
                statuses = {
                    host: coach.CoachStatus(
                        "error", s.path, f"{exc}; observed state: {s.state}"
                    )
                    for host, s in self.refresh_coach().items()
                }
            requested = "on" if enabled else "off"
            for status in statuses.values():
                if status.state != requested and not status.detail:
                    status.detail = f"requested {requested}, observed {status.state}; retry or disable."
            self.refresh_coach(statuses)
        finally:
            self._coach_busy = False
            buttons.set(disabled=False)
            self.refresh_bindings()
            if (
                self.query_one("#pages", TabbedContent).active == "behavior-page"
                and self.focused is None
                and focused is not None
                and focused in buttons
            ):
                self.set_focus(focused)

    def action_toggle_coach(self) -> None:
        if not self._coach_busy:
            statuses = self.refresh_coach()
            self._set_coach(not all(s.state == "on" for s in statuses.values()))

    def action_disable_coach(self) -> None:
        self._set_coach(False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "coach-enable":
            self._set_coach(True)
        elif event.button.id == "coach-disable":
            self.action_disable_coach()

    def _sort_fields(self) -> tuple[str, ...]:
        return ("name", *agents.AGENTS)

    async def refresh_grid(self) -> None:
        all_names = catalog.discover_skills()
        self._visible = [n for n in all_names if self._filter in n.lower()]
        field = self._sort_fields()[self._sort_index]
        self._visible.sort(
            key=lambda n: n if field == "name" else agents.status(field, n),
            reverse=self._sort_reverse,
        )
        self._cursor_row = min(self._cursor_row, max(len(self._visible) - 1, 0))
        self._cursor_col = min(self._cursor_col, len(agents.AGENTS))
        grid = self.query_one("#grid", VerticalScroll)
        await grid.remove_children()
        await grid.mount_all(
            self._render_card(name, index) for index, name in enumerate(self._visible)
        )
        placeholder = self.query_one("#empty-state", Static)
        if not all_names:
            placeholder.display = True
            placeholder.update(f"No skills found in {catalog.SKILLS_DIR}")
        elif not self._visible:
            placeholder.display = True
            placeholder.update(f"No skills match '{self._filter}'")
        else:
            placeholder.display = False
        counts = Counter(
            agents.status(agent, name)
            for name in self._visible
            for agent in agents.AGENTS
        )
        filter_display = self._filter or "\u2014"
        self.query_one("#stats", Static).update(
            f"SKILLS {len(self._visible)}  LINKED {counts['linked']}  "
            f"STALE {counts['stale']}  MISSING {counts['missing']}  "
            f"CONFLICT {counts['conflict']}  ERROR {counts['error']}  SORT {field}  "
            f"FILTER {filter_display}"
        )
        self._sync_detail()

    def _render_card(self, name: str, index: int) -> Static:
        classes = "card"
        if index == self._cursor_row:
            classes += " -focused"
        if name in self._selected:
            classes += " -selected"
        card = Static(id=f"card-{name}", classes=classes)
        marker = "[x] " if name in self._selected else "[ ] "
        card.border_title = marker + name

        try:
            text = (catalog.SKILLS_DIR / name / "SKILL.md").read_text()
            fm, _ = catalog.parse_frontmatter(text)
            description = fm.get("description", "(no description)")
        except (OSError, UnicodeDecodeError) as exc:
            description = f"Cannot read SKILL.md: {exc}"

        body = Text(description + "\n\n")
        for agent_index, agent in enumerate(agents.AGENTS):
            if agent_index:
                body.append("  ")
            body.append(f"{agent} ")
            status_text = render_status(agents.status(agent, name))
            if index == self._cursor_row and agent_index == self._cursor_col - 1:
                status_text.stylize("reverse")
            body.append_text(status_text)
        card.update(body)
        return card

    def _cursor_cell(self) -> tuple[str, str] | None:
        """Return (skill name, column key) under the cursor, or None if the grid is empty."""
        if not self._visible:
            return None
        name = self._visible[self._cursor_row]
        agent_names = list(agents.AGENTS)
        col = "skill" if self._cursor_col == 0 else agent_names[self._cursor_col - 1]
        return name, col

    def _sync_detail(self) -> None:
        detail = self.query_one("#detail", Markdown)
        if not self._preview_visible:
            return
        if not self._visible:
            detail.update("")
            return
        self._update_detail(self._visible[self._cursor_row])

    async def action_toggle_preview(self) -> None:
        self._preview_visible = not self._preview_visible
        self.query_one("#detail", Markdown).display = self._preview_visible
        if self._preview_visible:
            self._sync_detail()

    def _update_detail(self, name: str) -> None:
        try:
            text = (catalog.SKILLS_DIR / name / "SKILL.md").read_text()
            fm, body = catalog.parse_frontmatter(text)
            description = fm.get("description", "")
        except (OSError, ValueError) as exc:
            description, body = f"Cannot read SKILL.md: {exc}", ""
        markdown = f"# {name}\n\n{description}\n\n{body}"
        self.query_one("#detail", Markdown).update(markdown)

    async def _move_cursor(self, row: int, col: int) -> None:
        if not self._visible:
            return
        self._cursor_row = max(0, min(row, len(self._visible) - 1))
        self._cursor_col = max(0, min(col, len(agents.AGENTS)))
        await self.refresh_grid()
        self.query_one(f"#card-{self._visible[self._cursor_row]}").scroll_visible()

    async def action_cursor_up(self) -> None:
        await self._move_cursor(self._cursor_row - 1, self._cursor_col)

    async def action_cursor_down(self) -> None:
        await self._move_cursor(self._cursor_row + 1, self._cursor_col)

    async def action_cursor_left(self) -> None:
        await self._move_cursor(self._cursor_row, self._cursor_col - 1)

    async def action_cursor_right(self) -> None:
        await self._move_cursor(self._cursor_row, self._cursor_col + 1)

    async def _run(
        self, fn: Callable[[str, str], bool], verb: str, force_all: bool
    ) -> None:
        """Apply fn (install/remove) to the selected skills (or the one under cursor)
        across one or all agents, then refresh and notify with a result summary."""
        hit = self._cursor_cell()
        if hit is None:
            return
        name, col = hit
        names = sorted(self._selected) if self._selected else [name]
        targets = list(agents.AGENTS) if force_all or col == "skill" else [col]
        ok = total = 0
        for n in names:
            for agent in targets:
                total += 1
                try:
                    ok += fn(agent, n)
                except (OSError, ValueError) as exc:
                    self.notify(f"{agent}/{n}: {exc}", severity="error")
        self._selected.clear()
        await self.refresh_grid()
        label = f"{len(names)} skill(s)" if len(names) > 1 else names[0]
        if ok == total:
            self.notify(f"{label}: {verb} ({ok}/{total})")
        elif ok == 0:
            self.notify(
                f"{label}: {verb} failed for all {total} action(s)", severity="error"
            )
        else:
            self.notify(f"{label}: {verb} {ok}/{total} action(s)", severity="warning")

    async def action_install(self) -> None:
        await self._run(agents.install_one, "installed", force_all=False)

    async def action_remove(self) -> None:
        await self._run(agents.remove_one, "removed", force_all=False)

    async def action_install_all(self) -> None:
        await self._run(agents.install_one, "installed", force_all=True)

    async def action_remove_all(self) -> None:
        await self._run(agents.remove_one, "removed", force_all=True)

    async def action_toggle_select(self) -> None:
        hit = self._cursor_cell()
        if hit is None:
            return
        name, _ = hit
        self._selected.symmetric_difference_update({name})
        await self.refresh_grid()

    def action_open_filter(self) -> None:
        input_ = self.query_one("#filter", Input)
        input_.display = True
        input_.focus()

    async def action_close_filter(self) -> None:
        input_ = self.query_one("#filter", Input)
        if not input_.display:
            return
        input_.display = False
        input_.value = ""
        self._filter = ""
        await self.refresh_grid()

    async def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "filter":
            return
        self._filter = event.value.strip().lower()
        await self.refresh_grid()

    async def action_refresh(self) -> None:
        if not self._coach_busy:
            self.refresh_coach()
        await self.refresh_grid()
        self.notify("refreshed skills and coach status")

    async def action_cycle_sort(self) -> None:
        self._sort_index = (self._sort_index + 1) % len(self._sort_fields())
        await self.refresh_grid()

    async def action_flip_sort(self) -> None:
        self._sort_reverse = not self._sort_reverse
        await self.refresh_grid()


def run() -> None:
    AgenticHubApp().run()
