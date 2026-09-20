# agentic-hub

Install markdown skills into multiple AI agents from one source. Symlinks
`skills/<name>/` into Claude Code, Pi, and OpenCode's skill directories, and
flattens skills into Codex prompt files.

## Install

```
uv tool install --editable .
```

## Usage

```
agentic-hub            # launch the TUI:
                        #   i/r    install/remove the cell under the cursor
                        #   I/R    install/remove for every agent
                        #   space  toggle multi-select (i/r/I/R then act on the selection)
                        #   /      filter skills, escape to clear
                        #   ctrl+r rescan skills/ from disk
                        #   ctrl+p command palette (includes theme switcher, saved as default)
                        #   click a column header to sort by it
                        #   q      quit
agentic-hub list       # print all skills with per-agent status
agentic-hub install [names...] [--agent claude,pi,...]   # interactive picker if no names given
agentic-hub remove <names...> [--agent claude,pi,...]
agentic-hub sync       # install every skill to every agent
```

## Development

```
uv sync
uv run pytest -q
```

Skills live in `skills/<name>/SKILL.md` (optional YAML-ish frontmatter, flat
`key: value` pairs only). `agentic_hub/catalog.py` reads sources,
`agentic_hub/agents.py` writes agent targets, `agentic_hub/cli.py` wires the
CLI, `agentic_hub/tui.py` is the Textual status grid.
