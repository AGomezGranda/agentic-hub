# Using Payo

Payo turns a Jira ticket or direct prompt into an approved implementation
plan. Approval ends the planning run; an explicit `implement` command creates a
linked execution run for one selected PR unit. Payo executes its phases
sequentially in fresh agent contexts, runs the configured checks and mandatory
implementation reviews, applies bounded repairs, and leaves a reviewed local
branch/worktree. It does not push, publish a PR, or automatically start another
PR unit.

Design and roadmap: [engine-design.md](engine-design.md) and
[implementation-roadmap.md](implementation-roadmap.md).

## Requirements

- Node 24 and pnpm 10.9.
- Real mode: POSIX (macOS/Linux), a logged-in `pi` for each configured role
  provider, and a target repository whose base branch contains `skills/create-plan/SKILL.md`,
  `skills/review-plan/SKILL.md`, `skills/review-plan/references/lenses.md`,
  `skills/architecture-audit/references/boundaries.md`,
  `skills/architecture-audit/references/responsibilities.md`, and the six
  `skills/code-quality-audit/references/*.md` files (`solid.md`, `dry.md`,
  `kiss.md`, `typing.md`, `dependency-injection.md`, `errors.md`). `payo doctor`
  lists every missing path and the full set to add. Every role must resolve a
  model for each of the four planning roles from TOML or the legacy model
  environment variables. The optional implementer model is required only when
  accepting an execution. Jira runs additionally require a logged-in `acli`;
  prompt runs do not.

## Install

From the repository root:

```
cd payo
pnpm install
pnpm check
```

## Try it offline first

Fake mode needs no logins and supports the fixed `ABC-123` Jira fixture and direct prompts.

```
pnpm payo serve --dev-fakes
```

Leave that terminal running. In another terminal, from `payo/`:

```
pnpm payo start ABC-123
pnpm payo start --prompt "create a simple FastAPI todo app with strict typing"
pnpm payo start --prompt create a simple FastAPI todo app with strict typing
pnpm payo start --prompt -- --repo
# each start prints a run id, for example 0f0c8f0e-...
pnpm payo status <run-id>
pnpm payo logs <run-id> -f
```

`start` returns immediately; the run continues in the server. `status` shows the
stage and any open gate. `logs -f` streams the run's JSON events until you press
Ctrl+C.

The default fake scenario plans, reviews, and stops at the approval gate. Fake
mode has one open question (`q1`) that must be answered before approval. Its
approved strategy contains two phases, so it can exercise complete execution:

```
export VISUAL=vim                 # or EDITOR
pnpm payo edit <run-id>
pnpm payo answer <run-id> q1 "Because it is safer"
pnpm payo approve <run-id>
pnpm payo status <run-id>         # status: ended (approved)
pnpm payo implement <run-id> --pr pr-1  # requires configured [execution].checks
pnpm payo status <execution-run-id>      # phase, gates, branch, and result
```

In the browser, review the Implementation outline before approving. Expand each
PR to inspect its ordered phases and follow phase links into the plan.
Missing or ambiguous assignments must be resolved before approval. Approved
runs open on Implementation, where each PR has a local start action and the
effective base can be changed. The Execution view keeps completed, current,
and upcoming phase names visible, with final PR review as a separate step.
It also links back to the source and shows the retained branch, worktree, and
result commit when reviewed.

`PAYO_SCENARIO` selects another script:

| Scenario | Behaviour |
|---|---|
| `clean` (default) | Plan, one review round, approval gate. |
| `clean-twice` | Same, but `request-changes` runs a second review round. |
| `hang-planner` | The first planner attempt hangs; use it to rehearse planning recovery. |
| `execution-interruption` | The second execution phase pauses until server shutdown; restart and explicitly resume to rehearse phase recovery. |

`PAYO_SCENARIO` is only accepted together with `--dev-fakes`.

## Start from Jira or a direct prompt

`payo start ABC-123` remains the Jira shorthand. Direct prompts use `--prompt`;
trailing arguments are joined with single spaces, and `--repo` / `--base` remain
options. Put `--` after `--prompt` when option-looking text should be literal.
The supported inputs are Jira and prompt; Linear is future work.

Prompt request text is stored as a `factory-work-item-request-v1` `text/plain`
artifact beneath `PAYO_DATA_DIR`. The `run.created.config` event stores only that
artifact reference, not the original plaintext. Agents may echo or quote the
prompt in generated attempt events; authenticated event consumers can see that
text, so prompts are not a way to keep content secret from those consumers.

## Run against a real ticket or prompt

```
# Legacy environment-only setup remains supported. A TOML [model] section can
# replace PAYO_MODEL/PAYO_PI_PROVIDER; each role may also choose its own model.
export PAYO_MODEL=<model>
export PAYO_PI_PROVIDER=anthropic
export PAYO_REPO=/absolute/path/to/repo
export PAYO_BASE_BRANCH=main
pnpm payo serve
```

Startup requires `pi`, `git` and role skills, plus model selections for all four
roles. `payo doctor` checks every distinct configured Pi provider and still
reports `acli`; Jira availability is not a global startup requirement. In
another terminal:

```
pnpm payo doctor
pnpm payo start ABC-123
```

`start --repo <path> --base <branch>` overrides the configured repo and base for
one run. The server always binds to `127.0.0.1`; its port is configurable and
defaults to `7331`.

## Web UI

The local React console can start runs, follow live activity, review plans and
findings, and edit the shared TOML settings. It has no freeform plan editor; use
the CLI editor for direct edits. At an approval gate, the UI can also request a
prompt-driven plan revision or restore a saved version, which starts review
again. The token stays in page memory, so reloads require entering it again. The server port is kept in `sessionStorage` for the browser
session; the host is always `127.0.0.1`.

The starter config created by setup already allows the Vite origins
`http://127.0.0.1:5173` and `http://localhost:5173`. Existing config files are
never overwritten by setup; if yours predates these defaults, add the exact
origin you use to `[server].web_origins` or set `PAYO_WEB_ORIGINS` (which
replaces that setting). From `payo/`, start the server:

```
pnpm payo serve --dev-fakes
```

In another terminal, also from `payo/`, run:

```
pnpm payo token
pnpm web:dev
```

Open <http://127.0.0.1:5173/> and paste the token printed by `payo token`.
The dev server binds to `127.0.0.1` and requires port `5173` to be free. Keep
`localhost` and `127.0.0.1` distinct: the allowed origin must exactly match the
browser URL.

The left **Your work** sidebar groups the loaded runs by status (Needs you,
Active, and Ended) or by repository. Open a run to switch between **Swarm view**,
**Decision view**, and **Activity view**; the activity filter shows all events or
agent attempts. These view preferences are not saved.

Choose **Jira** and enter `ABC-123`, or choose **Prompt** and enter a short task
to start a fake run. At Approval, review the plan and findings, answer the
question, then request changes, use **Revise plan** for a prompt-driven update,
restore a version from **History**, or select **Approve and end the run**.
For a second review cycle, start the server with
`PAYO_SCENARIO=clean-twice pnpm payo serve --dev-fakes` instead. To edit outside
the browser, run `pnpm payo edit <run-id>` in another terminal, then return to
the page; the view refreshes when it regains focus. The server reads the plan
again when a command runs, so edits can still race a decision. Findings are
labelled as potentially stale because their exact plan revision is not recorded.

Approval ends the planning run and removes its planning worktree. It does not
start a writer automatically. Start implementation explicitly with the CLI
command below; this creates a separate retained execution worktree.

Use **Settings** in the main navigation to edit the shared config file. The page
groups controls by TOML section, keeps blank optional fields unset, and treats a
blank role model as inheritance from `[model]`. It shows the config path, active
environment override names, and a warning when the current page origin is absent
from the candidate `web_origins`. Save rewrites the file canonically; discard
restores the loaded document, and unsaved changes are guarded on in-app links,
browser Back/Forward, reload, and tab close. The page reports validation errors,
server failures, and revision conflicts without discarding the draft.

### Web UI troubleshooting

- **Network/CORS error:** confirm the server is running and
  `PAYO_WEB_ORIGINS=http://127.0.0.1:5173` was set before `serve`.
- **Unauthorized:** retrieve a fresh token with `pnpm payo token` and reconnect.
- **Reloaded page asks for a token:** this is expected; tokens are not persisted.
- **Cannot connect after changing the port:** restart Payo and enter the new
  `[server].port` in the connection screen; the previous port stays selected for
  this browser session until you change it.
- **Vite reports the port is in use:** stop the other process on `5173`; strict
  port selection will not silently switch origins.

## Stages and gates

```
Planning: ResolveWorkItem -> Plan -> PlanReview -> Revise (while P0/P1 findings remain)
                       -> Approval -> Approved
Execution: Approved --implement--> Prepare -> Implement -> Check -> Review
                                      ^                     |          |
                                      |                     +<-Repair<-+
                                      |                     |
                                      +-- next phase <--- PhaseReceipt
                                                            |
                                  last phase -> Finalize -> Completed (reviewed)
                                      \-> Escalated -> explicit resume/reconciliation
```

- **PlanReview** fans out the review lenses, then a verifier. It converges when
  no verified P0/P1 blocker remains, and escalates after round 3.
- **Approval** raises an `approval` gate with `approve` and `requestChanges`.
  Approval is refused while any open question is unanswered.
- **Execution** has a separate run ID linked to the ended/approved source run.
  Its deterministic identity pins the approved plan, selected PR, and base
  commit. Each accepted phase records an immutable receipt before the next
  phase starts. After the last receipt, the engine runs the full configured
  checks and full PR diff review; final repairs have their own three-cycle
  budget and never replay a phase or add a receipt.
- **Escalated** raises a gate with `resume`. Execution status includes phase
  progress, receipts, check/review coverage, branch/worktree, and the actionable
  escalation reason. Plan conflicts require a corrected newly approved
  planning run; resume cannot edit the pinned plan.

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

### Execute an approved PR unit (all phases)

Configure a nonempty `[execution].checks` suite and, in real mode, an explicit
`[roles.implementer].model` before accepting a writer. After approving the
planning run, select a PR ID from its approved strategy and submit:

```
pnpm payo implement <approved-run-id> --pr <pr-id>
# optionally select a different base branch/ref:
pnpm payo implement <approved-run-id> --pr <pr-id> --base <ref>
```

The CLI prints the execution ID once its durable run record is stored. Use
`payo status <execution-id>`, `payo logs <execution-id> -f`, and
`payo resume <execution-id>` for the linked execution. Repeating the same
`implement` request returns the same ID and pinned base; it does not start a
second writer, even if the base branch has moved. The source planning run stays
ended and approved. The server pins the approved plan artifact, selected PR,
configured checks, role sources, and resolved base commit. It creates branch
`payo/<execution-id>` at `PAYO_DATA_DIR/worktrees/<execution-id>`.

Every phase implementer, repair writer, reviewer, and verifier gets a fresh
agent session. Approved plan content, phase input, check/review evidence, and
completed phase receipts are immutable artifact handoffs; conversation
transcripts are not reused. The configured check suite runs after each phase or
repair and once again for final PR verification. Each phase advances only after
stable passing checks, complete coverage of all eight required review lenses,
and an engine-owned commit (or confirmation that the phase was already
satisfied). The last phase is followed by a full base-to-result PR diff review.
Final repairs have a separate three-cycle budget and do not replay phases or
write phase receipts. Only clean final checks and review end the execution as
`reviewed`; its branch and result commit remain local for inspection.

At an approval gate, you can request a prompt-driven revision or restore an
earlier snapshot:

```
pnpm payo plan-update <run-id> "Make the migration steps clearer"
pnpm payo plan-versions <run-id>
pnpm payo plan-show <run-id> 1
pnpm payo plan-diff <run-id> 1 2
pnpm payo plan-restore <run-id> 1
```

Updates and restores start a fresh review; neither approves the run. A restore
appends a new version with the selected questions and answers. History remains
readable after approval. The comparison shows the changed middle as removed and
added lines, so unchanged lines between separate edits may appear in both sides.
If the current version or working file changes before acceptance, inspect the
run and retry. If an editor changes the file during work, the run escalates and
preserves the file and saved result for recovery. A narrow race remains between
the final filesystem check and replacement by an unrelated editor.

## Recovery

A stopped or crashed server never resumes work on its own. Restart `payo serve`
and inspect `status`: interrupted work appears as an `Escalated` run with a
`factory-escalation` gate for planning or an `execution-escalation` gate for execution. Then:

```
pnpm payo edit <run-id>     # optional, when the stage is PlanReview or Revise
pnpm payo resume <run-id>
```

For a planning run interrupted at `PlanReview` or `Revise`, `resume` snapshots
the current `plan.md`, bumps the cycle, and restarts review at round 1. An
execution run is reopened behind a recovery gate and is never scheduled
automatically. `resume` validates its owned gate, deterministic worktree path,
branch, pinned base, expected HEAD/history and saved commit intent before
continuing. An interrupted writer receives a fresh reconciliation context with
its partial diff; interrupted checks and reviewers rerun against the current
snapshot. Manual edits at a gate invalidate prior evidence. Accepted phase
receipts remain complete and are not replayed. A missing worktree, unexpected
HEAD/history, or mismatched commit remains gated. A pinned plan conflict cannot
be changed by resume; create and approve a corrected planning run, then start a
new execution.

To rehearse execution recovery, start the fake server with
`PAYO_SCENARIO=execution-interruption pnpm payo serve --dev-fakes`, approve a
plan, and launch its PR with configured execution checks. Stop the server while
phase two is paused, then restart it with the same data directory and scenario.
Open the execution in the browser, inspect the gate reason, and select **Resume**.
The first phase remains complete; compare the reviewed result commit with
`pnpm payo status <execution-run-id>`.

Planning approval removes only the planning worktree. Execution worktrees and
branches are retained after success, interruption, and escalation; Payo never
force-removes them automatically. The operator owns deliberate cleanup after
execution is stopped and child processes have exited. Do not delete a worktree
while the server or a writer/check descendant may still be using it.

Do not roll back to an older engine while a plan update is pending or after a
restore becomes the current version: older engines cannot read restore versions.
Retain the artifacts and use a forward fix before restarting the engine.

## Commands

All commands except `serve` and `token` need a running server.

| Command | Purpose |
|---|---|
| `pnpm payo serve [--dev-fakes]` | Start the local server. |
| `pnpm payo start <ticket> [--repo <path>] [--base <branch>]` | Start a Jira run; prints the run ID. |
| `pnpm payo start --prompt <text...> [--repo <path>] [--base <branch>]` | Start from a direct prompt; prints the run ID. |
| `pnpm payo status <run-id>` | Repo, stage, status, and open gates. |
| `pnpm payo logs <run-id> [-f]` | JSON run events, optionally followed live. |
| `pnpm payo edit <run-id>` | Open the working plan in your editor. |
| `pnpm payo answer <run-id> <question-id> <text...>` | Record an answer. |
| `pnpm payo approve <run-id>` | Approve the plan and end the planning run. |
| `pnpm payo implement <approved-run-id> --pr <pr-id> [--base <ref>]` | Explicitly accept one PR unit and its ordered phases; prints a linked durable execution ID. An optional base ref pins another starting point. |
| `pnpm payo request-changes <run-id>` | Send the edited plan back to review. |
| `pnpm payo plan-update <run-id> <prompt...>` | Revise the current working plan and review it. |
| `pnpm payo plan-versions <run-id>` | List saved versions. |
| `pnpm payo plan-show <run-id> <version>` | Show a saved version. |
| `pnpm payo plan-diff <run-id> <from> <to>` | Compare saved versions. |
| `pnpm payo plan-restore <run-id> <version>` | Append and review a restored version. |
| `pnpm payo resume <run-id>` | Continue an escalated run. |
| `pnpm payo doctor` | Check `pi`, `acli`, `git`, and role skills. |
| `pnpm payo token` | Print the local API bearer token. |

From the repository root, prefix with `-C payo`: `pnpm -C payo payo status <run-id>`.

## Configuration

The server and CLI share one optional user config at
`~/.config/payo/config.toml`. From the repository root, copy the non-secret
starter file from [`payo/config.example.toml`](../../payo/config.example.toml),
then edit it as needed:

```
mkdir -p ~/.config/payo
cp payo/config.example.toml ~/.config/payo/config.toml
```

Select another file with an **absolute** `PAYO_CONFIG_FILE=/path/to/config.toml`.
An absent default file is fine; an explicitly selected missing file is an error.
The authenticated web **Settings** page edits this file; no other Payo surface
writes it. Saving rewrites the file as canonical TOML, so comments and original
formatting are not preserved. Payo validates the complete document before
replacing the file, and changes apply only after restarting the server. Unknown
or invalid keys fail with a path-qualified error. Do not run Payo with an
untrusted config: `[tools]` selects executable programs.

| TOML key | Default | Meaning |
|---|---|---|
| `[server].port` | `7331` | Listener port, valid range `1..65535`; bind remains fixed to `127.0.0.1`. |
| `[server].web_origins` | `[]` when unset; starter config allows `http://127.0.0.1:5173` and `http://localhost:5173` | Exact `http(s)` loopback origins allowed by CORS. |
| `[paths].data_dir` | `~/.payo` | Absolute path for database, artifacts, plans, token, sessions and worktrees. |
| `[paths].repo` | Server startup directory | Absolute target repo; `payo start --repo` overrides per run. |
| `[paths].base_branch` | `main` | Base branch; `payo start --base` overrides per run. |
| `[execution].max_concurrent_agents` | `4` | Positive concurrency cap. |
| `[execution].checks` | none | Ordered `{ name, command, args, timeout_ms }` suite. Required when an execution is accepted; planning startup may omit it. Commands run with argument arrays, never a shell string. |
| `[tools].pi` / `acli` / `git` | `pi` / `acli` / `git` | Executables to run; treat these values as trusted commands. |
| `[model].provider` / `id` | Provider `anthropic`; no model ID | Optional default provider/model pair. Real mode needs a model for every role. |
| `[roles.<role>].timeout_ms` | `300000` | Optional timeout for `planner`, `reviewer`, `verifier`, `reviser`, or the optional execution `implementer`, in `1..2147483647`. |
| `[roles.<role>].model` | Inherits `[model]` | Optional complete inline `{ provider, id }` pair for that role. |

For example, set a global default and override only the planner:

```toml
[model]
provider = "anthropic"
id = "claude-sonnet-4-5"

[roles.planner]
timeout_ms = 180000
model = { provider = "openai", id = "o3" }
```

Model fields are separate provider and model IDs (neither may contain `/`); Payo
passes each selected pair to Pi as `provider/id`. Pi remains responsible for
credentials, endpoints and provider-specific model setup. Doctor checks each
distinct configured provider and reports one aggregate `pi` result. Secrets and
provider endpoints do not belong in this file.

Execution checks are operator-supplied and are recorded when an execution is
accepted. `roles.implementer` is optional at planning startup and is validated
only for execution:

```toml
[execution]
checks = [
  { name = "unit", command = "pnpm", args = ["test"], timeout_ms = 120000 },
]

[roles.implementer]
timeout_ms = 300000
model = { provider = "anthropic", id = "claude-sonnet-4-5" }
```

Resolution order is built-in defaults, TOML, environment overrides, then the
per-run `payo start --repo/--base` options. Existing environment aliases remain:

| Variable | Default | Meaning |
|---|---|---|
| `PAYO_CONFIG_FILE` | `~/.config/payo/config.toml` | Absolute path selecting the shared config file. |
| `PAYO_DATA_DIR` | `~/.payo` | Overrides `[paths].data_dir`; must be absolute. |
| `PAYO_REPO` / `PAYO_BASE_BRANCH` | Startup directory / `main` | Overrides `[paths].repo` / `base_branch`; repo must be absolute. |
| `PAYO_PORT` | `7331` | Overrides `[server].port`; production ports are `1..65535`. |
| `PAYO_MAX_CONCURRENT_AGENTS` | `4` | Overrides concurrency. |
| `PAYO_WEB_ORIGINS` | Empty | Comma-separated exact loopback origins, overriding `[server].web_origins`. |
| `PAYO_PI_BIN` / `PAYO_ACLI_BIN` / `PAYO_GIT_BIN` | `pi` / `acli` / `git` | Overrides `[tools]`. |
| `PAYO_MODEL` / `PAYO_PI_PROVIDER` | No model / `anthropic` | Legacy field overrides applied to every role; model must not include a provider prefix. |
| `PAYO_TEST_PORT` | Unset | Test-only listener override; `0` is allowed only with `NODE_ENV=test`. |
| `PAYO_TEST_SERVER_URL` | Unset | CLI test-only URL override; accepted only with `NODE_ENV=test`. |
| `PAYO_SCENARIO` / `--dev-fakes` | No scenario / off | Fake-run scenario and fake mode; scenario requires `--dev-fakes`. |
| `NODE_ENV` | Runtime-defined | Process/test control only; it is not a TOML setting. |
| `VISUAL` / `EDITOR` | Unset | Editor selection for `payo edit`; not stored in TOML. |

The CLI reads the server token from the same resolved data directory as the
server. Treat the token as a secret.

### Saving from the web Settings page

Open **Settings** in the connected web console. The page edits every supported
TOML key and shows the selected config path and the names (never the values) of
environment variables currently overriding TOML fields. Environment variables
remain authoritative after a save; saving does not copy their values into the
file. The page also explains that a restart is required.

Saving writes only the file selected at server startup (`PAYO_CONFIG_FILE` or the
default path). It never accepts a path from the request. Validation uses the same
defaults and environment precedence as startup, and real mode rejects a candidate
that removes the last effective model for any role. The response returns a
revision of the exact file bytes; a save must present that revision and returns
`409 conflict` when the file changed first. The browser keeps the draft and
offers to reload. A revision check followed by an atomic rename cannot prevent an
unrelated external writer from changing the file in the narrow check-to-rename
window, so review conflicts before saving again.

On POSIX, a saved file is written atomically with mode `0600`; newly created
parent directories use `0700`, while existing directory permissions are left
unchanged. Saving rejects a config path that is an existing symbolic link.
Windows ACLs are unchanged and mode bits do not promise owner-only access there.

`[paths].data_dir` also selects the database, artifacts, plans, token, sessions
and worktrees. Changing it and restarting can make existing runs or the current
token appear missing; point the server and CLI at the same file and directory.
Changing `[server].port` requires restarting Payo and reconnecting the browser at
the new port. Keep the web page's exact origin in `[server].web_origins` when it
differs from the server origin, otherwise the restarted server rejects browser
requests.

## Troubleshooting

- **Server exits at startup:** start `pnpm payo serve --dev-fakes` in one terminal
  and run `pnpm payo doctor` in another to see the real checks; fake mode still
  reports real doctor results.
- **`connection refused` / `invalid bearer token`:** the server is not running,
  or the CLI and server use different `PAYO_DATA_DIR`.
- **Real mode reports missing role models:** set `[model].provider` and `id`, configure every missing `[roles.<role>].model`, or use `PAYO_MODEL` and `PAYO_PI_PROVIDER`.
- **Doctor reports missing role files:** add every path it names. The detailed rubric lives under `skills/architecture-audit/references/` and `skills/code-quality-audit/references/`; Payo does not install or fall back to the old three-file set.
- **`PAYO_MODEL must not include a provider`:** use `PAYO_MODEL=<model>` and
  `PAYO_PI_PROVIDER=<provider>`.
- **`PAYO_SCENARIO requires --dev-fakes`:** add `--dev-fakes`, or unset it.
- **`no editor configured`:** export `VISUAL` or `EDITOR` before `payo edit`.
- **`conflict`:** the run is not in a stage that allows that command; check
  `payo status`.

## Current limits

- Execution is local only: no GitHub publication, push, PR creation, merge/rebase,
  automatic stacking, or automatic next-PR execution. There is one configured
  repository-wide check suite, not language detection or per-phase command
  selection.
- Writable Pi is trusted local-code execution, not a sandbox. The writer can
  run code and child processes with the server user's permissions and inherited
  environment; a worktree is not filesystem, process, network, or credential
  confinement. Payo terminates writable process groups on cancellation, but do
  not run untrusted repositories or role/config content without understanding
  this boundary. Container/OS sandboxing is not provided.
- The Payo activity view covers Payo runs only. Independent Pi swarms have no
  dashboard in this repository.
- One local server per configured loopback port (default `7331`).
- Execution branches/worktrees are retained and are not automatically deleted;
  cleanup is the operator's responsibility after stopping active work.
