# Using Payo

Payo turns a Jira ticket into an approved implementation plan. The current slice
stops at approval: it does not write code or open a PR yet. It fetches the
ticket, creates a git worktree, plans, reviews the plan, and waits for you.

Design and roadmap: [engine-design.md](engine-design.md) and
[implementation-roadmap.md](implementation-roadmap.md).

## Requirements

- Node 24 and pnpm 10.9.
- Real mode only: a logged-in `acli` (Jira), a logged-in `pi` for the configured
  provider, and a target repository whose base branch contains
  `skills/create-plan/SKILL.md`, `skills/review-plan/SKILL.md`, and
  `skills/review-plan/references/lenses.md`.
- `PAYO_MODEL` set in real mode. Do not include the provider in the model name;
  set `PAYO_PI_PROVIDER` separately (default `anthropic`).

## Install

From the repository root:

```
cd payo
pnpm install
pnpm check
```

## Try it offline first

Fake mode needs no logins and uses a fixed `ABC-123` ticket.

```
pnpm payo serve --dev-fakes
```

Leave that terminal running. In another terminal, from `payo/`:

```
pnpm payo start ABC-123
# prints a run id, for example 0f0c8f0e-...
pnpm payo status <run-id>
pnpm payo logs <run-id> -f
```

`start` returns immediately; the run continues in the server. `status` shows the
stage and any open gate. `logs -f` streams the run's JSON events until you press
Ctrl+C.

The default fake scenario plans, reviews, and stops at the approval gate. Fake
mode has one open question (`q1`) that must be answered before approval:

```
export VISUAL=vim                 # or EDITOR
pnpm payo edit <run-id>
pnpm payo answer <run-id> q1 "Because it is safer"
pnpm payo approve <run-id>
pnpm payo status <run-id>         # status: ended (approved)
```

`PAYO_SCENARIO` selects another script:

| Scenario | Behaviour |
|---|---|
| `clean` (default) | Plan, one review round, approval gate. |
| `clean-twice` | Same, but `request-changes` runs a second review round. |
| `hang-planner` | The first planner attempt hangs; use it to rehearse crash recovery. |

`PAYO_SCENARIO` is only accepted together with `--dev-fakes`.

## Run against a real ticket

```
export PAYO_MODEL=<model>
export PAYO_PI_PROVIDER=anthropic
export PAYO_REPO=/absolute/path/to/repo
export PAYO_BASE_BRANCH=main
pnpm payo serve
```

Startup runs the same checks as `payo doctor` and exits before listening if one
fails. In another terminal:

```
pnpm payo doctor
pnpm payo start ABC-123
```

`start --repo <path> --base <branch>` overrides the server defaults for one run.
The server binds only to `127.0.0.1:7331`, so only one server can run at a time.

## Stages and gates

```
FetchTicket -> Plan -> PlanReview -> Revise (while P0/P1 findings remain)
            -> Approval -> Approved
```

- **PlanReview** fans out the review lenses, then a verifier. It converges when
  no verified P0/P1 blocker remains, and escalates after round 3.
- **Approval** raises an `approval` gate with `approve` and `requestChanges`.
  Approval is refused while any open question is unanswered.
- **Escalated** raises a `factory-escalation` gate with `resume`. It appears on
  review non-convergence, an agent failure, a crash, or an interrupted attempt.

`status` lists every open gate and the commands it allows. Commands that do not
fit the current stage fail with a `conflict` error.

## Reviewing and approving a plan

The working plan is `~/.payo/runs/<run-id>/plan.md` (under `PAYO_DATA_DIR`), not
a file in the target repository.

1. `pnpm payo edit <run-id>` opens it in `$VISUAL` or `$EDITOR`.
2. Edit the plan directly, then save and quit.
3. Optionally `pnpm payo request-changes <run-id>` to have the reviewers review
   your edited plan again.
4. Answer every open question with `pnpm payo answer <run-id> <question-id>
   "<answer>"`. Answers are written into a managed section at the end of the
   plan.
5. `pnpm payo approve <run-id>` snapshots the plan, records the diff from the
   agent's version as a metric, removes the worktree, and ends the run.

The plan's open questions carry stable IDs from the planner. The CLI does not
list them yet; they are in the plan's `openQuestions` and usually in the plan
markdown the planner wrote.

## Recovery

A stopped or crashed server never resumes work on its own. Restart `payo serve`
and inspect `status`: interrupted work appears as an `Escalated` run with a
`factory-escalation` gate. Then:

```
pnpm payo edit <run-id>     # optional, when the stage is PlanReview or Revise
pnpm payo resume <run-id>
```

For a run interrupted at `PlanReview` or `Revise`, `resume` snapshots the current
`plan.md`, bumps the cycle, and restarts review at round 1. Otherwise it re-enters
the interrupted stage. Approval removes the worktree; escalated runs keep it
until a later approval.

## Commands

All commands except `serve` and `token` need a running server.

| Command | Purpose |
|---|---|
| `pnpm payo serve [--dev-fakes]` | Start the local server. |
| `pnpm payo start <ticket> [--repo <path>] [--base <branch>]` | Start a run; prints the run ID. |
| `pnpm payo status <run-id>` | Repo, stage, status, and open gates. |
| `pnpm payo logs <run-id> [-f]` | JSON run events, optionally followed live. |
| `pnpm payo edit <run-id>` | Open the working plan in your editor. |
| `pnpm payo answer <run-id> <question-id> <text...>` | Record an answer. |
| `pnpm payo approve <run-id>` | Approve the plan and end the run. |
| `pnpm payo request-changes <run-id>` | Send the edited plan back to review. |
| `pnpm payo resume <run-id>` | Continue an escalated run. |
| `pnpm payo doctor` | Check `pi`, `acli`, `git`, and role skills. |
| `pnpm payo token` | Print the local API bearer token. |

From the repository root, prefix with `-C payo`: `pnpm -C payo payo status <run-id>`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAYO_DATA_DIR` | `~/.payo` | Database, artifacts, plans, token, sessions, worktrees. Must be absolute. |
| `PAYO_REPO` | server's working directory | Target repository. Must be absolute. |
| `PAYO_BASE_BRANCH` | `main` | Base branch for the worktree and role skills. |
| `PAYO_MODEL` | none | Model name for every role; required in real mode, no provider prefix. |
| `PAYO_PI_PROVIDER` | `anthropic` | Pi provider. |
| `PAYO_PI_BIN` / `PAYO_ACLI_BIN` / `PAYO_GIT_BIN` | `pi` / `acli` / `git` | Binary overrides. |
| `PAYO_MAX_CONCURRENT_AGENTS` | `4` | Agent concurrency cap. |
| `PAYO_SCENARIO` | `clean` | Fake scenario; requires `--dev-fakes`. |
| `VISUAL` / `EDITOR` | none | Required by `payo edit`. |

Server and CLI must use the same `PAYO_DATA_DIR`, because the CLI reads the
server token from it. Treat the token as a secret.

## Troubleshooting

- **Server exits at startup:** start `pnpm payo serve --dev-fakes` in one terminal
  and run `pnpm payo doctor` in another to see the real checks; fake mode still
  reports real doctor results.
- **`connection refused` / `invalid bearer token`:** the server is not running,
  or the CLI and server use different `PAYO_DATA_DIR`.
- **`PAYO_MODEL is required in real mode`:** export it before `serve`.
- **`PAYO_MODEL must not include a provider`:** use `PAYO_MODEL=<model>` and
  `PAYO_PI_PROVIDER=<provider>`.
- **`PAYO_SCENARIO requires --dev-fakes`:** add `--dev-fakes`, or unset it.
- **`no editor configured`:** export `VISUAL` or `EDITOR` before `payo edit`.
- **`conflict`:** the run is not in a stage that allows that command; check
  `payo status`.

## Current limits

- No implementation, checks, PR creation, or web UI yet.
- One local server on port `7331`.
- Worktrees are removed only on approval; escalated runs keep theirs until then.
