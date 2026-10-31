---
date: 2026-10-30
title: Payo project overview and current implementation
question: What is Payo, and what has been implemented so far?
commit: a5e2b4c
---

## Answer

**Payo is the planned local agent-workbench platform inside `agentic-hub`; its first workflow is an agentic software factory that takes a ready Jira ticket through planning, review, human approval, and eventually implementation and pull requests.** The near-term engine design explicitly makes the factory the first module; the broader ideas—PR-review and incident workflows, context, evaluation, routing, profiling—are longer-term workbench scope, not current capabilities (`docs/payo/engine-design.md:3,9`; `docs/payo/agentic-factory.md:5,18-22`; `docs/payo/high-level-architecture.md:54-70`).

**What exists today is the reusable execution foundation, not the end-to-end factory.** Payo has a TypeScript workspace, typed run/event contracts, a kernel with event-derived state and recovery, in-memory and SQLite stores, and a bounded agent-step runner with validation/retry, cancellation, timeouts, fan-out, and a fake runner. The factory, real Pi/Jira/Git adapters, server, and CLI are still placeholders (`payo/packages/kernel/src/run.ts:84-159`; `payo/packages/kernel/src/agent-step.ts:46-65`; `payo/modules/factory/src/index.ts:1`; `payo/adapters/runner-pi/src/index.ts:1`; `payo/apps/server/src/main.ts:1-4`).

## How it works

The intended product flow starts with a ready Jira ticket. The factory plans work into phases/PRs, runs plan review and revision loops, then pauses for human approval; implementation, checks, implementation review, and draft PRs are later stages (`docs/payo/agentic-factory.md:18-37`). In the first implementation slice, the design narrows this to ticket → approved plan, with structured plan/review output, up to three review rounds, and a gate for unanswered questions or human decisions (`docs/payo/engine-design.md:145-167`; `docs/payo/implementation-roadmap.md:68-82`).

The intended runtime is one local process: a kernel hosts the workflow module and adapters, while CLI/web clients talk to it. The design favors SQLite as the append-only source of truth, deriving run state by replaying events; recovery marks interrupted work and raises a gate instead of blindly re-running it (`docs/payo/engine-design.md:9-16,52-74,138-143`).

The implemented kernel foundations are:

1. **Contracts and run lifecycle.** Zod schemas define run, step, attempt, gate, artifact, usage, and normalized agent-event records (`payo/packages/contracts/src/run.ts:23-119`; `payo/packages/contracts/src/agent.ts:6-61`). The reducer applies events to state while enforcing lifecycle invariants (`payo/packages/kernel/src/state.ts:25-52,58-185`).
2. **Persistence and recovery.** `RunStore` supports append/read plus content-addressed artifacts; the memory implementation is useful for tests, and the SQLite adapter persists ordered events and verifies artifact hashes (`payo/packages/kernel/src/store.ts:10-24,42-106`; `payo/adapters/store-sqlite/src/index.ts:45-48,87-137,140-197`). `openRun` folds the event log and commits recovery events for unfinished attempts/steps (`payo/packages/kernel/src/run.ts:84-159`).
3. **Agent execution primitives.** `runAgentStep` records step and attempt events, validates a final output envelope, retries rejected output once with its error/output as artifact inputs, and otherwise finishes or raises a gate (`payo/packages/kernel/src/agent-step.ts:46-119`). The runner stream is bounded by timeout/cancellation; the first terminal result/error/abort/deadline wins (`payo/packages/kernel/src/agent-step.ts:145-175,181-260`). The kernel also has a shared concurrency limiter and fan-out that reports rejected children as unchecked (`payo/packages/kernel/src/fanout.ts:5-39,42-56`).
4. **Architecture guardrails and checks.** The pnpm workspace declares `pnpm check` as Biome + TypeScript + Vitest (`payo/package.json:5-17`). Biome rules and fixture tests enforce package boundaries, such as kernel→contracts and module/adapter separation (`payo/biome.json:9-35`; `payo/test/boundaries.test.ts:54-107`). CI has a Node 24 Payo job (`.github/workflows/ci.yml:44-65`).

## Key files

| File | Role |
|---|---|
| `docs/payo/agentic-factory.md` | Product vision and eventual ticket-to-PR flow. |
| `docs/payo/engine-design.md` | Near-term engine choices and factory-first v1 scope. |
| `docs/payo/implementation-roadmap.md` | Ten-step sequence from scaffold through real run, PR implementation, and web UI. |
| `payo/packages/contracts/src/` | Zod contracts for run and agent data. |
| `payo/packages/kernel/src/` | Event reduction, store port, recovery, agent execution, concurrency, and fan-out. |
| `payo/adapters/store-sqlite/src/index.ts` | SQLite event store and content-addressed artifact files. |
| `meta/plans/2026-10-30-payo-factory-slice-1.md` | Current draft plan for the next factory workflow slice; it is not implementation. |

## Findings

- **Payo’s current product direction is factory-first.** The design says Payo is the platform and the factory its first module; the ticket-to-PR narrative is the product goal (`docs/payo/engine-design.md:3,9`; `docs/payo/agentic-factory.md:5,18-22`). _(verified)_
- **The core mechanics are real, but the business workflow is not wired yet.** Run recovery and agent-step execution exist in the kernel; the factory entry point is empty (`payo/packages/kernel/src/run.ts:84-159`; `payo/packages/kernel/src/agent-step.ts:46-65`; `payo/modules/factory/src/index.ts:1`). _(verified)_
- **Persistence is implemented behind a port.** The SQLite adapter creates a versioned event table, appends with expected-sequence checks, parses events on read, and stores artifacts as hashed files (`payo/adapters/store-sqlite/src/index.ts:45-48,67-78,87-137,140-197`). _(verified)_
- **The real external execution adapters and user-facing entry points remain stubs.** Pi, Jira CLI, Git, CLI, and factory source entry points contain only `export {};`, while the server prints “not implemented” (`payo/adapters/runner-pi/src/index.ts:1`; `payo/adapters/jira-acli/src/index.ts:1`; `payo/adapters/git/src/index.ts:1`; `payo/apps/cli/src/index.ts:1`; `payo/modules/factory/src/index.ts:1`; `payo/apps/server/src/main.ts:1-4`). _(verified)_
- **The next slice is planned, not delivered.** The current factory slice plan is marked `draft` and says the factory module is empty; its scope is the fake-backed planning/review/approval state machine (`meta/plans/2026-10-30-payo-factory-slice-1.md:1-20`). _(verified)_
- **The factory draft is not yet ready to implement.** Its review verdict is `REVISE`, with two P1 findings: a crash after a successful agent step but before the factory checkpoint has no guaranteed recovery gate, and recorded skill SHAs do not prove the exact instructions executed. It also asks for a multi-lens recovery test (`meta/reviews/plans/2026-10-30-payo-factory-slice-1-review-1.md:1-4,18-26`). _(verified)_
- **The test evidence is positive but not freshly reproduced here.** The agent-execution plan’s implementation log reports 220 tests passing after phases 3–4 (`meta/plans/2026-10-30-payo-agent-execution.md:574-585`). In this session I could not rerun them: the checkout has no `payo/node_modules`, and the `pnpm` mise shim reports no pnpm version configured. _(verified as a repository note and session environment; test result itself not independently verified)_

## Gotchas

- **The README’s Payo status is stale/too broad.** It still labels `payo/` “scaffold only” and says the engine is not implemented (`README.md:190-200,215-227`), even though the committed kernel, SQLite store, and agent execution code are substantive. A more precise description is “kernel foundation implemented; factory and application flow not implemented.”
- **There are two scopes in the docs.** The high-level workbench proposal includes PR review as an early workflow and also outlines context, incidents, evaluation, routing, and profiling (`docs/payo/high-level-architecture.md:54-70,85`). The later engine design says it takes precedence for near-term decisions and puts the factory first; it defers routing, gateway, profiling, and module registry until later (`docs/payo/engine-design.md:3,48`; `docs/payo/implementation-roadmap.md:139-147`).
- **The current green status is historical, not rechecked in this environment.** The repo records the 220-test result, but this checkout lacks installed JS dependencies and a configured pnpm version. CI configuration exists, but I did not inspect a CI run result.
- **There are local untracked factory planning files.** The step-4 draft plan and its `REVISE` review are present in the working tree as `??`; they are planning/review material, not a committed or implemented factory feature.

## Open questions

### Answerable with more digging

**Does `pnpm check` pass at the current checkout?**  
Unresolved because: the plan records a 220-test pass, but this session could not execute it (`pnpm` is not configured and dependencies are not installed).  
Blocks: confidence that the current committed snapshot is green.  
Next probe: use the intended Node 24/pnpm 10.9.0 toolchain, install with the lockfile frozen, run `pnpm check`, and/or inspect the latest CI run.

**Has the factory slice plan been revised to resolve its review blockers?**  
Unresolved because: the current review verdict is `REVISE`; the draft does not yet specify recovery for a crash between completed agent work and its checkpoint, nor bind the skill SHA to the instructions actually read (`meta/reviews/plans/2026-10-30-payo-factory-slice-1-review-1.md:1-4,18-26`).  
Blocks: starting step-4 implementation without risking a stranded/lost operation or inaccurate role provenance.  
Next probe: update the draft with a durable in-flight operation/reopen policy, verified or snapshotted skill content, and a multi-lens recovery test, then re-review.

### Unanswerable from this repo

**Are the required live Jira/Pi/Enterprise Claude credentials and test accounts available for the first real ticket run?**  
Unresolved because: the design and roadmap describe adapters and smoke tests, but the real adapters are stubs and no live environment state is stored here (`docs/payo/implementation-roadmap.md:97-120`; `payo/adapters/runner-pi/src/index.ts:1`; `payo/adapters/jira-acli/src/index.ts:1`).  
Blocks: the first real ticket run after factory logic and server wiring exist.  
Next probe: check the developer environment and confirm access to `pi`, `acli`, and the intended repository; do not put credentials in the repo.
