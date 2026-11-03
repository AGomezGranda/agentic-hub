# Payo implementation roadmap

Status: planning snapshot, not a live task list. The workspace, kernel, planning
flow, real adapters, server/CLI, web UI, and approved-plan execution through
sequential phases, bounded review/repair, and restart recovery are implemented.
GitHub publication and PR automation remain future work. See [usage](usage.md)
for current behavior and source code for implementation details.

## Shape

The original sequence was to build inside-out on fakes, then swap in real
adapters. Slice 1 (work item → approved plan) accepts Jira and direct-prompt
inputs. Steps 1–6 describe the implemented foundation; step 7 records real-run
tuning goals rather than a verified completion claim. The web UI in step 10 and
approved-plan execution in step 8 have since been implemented. Step 9 (GitHub/PR
automation) remains future work; Linear is also future work.

```mermaid
flowchart LR
  S1["1 Scaffold"] --> S2["2 Kernel + store"]
  S2 --> S3["3 Agent execution"]
  S3 --> S4["4 Factory slice 1 (fakes)"]
  S4 --> S5["5 Server + CLI"]
  S3 --> S6["6 Real adapters"]
  S5 --> S7["7 First real run"]
  S6 --> S7
  S7 --> S8["8 Implement per PR (implemented)"]
  S8 --> S9["9 Draft PRs + PR review (future)"]
  S5 --> S10["10 Web UI (implemented)"]
```

Step 6 can run in parallel with steps 4–5 once step 3 has fixed the `AgentRunner` and `AgentEvent` contracts.

## Slice 1: work item → approved plan

### 1. Workspace scaffold

**Goal:** an empty `payo/` workspace whose tooling enforces the dependency rules from day one.

- pnpm workspace with the package layout from the design (`packages/`, `modules/factory`, `adapters/*`, `apps/*`), empty but wired.
- Node 24 (type stripping, `node:sqlite`), TS strict with `tsc --noEmit`, Biome, Vitest, Zod.
- One `pnpm check` that runs lint, types and tests. Add it to the repo README and as a Node 24 job in `.github/workflows/ci.yml`, beside the Python job.
- Dependency rules as package dependencies plus Biome restricted imports.

**Done when:** `pnpm check` passes. A deliberate `kernel → adapter` or `module → module` import fails it.
**Settles:** whether Biome is enough to enforce the rules, or a dependency checker is needed.

### 2. Kernel core and event store

**Goal:** durable runs whose state is derived from an append-only event log.

- `contracts`: Zod schemas for `RunEvent` and the records (Run, Step, Attempt, Gate, Artifact refs).
- `kernel`: `RunStore` port, a reducer from events to run state, gate raising and resolving, `expectedSeq` concurrency.
- Effective configuration (per-role model and limits, concurrency, data dir) resolved once and recorded on the Run, so a run never changes under a config edit.
- `store-sqlite`: `node:sqlite` event table in `~/.payo/payo.db`, immutable content-hashed artifacts in `~/.payo/artifacts/`. Data dir is configurable so tests use a temp dir.
- Restart: rebuild state from events; running attempts become `interrupted` and raise a gate.
- Usage and cost are typed as `number | "unknown"`, never defaulted to `0`.

**Done when:** tests cover append and read, a stale-`expectedSeq` rejection, rebuilding after reopen, and interrupted attempts after a simulated crash, against both an in-memory store and SQLite.
**Excludes:** intent/outcome reconciliation for external effects (step 9).

### 3. Agent execution

**Goal:** the kernel can run one agent step and a fan-out of them, observably, against a fake harness.

- `AgentRunner` port, `AgentSpec`, and the normalised `AgentEvent` union in `contracts`.
- `runner-fake`: scripted event streams and results, including invalid output, errors and hangs.
- Attempt lifecycle: record role, runner, model (or harness-owned), role spec and skill SHA, input artifact hashes, usage, outcome. Stream events into the run log.
- Output contracts: validate the final JSON envelope with Zod; retry once with the validation error, then escalate.
- Timeout and cancellation through `AbortSignal`.
- Fan-out helper: parallel attempts with a concurrency limit shared across runs, since every agent hits the same login; a failed child is reported as unchecked, not as clean.
- Every attempt starts with a clean context: its inputs are artifacts (work-item snapshot, plan version, findings), never a previous session. This answers the factory's context-management question.
- Role spec rendering: skill path relative to the repo, factory overrides, skill git SHA.

**Done when:** tests with `runner-fake` cover a valid run, invalid-then-valid, invalid twice → escalation, timeout, abort, and a fan-out with one failing child.

### 4. Factory module, slice 1, on fakes

**Goal:** the full slice 1 state machine running end to end in tests.

- `WorkItemSource` and `Workspace` ports with fakes. Jira and prompt are explicit request variants; prompt content is persisted by artifact reference.
- State machine: ResolveWorkItem → Plan → PlanReview ⇄ Revise → Approval → Approved, with Escalated after round 3 and `resume`. Keep the old `FetchTicket` stage readable for persisted runs.
- Role specs and output contracts for planner (plan markdown, PR strategy, `openQuestions[]`), plan-review lenses, verifier, and reviser. Agents are read-only and return content in the envelope; the engine writes the artifacts.
- Fixed lenses are architecture, security, test coverage, code quality, correctness, simplicity and compatibility, from `skills/review-plan/references/lenses.md`. The fan-out → verifier shape and the verifier's classification rules come from `pi/workflows/swarm.js`, whose lenses are diff lenses and do not apply to a plan.
- Convergence: stop when no verified P0/P1 blocker remains; escalate at round 3. Explicit resume or request-changes starts a new cycle at round 1. Decided from structured output only. A failed lens blocks convergence: an unchecked lens is not a clean one.
- Escalation also when the reviser reports findings it cannot reconcile (the factory's "contradicting findings" case), not only at round 3.
- Plan versions: each agent version is an immutable artifact. The file you edit is a working copy under `~/.payo/runs/<run>/plan.md`; `approve` and `request-changes` snapshot it as a new version.
- Approval gate: `approve` is rejected while any open question lacks an answer; answers are written back into the plan; the agent-to-approved diff is recorded as a metric. `request-changes` snapshots the edited file and returns to PlanReview without a separate feedback message.
- Commands as plain library functions (`start`, `answer`, `approve`, `requestChanges`, `resume`) so step 5 only wraps them.

**Done when:** tests drive each transition in the design's state diagram with fakes, including approval blocked by an open question, a failed lens blocking convergence, and both escalation paths.
**Settles:** the exact JSON envelopes for each role; a fixed set of lenses is used in this slice.

### 5. Server and CLI

**Goal:** a human can drive a run from the terminal.

- `apps/server`: the only composition root. `payo serve`, HTTP commands and queries, SSE run event stream. Loopback only, with a local token and origin checks.
- `apps/cli`: preserve `payo start ABC-123`, add `payo start --prompt <text...>`, plus `status`, `logs -f`, `answer`, `approve`, `request-changes`, `resume`, and a way to open the plan file in `$EDITOR`.
- A client disconnect never cancels a run.
- Wired to fakes for now behind a dev flag, so the flow is usable before step 6 lands.

**Done when:** an end-to-end test starts the server on a temp data dir, runs a fake ticket to Approved through the CLI, and restarts the server mid-run without losing state.
**Settles:** web UI authentication baseline (reused by step 10).

### 6. Real adapters for slice 1

**Goal:** real harness, tickets and worktrees behind the ports.

- `runner-pi`: spawn `pi --mode json` with `--tools`, `--model`, per-attempt `--session-dir` and the `--no-*` isolation flags. The snapshotted role text is passed as the prompt; `--skill` is intentionally not used. Strict LF-split JSONL parsing, mapping to `AgentEvent`, raw log kept as an artifact, token and cost recorded as an estimate.
- `jira-acli`: `acli jira workitem view` maps Jira data into the shared `WorkItem` snapshot. Read-only; prompt requests resolve in the server without `acli`.
- `git`: `Workspace` as worktrees in `~/.payo/worktrees/<run>/` detached at the resolved base commit. Removed on approve and retained while a run is resumable; escalated, cancelled and abandoned worktrees are a known cleanup gap deferred to a later slice.
- Run, step and attempt IDs passed to every adapter and kept in their logs.
- `payo doctor`: reports `pi`, `acli`, `git` and role-skill readiness. Only `pi`, `git` and skills block server startup; `acli` is required when a Jira run resolves its source.
- Adapter tests against recorded fixtures (pi JSONL, acli JSON), plus opt-in live smoke tests that do not run in `pnpm check`.

**Done when:** fixture tests pass, a live smoke test runs one read-only Pi step in a worktree and returns a valid envelope, and a read-only step that tries to write is blocked.
**Settles:** whether parallel Pi runners sharing one OAuth login race on token refresh, and the workaround if they do (for example, a concurrency limit or a warm-up call).

### 7. First real run and tuning

**Goal:** slice 1 works on real tickets, and the role specs are good enough to keep.

- Tune the real adapters now that they are the default.
- Run 3–5 real tickets from ticket to approval. Tune role spec overrides from what goes wrong; fork a skill only if overrides fight it.
- Check the records answer the factory's metrics: plan edits at approval, review rounds, cost per ticket.
- Keep each ticket's snapshot, plan versions and approved plan as a small labelled corpus. It is the baseline for later evaluation, so role-spec changes are compared, not judged by feel.

**Done when:** those tickets reach Approved or a justified escalation, and every attempt is inspectable from `payo logs`.
**Output:** a short findings note feeding the step 8 plan.

## Approved-plan execution (implemented)

Phase 8 accepts one PR unit by explicit CLI command, pins the approved plan and
base, validates an executable phase manifest, and executes phases sequentially
in a retained local branch/worktree. Engine-owned checks and all mandatory
review lenses gate phase receipts. Verified blockers and failed checks use
bounded fresh-context repair. The last phase receives full PR-wide checks and
review with a separate final repair budget. Restart gates preserve edits and
accepted receipts; explicit resume reconciles partial work and commit intent.
See [usage](usage.md) for the CLI, `[execution].checks` TOML, local-code trust
boundary, status, and cleanup ownership.

### 9. Draft PRs and human PR review

`gh` `CodeHost` adapter. Intent and outcome events around push and PR creation, reconciled against GitHub before any retry. Human PR review gate: code changes go back to implementation review, plan changes back to approval. Record how much you change at PR review, the factory's second quality metric. Mark ready and mark phases done in the plan. A `next PR` gate: the next PR may start once the previous one is open, branching from it, but opens only after the previous one merges and it is rebased onto the base branch.

### 10. Web UI (implemented)

`apps/web` provides the local Vite/React console: run creation and list, run workspace with live activity, plan review and gate actions, and shared TOML settings. Plans remain editor-managed. This is the supported dashboard for Payo runs; independent Pi swarms are outside its scope. See [usage](usage.md#web-ui) and [`payo/apps/web/README.md`](../../payo/apps/web/README.md) for the current workflow and app boundaries.

## Open for review

- **Other repositories.** The factory's planner researches "other repositories when defined or needed"; the design's Run has one repo. Proposal: one repo in slice 1, read-only extra repos later.
- **Architecture document.** That document's first slice was the PR reviewer, with a baseline comparison. The engine design moves the factory first, and its section on precedence says the engine design wins. The PR reviewer stays a later module.

## Not in this roadmap

Claude Code and Codex runners, Ollama Cloud, model routing, the gateway, profiling and other workflow modules. They stay in the [architecture document](high-level-architecture.md) until a step needs them.
