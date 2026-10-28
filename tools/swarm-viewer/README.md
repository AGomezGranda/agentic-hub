# swarm-viewer

Read-only local dashboard for pi-subagents swarm runs. It lists workflow swarms, shows
each node's stage, state, model, cost and report, and streams activity while a run is live.

## Run

Needs Node 22 or newer. No install step: the package has no dependencies.

```
cd tools/swarm-viewer
npm start
```

Open `http://127.0.0.1:4317/`.

| Flag | Default | Meaning |
|---|---|---|
| `--artifacts-dir <dir>` | from `$TMPDIR` and your uid (see below) | pi-subagents `async-subagent-runs` directory |
| `--sessions-dir <dir>` | `~/.pi/agent/sessions` | pi sessions; report files must be under it |
| `--port <n>` | `4317` | port on `127.0.0.1` |
| `--show-args` | off | show tool arguments and the launch scope text |
| `--show-output` | off | show node tool output (`recentOutput`) |

Without `--show-args`, tool arguments and launch scope never leave the server. Without `--show-output`, node tool output never does. Neither flag affects report text (see below).

## What it reads

- Artifacts: `<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/`. `<tmpdir>` is `$TMPDIR` on
  macOS (a `/var/folders/...` path) and `/tmp` on Linux. If `PI_SUBAGENTS_TEMP_ROOT` is set, the
  viewer uses `$PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs/` instead.
- Repo: each swarm's `cwd` comes from its root status. Three read-only git queries run there:
  `rev-parse --show-toplevel`, `symbolic-ref --quiet HEAD`, and `rev-parse --short HEAD` when detached.
  The branch is read now, not at launch, so an old swarm can show a branch it did not start on. A `cwd`
  inside another repo shows that repo. Results are cached for 10 s.
- Launch args: `round` is shown. `scope` (text the launcher wrote) is shown only with `--show-args`. No other launch argument is read.
- Reports: only the paths in each swarm's `workflow-receipt.json`, and only if they resolve
  under the artifacts or sessions directory. Report text is shown in full (up to 512 KiB) and can
  quote tool output. Neither flag hides it.

Only the workflow root and its listed members are read. Other run directories are ignored.

## What it does not show

- System prompts, model thinking, and the body of tool results. These are never read into the view.
- Tool arguments and node tool output, unless you pass the flags above.
- Foreground (in-process) children and standalone async runs that are not part of a workflow.
- History. The viewer shows what pi-subagents still has on disk; once pi prunes its files, the run is gone.

## Reading the page

- **Stages** are inferred from timing. A node starts a new stage when it starts after every node in the current stage has ended.
- **stale**: the node says `running`, but its process is gone. Detection checks the pid only.
- **unknown**: the status file is missing or unreadable.
- **est.**: tokens and cost come from pi's own reports (`totalCost`, and `turn_end` usage). They are estimates, not billing.
- **model differs from the request**: the model that ran is not the one requested.
- **Start time unknown**: the node has no start time yet.
- **Progress bar** (running nodes): time elapsed from the node's start to its deadline, not work done. No bar unless both times are known and the deadline is after the start.
- **active <duration> ago** and **Last activity**: `lastActivityAt` from the child status.
- **Exit code**: from the node's step. **Terminal state**: the top-level `processTerminal.state`, shown for finished nodes only.
- **Timeline offsets** (`+12.4s`): time since the swarm started.
- **List counts**: node states per swarm, from the status files the list already reads.

## Security

- Binds `127.0.0.1` only. Rejects any `Host` header other than `127.0.0.1:<port>` or `localhost:<port>`.
- GET and HEAD only. Reports are `text/plain` with `nosniff`.
- The page renders with DOM APIs and text nodes only. CSP is `default-src 'self'; frame-ancestors 'none'`.
- Read-only. There is no write endpoint and no authentication. Anyone who can reach the port can read the views it serves, so keep it on loopback.

## Known limits

- **pid reuse:** if a dead run's pid is reused by another process, its node looks `running`. Accepted for v1.
- **Root not probed:** a swarm's own `running` state is trusted. If its process dies, the swarm stays `running`. Only child pids are checked.
- Polls every second. Lists the 20 most recent swarms. On page load, a `#<id>` link to any other swarm opens the newest one and rewrites the URL.
- A report over 512 KiB is cut at 512 KiB with no notice.
- Each run's initial backlog is capped at 2 MiB. The page keeps the newest 300 activity rows per node.
- Windows is not supported. Pass `--artifacts-dir` if `process.getuid` is missing.

## Tests

```
npm test
```

CI runs this on Node 22 and 24 (`.github/workflows/ci.yml`, job `swarm-viewer`).
