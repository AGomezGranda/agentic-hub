from collections.abc import Callable
from pathlib import Path

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import DataTable, Footer, Header, Input, Static

from . import agents, catalog

STATUS_GLYPHS: dict[agents.Status, tuple[str, str]] = {
    "linked": ("✓", "bold green"),
    "stale": ("↻", "bold yellow"),
    "missing": ("·", "dim"),
    "conflict": ("✗", "bold red"),
}

_THEME_FILE = Path.home() / ".config" / "agentic-hub" / "theme.txt"


def render_status(status: agents.Status) -> Text:
    glyph, style = STATUS_GLYPHS[status]
    return Text(f"{glyph} {status}", style=style)


def _load_theme() -> str:
    try:
        return _THEME_FILE.read_text().strip() or "textual-dark"
    except OSError:
        return "textual-dark"


def _save_theme(name: str) -> None:
    _THEME_FILE.parent.mkdir(parents=True, exist_ok=True)
    _THEME_FILE.write_text(name)


class AgenticHubApp(App):
    """Textual TUI: a filterable skill/agent grid with install/remove actions."""

    CSS = """
    #filter { display: none; }
    #body { height: 1fr; }
    #detail { width: 32; border: round $primary; padding: 1; }
    """

    BINDINGS = [
        ("i", "install", "Install"),
        ("r", "remove", "Remove"),
        ("I", "install_all", "Install (all agents)"),
        ("R", "remove_all", "Remove (all agents)"),
        ("space", "toggle_select", "Select"),
        ("/", "open_filter", "Filter"),
        Binding("escape", "close_filter", "Close filter", show=False),
        ("ctrl+r", "refresh", "Refresh"),
        ("q", "quit", "Quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._sort_reverse: dict[str, bool] = {}
        self._selected: set[str] = set()
        self._filter: str = ""

    def compose(self) -> ComposeResult:
        yield Header()
        yield Input(placeholder="filter skills\u2026", id="filter")
        yield Static(id="empty-state")
        with Horizontal(id="body"):
            yield DataTable()
            yield Static(id="detail")
        yield Footer()

    def on_mount(self) -> None:
        self.theme = _load_theme()
        self.theme_changed_signal.subscribe(self, lambda theme: _save_theme(theme.name))
        table = self.query_one(DataTable)
        table.cursor_type = "cell"
        table.add_column("Skill", key="skill")
        for agent in agents.AGENTS:
            table.add_column(agent, key=agent)
        self.refresh_table()
        table.focus()

    def refresh_table(self) -> None:
        table = self.query_one(DataTable)
        table.clear()
        all_names = catalog.discover_skills()
        names = [n for n in all_names if self._filter in n.lower()]
        for name in names:
            marker = "[x] " if name in self._selected else "[ ] "
            table.add_row(
                marker + name,
                *(render_status(agents.status(agent, name)) for agent in agents.AGENTS),
                key=name,
            )
        placeholder = self.query_one("#empty-state", Static)
        if not all_names:
            placeholder.display = True
            placeholder.update(f"No skills found in {catalog.SKILLS_DIR}")
        elif not names:
            placeholder.display = True
            placeholder.update(f"No skills match '{self._filter}'")
        else:
            placeholder.display = False
        self._sync_detail()

    def on_data_table_header_selected(self, event: DataTable.HeaderSelected) -> None:
        column = event.column_key.value
        assert column is not None  # we always add columns with a string key
        reverse = not self._sort_reverse.get(column, False)
        self._sort_reverse[column] = reverse
        self.query_one(DataTable).sort(event.column_key, key=str, reverse=reverse)

    def _cursor_cell(self) -> tuple[str, str] | None:
        """Return (skill name, column key) under the cursor, or None if the table is empty."""
        table = self.query_one(DataTable)
        if table.row_count == 0:
            return None
        cell_key = table.coordinate_to_cell_key(table.cursor_coordinate)
        row, col = cell_key.row_key.value, cell_key.column_key.value
        if row is None or col is None:
            return None
        return row, col

    def _sync_detail(self) -> None:
        table = self.query_one(DataTable)
        detail = self.query_one("#detail", Static)
        if table.row_count == 0:
            detail.update("")
            return
        row = min(table.cursor_row, table.row_count - 1)
        key = table.ordered_rows[row].key.value
        if key is not None:  # we always add rows with a string key
            self._update_detail(key)

    def _update_detail(self, name: str) -> None:
        try:
            text = (catalog.SKILLS_DIR / name / "SKILL.md").read_text()
            fm, _ = catalog.parse_frontmatter(text)
            description = fm.get("description", "(no description)")
        except OSError:
            description = "(no description)"
        self.query_one("#detail", Static).update(f"[b]{name}[/]\n\n{description}")

    def on_data_table_cell_highlighted(self, event: DataTable.CellHighlighted) -> None:
        key = event.cell_key.row_key.value
        if key is not None:  # we always add rows with a string key
            self._update_detail(key)

    def _run(self, fn: Callable[[str, str], bool], verb: str, force_all: bool) -> None:
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
                ok += fn(agent, n)
        self._selected.clear()
        self.refresh_table()
        label = f"{len(names)} skill(s)" if len(names) > 1 else names[0]
        if ok == total:
            self.notify(f"{label}: {verb} ({ok}/{total})")
        elif ok == 0:
            self.notify(
                f"{label}: {verb} failed for all {total} action(s)", severity="error"
            )
        else:
            self.notify(f"{label}: {verb} {ok}/{total} action(s)", severity="warning")

    def action_install(self) -> None:
        self._run(agents.install_one, "installed", force_all=False)

    def action_remove(self) -> None:
        self._run(agents.remove_one, "removed", force_all=False)

    def action_install_all(self) -> None:
        self._run(agents.install_one, "installed", force_all=True)

    def action_remove_all(self) -> None:
        self._run(agents.remove_one, "removed", force_all=True)

    def action_toggle_select(self) -> None:
        hit = self._cursor_cell()
        if hit is None:
            return
        name, _ = hit
        self._selected.symmetric_difference_update({name})
        self.refresh_table()

    def action_open_filter(self) -> None:
        input_ = self.query_one("#filter", Input)
        input_.display = True
        input_.focus()

    def action_close_filter(self) -> None:
        input_ = self.query_one("#filter", Input)
        if not input_.display:
            return
        input_.display = False
        input_.value = ""
        self._filter = ""
        self.refresh_table()
        self.query_one(DataTable).focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "filter":
            return
        self._filter = event.value.strip().lower()
        self.refresh_table()

    def action_refresh(self) -> None:
        self.refresh_table()
        self.notify("rescanned skills/")


def run() -> None:
    AgenticHubApp().run()
