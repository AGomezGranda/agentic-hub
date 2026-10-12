# agentic-hub

Install markdown skills into multiple AI agents from one source. Links
`skills/<name>/` into each host's skill directory. Skills with host-specific
instructions get a generated `SKILL.md` and linked supporting files.

## Hosts

Capability matrix, verified against `pi-subagents` docs and this machine
unless noted:

| Host | Skills | Subagents | Custom agents | State |
|---|---|---|---|---|
| **Pi** (primary) | `~/.pi/agent/skills/` | `subagent` tool, `runs.all`, concurrent (cap 20, 64/run) | 4 scopes, incl. `~/.pi/agent/agents/` | fully capable |
| **Claude Code** | `~/.claude/skills/` | `Agent` tool; children cannot nest (unverified here, same tag as OpenCode) | `~/.claude/agents/` — does not exist | built-in agents only |
| **Codex** | `~/.agents/skills/` | subagents (when requested) | `~/.codex/agents/` | native skills |
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
                        #   1/2    Skills / Behavior pages
                        #   i/r    install/remove the cell under the cursor
                        #   I/R    install/remove for every agent
                        #   space  toggle multi-select (i/r/I/R then act on the selection)
                        #   /      filter skills, escape to clear
                        #   c/C    Behavior: toggle coach for all hosts / explicitly disable it
                        #   ctrl+r refresh skills and coach status from disk
                        #   ctrl+p command palette (includes theme switcher, saved as default)
                        #   s/S    cycle sort field / flip sort direction
                        #   q      quit
agentic-hub list       # print all skills with per-agent status
agentic-hub install [names...] [--agent claude,pi,...]   # interactive picker if no names given
agentic-hub remove <names...> [--agent claude,pi,...]
agentic-hub sync       # install every skill to every agent
agentic-hub coach on   # enable or refresh coaching for all four hosts
agentic-hub coach status
agentic-hub coach off
```

Install and sync finish all targets, then exit 1 if any requested installation
fails, including unknown skill names. Skill inspection errors appear as `error`
in list output and the TUI without blocking other skills. Generated skills are
`stale` when their installed content differs from the source; reinstall restores
the generated instructions, replacing edits to those owned files.

## Coding coach

Coaching starts off. `coach on` adds a marked instruction section for Claude
Code, Pi, OpenCode, and Codex in the current user's local environment. It
persists across chats until `coach off` removes it. **Restart the harness and
start a new chat after either change.** Existing conversations can retain
their previous instructions.

The coach reads relevant code, explains concepts, gives one next step, and
reviews your attempt. You write the implementation and run checks. These are
behavioral instructions, not enforced tool permissions; higher-priority rules,
context limits, or excluded instruction files can affect model behavior.

The shared source is
[`src/agentic_hub/profiles/coding-coach.md`](src/agentic_hub/profiles/coding-coach.md),
packaged with the application. After editing it, run `agentic-hub coach on`
again to refresh installed sections. Coaching is independent of skills:
install, remove, and sync never toggle or refresh it. There is no per-project,
per-host, or machine-sync switch.

The TUI opens on **Skills**. Press `1` for Skills or `2` for **Behavior**, or
click the tabs. Focus the tab bar with Tab/Shift+Tab to navigate with left/right.
Page switching retains your filter, selection, cursor, sort, preview, and scroll
position. Skill actions belong to Skills; coach actions belong to Behavior.
The filter accepts `1`, `2`, `c`, and `C` as ordinary text.

Behavior shows coach status with **Enable all** and **Disable all** buttons.
On Behavior, press `c` to disable when every host is on, or enable and refresh
otherwise; `C` always disables, including mixed/error states. Use Tab and Enter
to reach and activate the buttons, or click them. Controls also work with no
skills or no filter matches. Description and per-host diagnostics scroll inside
the card; actions and the restart reminder stay visible in short terminals.
Buttons and coach shortcuts are disabled during a write. You can switch pages
while it completes; failures show per-host details and leave successful changes
in place.

A shared `COACH: ON/OFF/MIXED/ERROR` strip remains visible on both pages. It
reports the last observed installed instructions, not whether a running agent
loaded them. Page switching preserves the skill view without reading disk.
Press `ctrl+r` on either page to refresh skills and coaching, including changes
made through the CLI or another TUI instance; there is no background polling.

Both frontends use these instruction paths and selection rules:

| Host | Effective instruction file |
|---|---|
| Claude Code | `CLAUDE.md` under `CLAUDE_CONFIG_DIR`, default `~/.claude`. |
| Codex | First nonempty `AGENTS.override.md` or `AGENTS.md` under `CODEX_HOME`, default `~/.codex`; otherwise create/use `AGENTS.md`. |
| Pi | First existing readable regular file in order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` under `PI_CODING_AGENT_DIR`, default `~/.pi/agent`; otherwise create `AGENTS.md`. Empty files count. |
| OpenCode | Existing `~/.config/opencode/AGENTS.md`, otherwise existing `~/.claude/CLAUDE.md` when Claude compatibility is enabled; otherwise create the native `AGENTS.md`. |

Empty root variables use defaults; nonempty relative roots resolve against
the hub's working directory and expand `~`. OpenCode's Claude fallback is
disabled by `OPENCODE_DISABLE_CLAUDE_CODE` or
`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` set to `1` or `true`. A nonempty
`OPENCODE_CONFIG_DIR`, a relocated `XDG_CONFIG_HOME`, or a needed Claude
fallback with relocated `CLAUDE_CONFIG_DIR` produces an unsupported-layout
error for OpenCode; other hosts can still succeed. The hub supports only
OpenCode's default config layout and does not edit its JSON/JSONC settings.

Only the environment visible to the hub is covered. A harness launched with
different roots or flags that disable instruction loading may behave
differently. Unreadable or unsuitable candidates are errors, rather than
reasons to create a higher-priority replacement.

`coach status` prints the combined state and each host's state and selected
path to stdout. Actionable details and errors go to stderr; personal
instruction contents are never printed.

| State | Meaning |
|---|---|
| `off` | No effective coaching section or unclaimed shadowed section. |
| `on` | The effective section matches the current profile, with no unclaimed shadowed section. |
| `stale` | The effective section was edited/is outdated, or an unclaimed section remains in a shadowed candidate; details explain whether coaching is still present. |
| `error` | Resolution, reading, validation, or a requested update failed. |

The combined label is `OFF` when all hosts are off, `ON` when all are on,
`ERROR` when any host has an error, and `MIXED` otherwise. These describe
installed instructions, not proof that a running model loaded or obeyed them.
Status exits 0 for ordinary mixed/stale states and 1 for inspection errors.
On/off exit 0 only when every host reaches the requested state, otherwise 1;
missing or invalid actions exit 2.

The hub preserves text outside its owned markers and keeps existing fallback
selection. A shadowed section still required by another host is retained and
does not count as stale. Enable removes unclaimed shadowed sections only when
all candidate sets validate; errors defer that cleanup. Disable removes owned
sections from all known candidates in each fully validated host set, and
works even if the profile source is missing.

After a partial failure, successful updates remain in place. Fix the reported
target and retry `coach on`, or run `coach off` using the same environment to
remove coaching. Malformed markers require manual inspection; the hub will
not guess how to repair them. Run `coach off` and verify all four states before
uninstalling or reverting the feature: removing the application alone leaves
installed instructions in place.

## Skill workflow and validation

Implementation follows the test-first loop in `implement-plan` (one focused
test, confirm it fails, smallest change, rerun) with no external TDD skill
needed. Shared workflow contracts stay in the skill body; host dispatch and
output mechanics stay in `skills/_shared/fanning-out/<host>.md` and are
spliced in at install time — common prose carries no host-specific commands.
Validate with `uv run pytest -q`; behavioural spot-checks are manual, no
evals harness. Design baseline:
`meta/plans/2026-09-20-strict-skill-quality-and-cost.md`.

## Development

```
uv sync
uv run pytest -q
```

Skills live in `skills/<name>/SKILL.md` (optional YAML-ish frontmatter, flat
`key: value` pairs only). `agentic_hub/catalog.py` reads sources,
`agentic_hub/agents.py` writes agent targets, `agentic_hub/cli.py` wires the
CLI, `agentic_hub/tui.py` is the Textual status grid. Shared workflow
contracts stay in the skill body; host dispatch and output mechanics stay in
`skills/_shared/fanning-out/<host>.md` and are spliced in at install time.

Codex discovers the installed folders as skills. Mention one explicitly with
`$skill-name`, or let Codex select it from its description. If a newly installed
skill does not appear, restart Codex. Earlier versions generated deprecated
custom prompts in `~/.codex/prompts/`; those files are separate from skills.

Pi-only subagent definitions live in `agents/*.md`.
