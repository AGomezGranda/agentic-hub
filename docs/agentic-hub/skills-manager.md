# Skills manager

The Python `agentic-hub` CLI and Textual TUI install this checkout's
`skills/<name>/SKILL.md` directories. Keep the editable checkout in place: installed
symlinks point back to it. The manager does not download skills from a registry.
The current skill catalog and TUI keys are in the [README](../../README.md#skills-and-agents).

## Install and update

From the repository root:

```sh
uv tool install --editable .
agentic-hub list
agentic-hub install create-plan review-plan
agentic-hub install testing-strategy --agent claude
agentic-hub sync
agentic-hub remove testing-strategy --agent claude
```

`install` without names opens a numbered picker. Without `--agent`, install and
remove target all hosts; `sync` installs every discovered skill for all hosts.
`sync` does not prune installed skills whose source has disappeared. Install and
sync finish the remaining targets after a failure and exit 1 if any requested
installation failed. Use `-v` or `-q` before the subcommand to adjust diagnostics.

| Hosts | Installation directory |
|---|---|
| Pi, OpenCode, Codex | One shared `~/.agents/skills/` target |
| Claude Code | `~/.claude/skills/` |

An action for any shared host affects all three. Batch actions count each
installation directory once, although `list` shows status for each host.

Skills without the fan-out marker are directory symlinks. Skills containing
`<!-- agentic-hub: fanout -->` get a generated `SKILL.md` with host dispatch prose
from `skills/_shared/fanning-out/`; their supporting files/directories are linked
to the source. The shared target includes labeled Pi, OpenCode, and Codex sections
and instructs the harness to use its own section. Claude gets its own section.
Codex uses skill folders in the current configuration; legacy flat-file
generation remains in the code for compatibility.

Source edits appear immediately through plain symlinks and linked supporting
files. Reinstall or sync after changing a generated skill's source instructions
or fan-out branches. Edit the source rather than an installed generated file:
reinstall replaces that owned file.

## Status and recovery

| Status | Meaning and action |
|---|---|
| `linked` | Installation matches the source. |
| `missing` | No installation; install the skill. |
| `stale` | Generated content, supporting links, or a symlink target differs; inspect the target and reinstall. |
| `conflict` | A file/directory or unowned generated installation occupies the target; inspect and move it aside yourself before installing. |
| `error` | Inspection failed, for example because of unreadable files; fix the reported filesystem problem and refresh. |

The manager preserves real files/directories and unowned generated `SKILL.md`
files rather than overwriting them. Plain-symlink installs can replace an existing
symlink; inspect a stale target before reinstalling. Removal deletes only links
to this checkout and recognized generated content, leaving unrelated files behind.
The TUI reports errors per cell so one broken skill does not hide the others;
`ctrl+r` refreshes status after a repair.

Old installations under `~/.pi/agent/skills/` and `~/.config/opencode/skill/`
are left untouched. Sync the shared target, inspect any old copies, and manually
remove only obsolete hub installations that could shadow it. Legacy Codex prompt
files are not automatically migrated or removed.

Skill operations do not inspect or change [behavior modes](behavior-modes.md)
and do not apply [Pi declarations](../pi/pi-handler.md).

## Payo role sources

Payo reads skills and rubric resources from Git at the target repository's
selected base commit, then snapshots them as run artifacts. It does not use
these personal installation directories or install skills through the manager.
Syncing personal skills therefore cannot fix a Payo missing-role-source error;
the required files must exist in the target repository at the selected ref.

See [Payo requirements](../payo/usage.md#requirements) for the planning and
execution source sets. `payo doctor` checks planning sources; execution loads its
additional sources when an implementation is accepted.
