# agentic-hub

Install markdown skills into multiple AI agents from one source. Symlinks
`skills/<name>/` into Claude Code, Pi, and OpenCode's skill directories, and
flattens skills into Codex prompt files.

## Hosts

Capability matrix, verified against `pi-subagents` docs and this machine
unless noted:

| Host | Skills | Subagents | Custom agents | State |
|---|---|---|---|---|
| **Pi** (primary) | `~/.pi/agent/skills/` | `subagent` tool, `runs.all`, concurrent (cap 20, 64/run) | 4 scopes, incl. `~/.pi/agent/agents/` | fully capable |
| **Claude Code** | `~/.claude/skills/` | `Agent` tool; children cannot nest (unverified here, same tag as OpenCode) | `~/.claude/agents/` — does not exist | built-in agents only |
| **Codex** | `~/.codex/prompts/` (flattened) | none | none | serial only |
| **OpenCode** | `~/.config/opencode/skill/` | unverified | `agent/` dir absent here | installed on other machines |

OpenCode is a live target on other machines; its subagent capability is
unconfirmed from here, so skills treat it as serial-capable-only until
someone checks on a machine where it runs.

## Pi host setup

`~/.pi/agent/settings.json` (outside this repo), alongside existing keys:

```json
"subagents": {
  "maxThinking": "high",
  "agentScanDirs": ["~/code/agentic-hub/agents"],
  "agentOverrides": {
    "scout":            { "model": "claude-haiku-4-5" },
    "evidence-auditor": { "model": "claude-haiku-4-5" }
  }
}
```

`agentScanDirs` makes this repo's `agents/*.md` resolve in every directory,
not just this one. `agentOverrides.scout.model` moves the most-spawned,
grep-shaped child off Sonnet onto Haiku.

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
                        #   s/S    cycle sort field / flip sort direction
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

Pi-only subagent definitions live in `agents/*.md`.

