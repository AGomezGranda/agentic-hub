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
                        #   c/C    Behavior: apply selected mode / turn off all hosts
                        #   ctrl+r refresh skills and behavior status from disk
                        #   ctrl+p command palette (includes theme switcher, saved as default)
                        #   s/S    cycle sort field / flip sort direction
                        #   q      quit
agentic-hub list       # print all skills with per-agent status
agentic-hub install [names...] [--agent claude,pi,...]   # interactive picker if no names given
agentic-hub remove <names...> [--agent claude,pi,...]
agentic-hub sync       # install every skill to every agent
agentic-hub mode set coach
agentic-hub mode set rubber-duck
agentic-hub mode set skeptic
agentic-hub mode set interviewer
agentic-hub mode status
agentic-hub mode off
agentic-hub coach on   # alias: replace the current primary mode with Coach
agentic-hub coach status
agentic-hub coach off  # alias: turn off any primary mode
```

Install and sync finish all targets, then exit 1 if any requested installation
fails, including unknown skill names. Skill inspection errors appear as `error`
in list output and the TUI without blocking other skills. Generated skills are
`stale` when their installed content differs from the source; reinstall restores
the generated instructions, replacing edits to those owned files.

## Behavior modes

The choices are **Off, Coach, Rubber Duck, Skeptic, Interviewer**. Applying a
mode replaces the previous primary behavior across Claude Code, Pi, OpenCode,
and Codex in the hub's current local environment. The installed default persists
across chats. **Restart the harness and start a new chat after each change.**
Existing conversations can retain their previous instructions.

| Mode | Working relationship and tools |
|---|---|
| Coach | Reads relevant code, explains concepts, proposes one next step, and reviews your attempt. You implement and run checks. |
| Rubber Duck | Reflects briefly and asks one focused question. Asks before giving advice; repository inspection or experiments need a request for support. |
| Skeptic | Builds the strongest credible case against a plan, document, or proposal. Ranks objections and explains what would resolve them; accepts sound decisions. Inspects relevant code; changing experiments need an explicit request. |
| Interviewer | Gives one constrained challenge with stable criteria. Answers clarifications, offers labeled requested hints, and assesses independent versus hinted work. May inspect submitted code and run appropriate requested checks. |

Profiles guide behavior; they do not enforce tool permissions or override
higher-priority instructions. The new roles do not implicitly edit code or
commit. Ordinary agreement keeps the role active. Explicit bounded exceptions
resume the role afterward; an explicit chat-local exit or role switch needs no
further confirmation and does not change future chats. Off never executes
previously discussed work. Coach retains its existing implementation and
execution restrictions.

The controller is `src/agentic_hub/behavior.py`; the four self-contained sources
are packaged under `src/agentic_hub/profiles/`. Reapply `mode set <mode>` after
editing a source to refresh installed sections. Existing Coach sections remain
current without migration. `coach on` replaces another mode with Coach;
`coach status` inspects whichever mode is installed; `coach off` turns all
primary behavior off. Command syntax remains compatible; the stdout header
is now `Behavior: <combined state>`.

Behavior is independent of skills: install, remove, and sync never inspect,
toggle, or refresh it. There is no per-project, per-host, or machine-sync switch.

The TUI opens on **Skills**. Press `1` for Skills or `2` for **Behavior**, or
click the tabs. Tab/Shift+Tab can focus the tab bar for left/right navigation.
Page switching retains the filter, selection, cursor, sort, preview, and scroll
position. Skill actions belong to Skills; behavior actions belong to Behavior.
The filter accepts `1`, `2`, `c`, and `C` as ordinary text.

On Behavior, **Selected mode** previews Off, Coach, Rubber Duck, Skeptic, or
Interviewer. Selection never changes files. **Installed** and the shared
`MODE:` indicator always show observed instructions. Choose a target, then click
**Apply all** or press `c` to apply or refresh it; `c` never toggles an active
mode off. **Turn off all** or `C` clears any primary mode. Choosing Off and
applying has the same effect. Turning off retains your pending choice.

The selector initializes once from uniform current instructions or Off. Mixed
or erroneous installations start with an empty selection and disabled Apply;
choose a target to recover, or use Turn off all. Refresh with `ctrl+r` to see
CLI changes without losing your pending selection. No background polling occurs.

Behavior page entry focuses the selector. Enter opens its native menu and
confirms a choice; arrows/search navigate, and Escape closes it. Menu keys do
not trigger app shortcuts. Tab/Shift+Tab reach the selector, scrollable summary,
and buttons; Enter on Apply writes. Long previews/diagnostics scroll, while
controls and restart guidance remain reachable at 40×16.

During a write, selector, buttons, and behavior actions are disabled. Skills and
page navigation remain usable; refresh skips behavior inspection until the
write finishes. Completion retains your pending choice and does not navigate
away from Skills or steal focus. It reports actual per-host modes, including
partial errors; repair and reapply, or explicitly turn off all.

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

`mode status` (also `coach status`) prints `Behavior: <combined state>` and each host's mode, state, and selected
path to stdout. Actionable details and errors go to stderr; personal
instruction contents are never printed.

| State | Meaning |
|---|---|
| `off` | No effective primary behavior section or unclaimed shadowed section. |
| `on` | The effective section matches its current mode profile, with no unclaimed shadowed section. |
| `stale` | The effective section was edited/is outdated, or an unclaimed section remains in a shadowed candidate; details explain whether a mode is still present. |
| `error` | Resolution, reading, validation, or a requested update failed. |

The combined label is `OFF` when all hosts are off, the mode name when all are on with the same current profile,
`ERROR` when any host has an error, and `MIXED` otherwise. These describe
installed instructions, not proof that a running model loaded or obeyed them.
Status exits 0 for ordinary mixed/stale states and 1 for inspection errors.
Set/off exit 0 only when every host reaches the requested mode and current state, or off, otherwise 1;
missing or invalid actions exit 2.

The hub preserves text outside its owned markers and keeps existing fallback
selection. A shadowed section still required by another host is retained and
does not count as stale. Apply removes unclaimed shadowed sections only when
all candidate sets validate; errors defer that cleanup. Off removes owned
sections from all known candidates in each fully validated host set, and
works even if the profile source is missing.

After a partial failure, successful updates remain in place. Fix the reported
target and retry `mode set <mode>`, or run `mode off` using the same environment to
remove primary behavior. Malformed markers require manual inspection; the hub will
not guess how to repair them. Run `mode off` and verify all four states before
uninstalling or reverting the feature: removing the application alone leaves
installed instructions in place. Before downgrading to a coach-only release,
select Coach or Off with the updated hub and verify the result; older versions
do not recognize new-mode blocks.

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
