# agentic-hub

Install markdown skills into multiple AI agents from one source. Links
`skills/<name>/` into each host's skill directory. Skills with host-specific
instructions get a generated `SKILL.md` and linked supporting files. The hub
also manages persistent behavior modes and an explicit subset of Pi declarations.

## Hosts

Capability matrix. Pi entries follow the pi-subagents docs (0.82.1); other
hosts' subagent support is unverified.

| Host | Skills | Subagents | Custom agents | State |
|---|---|---|---|---|
| **Pi** (primary) | `~/.pi/agent/skills/` | `subagent` tool, `runs.all`, concurrent (cap 20, 64/run) | 4 scopes, incl. `~/.pi/agent/agents/` | fully capable |
| **Claude Code** | `~/.claude/skills/` | `Agent` tool; children cannot nest (unverified) | none shipped | built-in agents only |
| **Codex** | `~/.agents/skills/` | subagents (when requested) | `~/.codex/agents/` | native skills |
| **OpenCode** | `~/.config/opencode/skill/` | unverified | unverified | installed on other machines |

OpenCode is a live target on other machines. Its subagent support is unconfirmed,
so skills treat it as serial-only until someone checks.

## Pi host setup

The CLI-first [Pi handler](docs/pi-handler.md) manages an explicitly owned,
portable subset of personal package declarations and settings. `pi/manifest.json`
is the desired state for that subset; `pi apply` makes the machine match it.

The committed manifest is currently the author's selection: three pinned npm
packages (`pi-powerline-footer`, `@upstash/context7-pi`, `pi-subagents`), powerline
settings, and the `pi/extensions/launch-header.ts` extension. Review it before
running `pi apply` on any other machine, or empty it to make it a neutral
baseline. Installing or upgrading agentic-hub never applies it.

Use `pi status`, `pi doctor`, and `pi apply --dry-run` before explicit `pi apply`.
Skill sync and behavior modes do not call this handler.

The following subagent example remains **manual**. The handler does not
configure, migrate, or manage these definitions or overrides. Add it to
`~/.pi/agent/settings.json` (outside this repo), alongside existing keys:

```json
"subagents": {
  "maxThinking": "high",
  "agentScanDirs": ["~/code/python/agentic-hub/agents"],
  "agentOverrides": {
    "scout":            { "model": "claude-haiku-4-5" },
    "evidence-auditor": { "model": "claude-haiku-4-5" }
  }
}
```

`agentScanDirs` makes this repo's `agents/*.md` resolve from any directory.
`agentOverrides` only affects pi-subagents' packaged agents, which skills use as
fallbacks when the repo's own agents are not installed. The repo's `repo-scout`
already pins Haiku.

## Install

```
uv tool install --editable .
```

Keep the editable checkout in place: the Pi handler resolves the default manifest
from it, independently of your working directory. Pi and its runtime prerequisites
must be installed separately. See the [second-machine bootstrap and release
checklist](docs/pi-handler.md#second-machine-bootstrap); authenticate locally,
never through credentials committed here.

## Skills and agents

Install with `agentic-hub install <name>`, or `agentic-hub sync` for everything.

| Skill | Use it to |
|---|---|
| `architecture-audit` | Review boundaries and responsibilities in a repo, module, or diff |
| `code-quality-audit` | Check SOLID, DRY, KISS, typing, and error handling in classes and functions |
| `create-plan` | Build an implementation plan interactively before writing code |
| `implement-plan` | Execute an approved plan phase by phase, with checkpoints |
| `mucho-texto` | Write a visual, mid-length summary of a plan, report, or RFC; the source is kept |
| `remove-comment-slop` | Compress verbose comments and docstrings in Python `src/` and `tests/` without changing behavior |
| `research-codebase` | Answer how something works, with cited `file:line` evidence (read-only) |
| `review-plan` | Review a plan through lenses such as architecture, security, and tests |
| `review-implementation` | Review the local git diff against its plan phase, then run the audit swarm |
| `testing-strategy` | Audit a service's tests against the test pyramid and prioritise gaps |

`agents/*.md` are Pi-only, read-only subagents that skills dispatch: `repo-scout`
for locate and inventory work, and `arch-lens`, `cq-dimension`, `plan-lens`,
`test-level`, and `comment-compressor` for judgement on one lens or dimension.
Other hosts use their own subagents or run serially.

Codex discovers installed folders as skills. Mention one with `$skill-name`, or let
Codex choose it from its description. Restart Codex if a new skill does not appear.

## Usage

```
agentic-hub              # TUI (also: agentic-hub tui)
agentic-hub list         # skills with per-agent status
agentic-hub install [names...] [--agent claude,pi,...]   # interactive picker if no names given
agentic-hub remove <names...> [--agent claude,pi,...]
agentic-hub sync         # install every skill to every agent
agentic-hub mode set {coach,rubber-duck,skeptic,interviewer}
agentic-hub mode status
agentic-hub mode off
agentic-hub coach {on,off,status}     # aliases: on = Coach, off = clear any mode
agentic-hub pi status [--manifest PATH]
agentic-hub pi doctor [--manifest PATH]
agentic-hub pi apply [--manifest PATH] [--dry-run]
agentic-hub pi bump [--manifest PATH] [--dry-run]    # rewrite pins to latest npm versions
```

`-v/--verbose` logs no-op skips; `-q/--quiet` shows warnings and errors only. Both
go before the subcommand.

TUI keys:

```
1 / 2       Skills / Behavior page
i / r       install / remove the cell under the cursor
I / R       install / remove for every agent
space       toggle multi-select; i/r/I/R then act on the selection
/           filter skills; Escape clears
p           toggle preview
s / S       cycle sort field / reverse sort
c / C       Behavior: apply selected mode / turn off all hosts
ctrl+r      refresh skills and behavior status from disk
ctrl+p      command palette, including the theme switcher (saved to ~/.config/agentic-hub/theme.txt)
arrows      move the cursor
q           quit
```

Install and sync finish all targets, then exit 1 if any requested installation
fails, including unknown skill names. Skill inspection errors appear as `error` in
list output and the TUI without blocking other skills. Generated skills are `stale`
when their installed content differs from the source; reinstall restores the
generated instructions, replacing edits to those owned files.

`pi status` and `pi apply --dry-run` are read-only and never launch Pi. `pi doctor`
may run only `pi --version`, and upstream startup can perform its own maintenance,
so it is not a zero-write check. Package changes require Pi 1.4.0 on POSIX;
setting-only apply does not launch Pi. The handler preserves unmanaged values and
has no force-overwrite mode. `pi bump` needs `npm` on PATH and network access. Read
the [Pi lifecycle and recovery guide](docs/pi-handler.md) before curating packages,
relocating the checkout, or repairing an interrupted apply.

## Behavior modes

Pick one primary mode: **Off, Coach, Rubber Duck, Skeptic, Interviewer**. Applying
a mode replaces the previous one across Claude Code, Pi, OpenCode, and Codex in
this environment, and the choice persists across chats. **Restart the harness and
start a new chat after each change**; existing conversations keep their old
instructions.

| Mode | Working relationship and tools |
|---|---|
| Coach | Reads relevant code, explains concepts, proposes one next step, and reviews your attempt. You implement and run checks. |
| Rubber Duck | Reflects briefly and asks one focused question. Asks before giving advice; repository inspection or experiments need a request for support. |
| Skeptic | Builds the strongest credible case against a plan, document, or proposal. Ranks objections and explains what would resolve them; accepts sound decisions. Inspects relevant code; changing experiments need an explicit request. |
| Interviewer | Gives one constrained challenge with stable criteria. Answers clarifications, offers labeled requested hints, and assesses independent versus hinted work. May inspect submitted code and run appropriate requested checks. |

Profiles guide behavior; they do not enforce tool permissions or override
higher-priority instructions. By default none of these modes edits code or
commits. Explicit, bounded exceptions resume the role afterward. Off never runs
previously discussed work. `coach on|off|status` are aliases; the commands are
listed under [Usage](#usage).

In the TUI, press `2` for the Behavior page. **Selected mode** previews a choice
without writing. **Apply all** (`c`) writes it, and **Turn off all** (`C`) clears
any primary mode. `ctrl+r` picks up CLI changes without losing your pending choice.

`mode status` prints `Behavior: <state>` (`OFF`, `COACH`, `RUBBER DUCK`, `MIXED`,
or `ERROR`) and each host's state, mode, and instruction file. Instruction contents
are never printed. Instruction-file paths, per-host states, exit codes, and recovery
steps are in [docs/behavior-modes.md](docs/behavior-modes.md#instruction-files-status-and-recovery).

Behavior is independent of skills: install, remove, and sync never inspect or
change it. There is no per-project, per-host, or machine-sync switch. Uninstalling
the hub leaves instructions in place, so run `agentic-hub mode off` first.

## Development

```
uv sync
uv run pytest -q
uv run ruff check .
uv run pyrefly check
```

### Payo

Payo turns a Jira ticket into an approved implementation plan. The current slice
stops at approval; it does not write code or open a PR yet. The full walkthrough,
including gates, recovery, and fake-mode scenarios, is in
[docs/payo/usage.md](docs/payo/usage.md).

The TypeScript workspace in `payo/` requires Node 24 and pnpm (the workspace pins
pnpm 10.9). `pnpm check` runs Biome, `tsc --noEmit`, and Vitest, and also enforces
package dependency rules.

```
cd payo
pnpm install
pnpm check
```

Real ticket (`acli`), workspace (`git`) and runner (`pi`) adapters are the
default. Real mode needs a Jira login for `acli`, a Pi login for the configured
provider, and a repo containing `skills/` at the base branch.

```
export PAYO_MODEL=<model>            # required in real mode
export PAYO_PI_PROVIDER=anthropic    # default
pnpm payo serve
```

`PAYO_PI_BIN`, `PAYO_ACLI_BIN` and `PAYO_GIT_BIN` override the binaries
(defaults `pi`, `acli`, `git`). Startup runs the same checks as `payo doctor`
and exits non-zero before listening when one fails. If that happens, run
`pnpm payo serve --dev-fakes` in one terminal and `pnpm -C payo payo doctor` in
another: the fake server still serves the real doctor report.

`--dev-fakes` selects the offline fake adapters and is the only mode that
accepts `PAYO_SCENARIO`.

```
pnpm payo serve --dev-fakes
```

The server binds only to `127.0.0.1:7331`. In another terminal, run commands from
`payo/`; `start` prints the run ID that every other command requires.

```
pnpm payo start ABC-123 [--repo /path/to/repo] [--base main]
pnpm payo status <run-id>
pnpm payo logs <run-id> [-f]
pnpm payo edit <run-id>
pnpm payo answer <run-id> <question-id> <answer...>
pnpm payo approve <run-id>
pnpm payo request-changes <run-id>
pnpm payo resume <run-id>
pnpm payo doctor
```

`payo doctor` reports `pi`, `acli`, `git` and `skills` as one line per check and
exits non-zero when any check fails.

The server defaults `PAYO_REPO` to the directory where `payo serve` started and
`PAYO_BASE_BRANCH` to `main`; `--repo` and `--base` override them per run. Server
and CLI share `PAYO_DATA_DIR` (default `~/.payo`) for the SQLite database, plans,
and the per-install bearer token. Run `pnpm payo token` only when a client needs
the token, and never share it. A stopped or crashed server never resumes work on
its own: restart it, inspect the gate, and run `pnpm payo resume <run-id>`.

The live Pi smoke test is opt-in and needs a ready Pi login plus a real repo at
the base branch. From the repository root, run `pnpm -C payo smoke`.
`pnpm --filter @payo/cli smoke` is not the command.

CI runs these same checks for both. Behavioural spot-checks are manual; there is no evals
harness. Changes follow the test-first loop in `implement-plan`: one focused test,
confirm it fails, smallest change, rerun.

Skills live in `skills/<name>/SKILL.md` (optional YAML-ish frontmatter, flat
`key: value` pairs only). Shared workflow contracts stay in the skill body; host
dispatch and output mechanics stay in `skills/_shared/fanning-out/<host>.md` and are
spliced in at install time, so common prose carries no host-specific commands.

- `src/agentic_hub/catalog.py`: discovers skills and parses frontmatter
- `src/agentic_hub/agents.py`: writes per-host targets (symlink, splice, or generate)
- `src/agentic_hub/behavior.py`: behavior-mode controller; profile sources in `profiles/`
- `src/agentic_hub/pi_handler/`: Pi declarations (config, planner, runtime, state, service, bump)
- `src/agentic_hub/cli.py`: CLI wiring
- `src/agentic_hub/tui.py`: Textual grid
- `tests/`: pytest suite
- `meta/`: plans and reviews
- `payo/`: TypeScript workspace for the Payo engine (real-adapter-by-default server and CLI; see `docs/payo/engine-design.md`)

## Tools

- `tools/swarm-viewer/`: read-only local dashboard for pi-subagents swarm runs (`npm start` in that directory).

## Docs

- [docs/pi-handler.md](docs/pi-handler.md): Pi declarations, ownership, apply, and recovery
- [docs/behavior-modes.md](docs/behavior-modes.md): mode contracts, plus instruction files, status, and recovery
- [docs/behavior-modes-acceptance.md](docs/behavior-modes-acceptance.md): behavior-mode acceptance record
- [docs/pi-extension-recommendations.txt](docs/pi-extension-recommendations.txt): Pi extension recommendations and adoption order
- [docs/payo/usage.md](docs/payo/usage.md): how to install, run, review, approve, and recover Payo runs
- [docs/payo/](docs/payo/): proposed local agent workbench design and research (engine and CLI in `payo/`)
