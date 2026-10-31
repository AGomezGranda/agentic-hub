---
date: 2026-10-30
title: Payo step 5 — server and CLI
status: Complete
---

Roadmap step 5 of [docs/payo/implementation-roadmap.md](../../docs/payo/implementation-roadmap.md#5-server-and-cli). This step exposes the factory over a loopback-only HTTP/SSE server and a local CLI. It uses fake ticket, workspace, and runner adapters until step 6.

## Current State

- The roadmap requires `payo serve`, HTTP commands and queries, an SSE run stream, loopback binding, a local token and origin checks, the CLI command surface, disconnect-independent runs, and an end-to-end test that reaches Approved and survives a server restart: `docs/payo/implementation-roadmap.md:85-95`.
- The agreed process model makes the server the sole composition root and the CLI a thin HTTP/SSE client: `docs/payo/engine-design.md:10, 32-44`.
- The server entry point is a placeholder (`payo/apps/server/src/main.ts:1-4`); its existing smoke test launches that TypeScript file under plain Node (`payo/apps/server/src/main.test.ts:6-12`). The CLI entry point is empty (`payo/apps/cli/src/index.ts:1`), and its package has no `bin` entry (`payo/apps/cli/package.json:1-12`).
- `@payo/server` already depends on contracts, kernel, factory, runner-fake, and store-sqlite (`payo/apps/server/package.json:6-12`). `@payo/cli` currently depends only on contracts (`payo/apps/cli/package.json:9-11`).
- The factory exports `start`, `openFactory`, `resume`, `answer`, `requestChanges`, and `approve` (`payo/modules/factory/src/index.ts:1-14`). `FactoryDeps` requires a store, runner, limiter, ticket and workspace ports, data directory, and role sources; `StartInput` requires run ID, ticket key, repo, base branch, role configuration, and an abort signal (`payo/modules/factory/src/types.ts:22-43`). `start` currently runs the workflow before returning its handle (`payo/modules/factory/src/commands.ts:329-388`), so the server cannot yet retain a live handle before returning `202`. `openFactory` delegates to `openRun`, then persists an escalation gate when it finds an interrupted in-flight operation (`payo/modules/factory/src/commands.ts:391-434`).
- `RunStore` can append and read events by run ID, store and load artifacts, and close, but cannot list run IDs (`payo/packages/kernel/src/store.ts:10-24`). The event log already carries sequence numbers and timestamps (`payo/packages/contracts/src/run.ts:23-87`).
- The repository already has an HTTP/SSE testing precedent in `tools/swarm-viewer/test/e2e.test.js:107-127`; it checks stream output and rejects a foreign Host header. Payo will use its own contracts and server implementation.
- The root README still calls Payo a scaffold (`README.md:215`). CI already runs `pnpm check` on Node 24 (`.github/workflows/ci.yml:44-65`), and `payo/package.json:10` defines `check` as Biome, TypeScript, and Vitest.

## Design Decisions

- **One configured default repository, with per-run overrides.** The server resolves `PAYO_REPO` (default: its startup working directory) and `PAYO_BASE_BRANCH` (default: `main`). `payo start <ticket>` uses those defaults; optional `--repo` and `--base` flags override them for that run. Store the selected values in the run record. This keeps the first setup simple while leaving each run tied to one explicit repository and base.
- **Explicit run IDs after start.** The server generates a UUID and `payo start` prints it. `status`, `logs`, `answer`, `approve`, `request-changes`, `resume`, and `edit` all require that ID. This supports overlapping runs without an implicit “current” run and gives a future web client a stable identifier.
- **Versioned wire contracts in `contracts`.** Add Zod request and response schemas under `payo/packages/contracts/src/api.ts`. The CLI imports those schemas and no server, kernel, module, or adapter package. Use `/api/v1` so later web clients share a stable contract.
- **Minimal run listing for the future UI.** Add `RunStore.listRunIds(): Promise<string[]>`, implemented by memory and SQLite stores and covered by the shared store contract. Expose `GET /api/v1/runs`, which returns compact summaries sorted newest first. This is the only store-port addition; it avoids having the future web UI scan SQLite or depend on CLI state.
- **HTTP surface.** Implement `POST /api/v1/runs`, `GET /api/v1/runs`, `GET /api/v1/runs/:runId`, `GET /api/v1/runs/:runId/events?fromSeq=N`, `GET /api/v1/runs/:runId/events/stream?fromSeq=N`, and `POST /api/v1/runs/:runId/{answer,approve,request-changes,resume}`. Use JSON DTOs rather than exposing kernel `Map`s. Start, resume, and request-changes return `202` with the run ID while the server owns their work; answer and approve return the updated summary. Invalid input, missing runs, busy commands, and unauthorized requests have distinct HTTP status codes and a small `{code,message}` error contract.
- **Run lifetime belongs to the server.** Add `beginFactory` to persist the run/checkpoint and return a handle without launching agents, plus `executeFactory` to run that handle; preserve `start` as `beginFactory` followed by `executeFactory` for existing callers. `beginFactory` stores artifact bytes first, then appends `run.created`, initial role-artifact references, and the checkpoint reference as one atomic event batch, so a listed run is never visible without its initial checkpoint. The HTTP composition root calls `beginFactory`, registers the handle, schedules `executeFactory`, and returns `202`. Keep one handle per run. Track server-owned task promises and abort controllers; background command promises are not tied to request or SSE sockets. A disconnect closes only that client connection. On graceful shutdown, stop accepting new work, abort active tasks, wait for them to settle and persist their state, then close the store. On process crash, enumerate IDs and call `openFactory`; kernel/factory recovery records interruptions but never automatically resumes agent work. Do not open an already-cached live handle again.
- **SSE replays persisted events.** Read from the requested sequence or `Last-Event-ID`, emit each stored event with its sequence as the SSE ID, then poll `RunStore.read` every 250 ms while the run is active. A 15-second comment heartbeat keeps an idle stream alive. Stop polling on socket close or `run.ended`; do not alter or cancel the run. Polling avoids adding a transient event bus that would need to coordinate with durable append. Require Authorization on the stream; the CLI and future browser use `fetch` streaming, not native `EventSource`, so the token never appears in a URL.
- **Local-only authentication.** Bind to `127.0.0.1:7331` in normal operation; injected tests may use port `0`. Reject Host values not matching the bound loopback address. Generate a 256-bit bearer token once under `<dataDir>/server-token` with owner-only permissions; use it for all API routes and SSE. Ensure the data directory and server-owned files, including the SQLite database, artifacts, token, and working plans, are inaccessible to other local users where POSIX permissions apply; correct permissions on existing server-owned paths as well as newly created ones. CLI requests have no Origin and are accepted only with a valid token. Requests that include Origin must match the server’s own origin or one of the exact origins in `PAYO_WEB_ORIGINS`; never use `*`. Allow unauthenticated `OPTIONS` only as a preflight for an exact allowlisted origin, with the actual request still requiring its bearer token. Add `payo token` as the explicit way to display the local token for later browser use. The future web UI will ask for the token, keep it in memory, and use authenticated fetch streaming; this step does not build that UI.
- **Fake mode is explicit until step 6.** `payo serve` requires `--dev-fakes` in this step and fails with a clear message otherwise. The development composition uses the existing fake adapters and fixed role-source fixtures; it never contacts Jira, Pi, or Git. Create the SQLite store under `PAYO_DATA_DIR` (default `~/.payo`) and one shared limiter per server process. Record the effective role settings and concurrency limit in each run’s configuration; use `PAYO_MAX_CONCURRENT_AGENTS` (default `4`) to construct the process-wide limiter. On startup, cap it at the minimum of the configured value and the recorded limits of all active runs; use that effective value for new runs until the next process restart.
- **The plan editor remains local.** `payo edit <run-id>` confirms the run and plan are available, then opens `<dataDir>/runs/<runId>/plan.md` using `$VISUAL` or `$EDITOR`. All CLI local-file operations resolve `PAYO_DATA_DIR` exactly like the server (default `~/.payo`), including `edit` and `token`. Run directories and plan files are owner-only on POSIX, including existing paths. If neither editor is set, fail with an actionable message. The editor does not send file contents through the API.
- **CLI executable launch.** Add a `payo` bin entry to `@payo/cli`. Its `serve` subcommand starts `apps/server/src/main.ts` as a child process and forwards arguments, stdio, and termination signals; it does not import server modules. All other commands remain HTTP clients. Document a supported workspace invocation (for example, `pnpm --filter @payo/cli exec payo ...`) or an explicit local-bin PATH setup so a fresh checkout can run the command. This preserves the composition boundary while providing the single `payo` command family.

## Risks & Mitigations

- **A request or stream disconnect accidentally aborts factory work.** Start and long-running commands execute in server-owned background tasks; integration tests close the initiating connection and still observe completion.
- **Loopback alone is vulnerable to hostile browser origins and DNS rebinding.** Require a bearer token, exact Host validation, exact Origin allowlisting for browser requests, and no wildcard CORS. Test missing/incorrect tokens and hostile Host/Origin headers.
- **Concurrent server processes could race on one run log.** Bind the fixed production port before recovering runs or accepting requests; a second production process must fail before opening handles. Keep production binding fixed at `7331`; for spawned-process tests only, accept `PAYO_TEST_PORT` (including `0`) when `NODE_ENV=test`, report the actual bound address on the test readiness channel, and let the test CLI use that loopback URL. Test that the override is rejected outside test mode.
- **A restart may repeat an unsafe operation.** `openFactory` performs recovery, but the server does not auto-resume. A user must explicitly invoke `resume`; test that the interrupted attempt and recovery gate are visible first.
- **The store port changes for run listing.** Implement `listRunIds` in both existing stores and extend the same shared contract before using it in HTTP. Keep summaries in `contracts`; the server never queries SQLite directly.
- **A changed concurrency setting can alter active work after restart.** Record the value on each run and set the process-wide limiter to the minimum of the configured value and every active run’s recorded value. New runs record that effective cap, so a setting increase cannot raise an interrupted run’s ceiling. Test this calculation with active and completed runs.
- **The default repo/base may be wrong for a particular checkout.** Allow per-run `--repo` and `--base` overrides and show the effective values in `status`; manually verify the recorded `run.created` fields before step 6 adds real worktrees.
- **The token file may be copied or exposed in terminal output.** Do not print it during `serve`, log Authorization headers, or include it in errors. Display it only on explicit `payo token`; verify owner-only file permissions on supported POSIX systems.

## Phase 1 — Server composition, API, and security

### Overview

Create a durable server composition root and the versioned API that can drive a fake run without a CLI. The server is loopback-only, authenticated, restart-aware, and independently testable with a temporary data directory.

### Changes

- Add `payo/packages/contracts/src/api.ts` and export it from `contracts/src/index.ts`. Define Zod schemas for `StartRunRequest` (`ticketKey`, optional `repo`, optional `baseBranch`), `AnswerRequest` (`questionId`, nonblank `text`), `ApiError`, and `RunSummary` (`runId`, repo, base branch, run status/outcome, factory stage, started/updated timestamps, open gates). Keep event payloads as the existing `RunEvent` schema. Add `api.test.ts` for valid payloads, missing fields, invalid IDs, invalid question answers, and JSON-safe summaries.
- Add `listRunIds()` to `RunStore` in `payo/packages/kernel/src/store.ts`; implement it in `createMemoryRunStore` and `createSqliteRunStore` (`payo/adapters/store-sqlite/src/index.ts`). Extend the shared store contract to check empty results, distinct IDs, and deterministic ID ordering; add the SQLite case for two runs in one database. Write these tests before the implementations.
- Add `maxConcurrentAgents` to `StartInput` and persist it with the existing effective factory configuration in `payo/modules/factory/src/commands.ts`. Update the factory flow and persistence test builders to supply it. The server constructs exactly one limiter from the same value for all runs.
- Refactor the factory runner in `payo/modules/factory/src/commands.ts` into exported `beginFactory(deps, input: Omit<StartInput, "signal">): Promise<FactoryHandle>` and `executeFactory(handle, input: { signal: AbortSignal }): Promise<FactoryHandle>`. `beginFactory` snapshots role sources and writes the initial run/checkpoint only; `executeFactory` owns the existing state-machine loop and busy guard. Keep `start(deps, input: StartInput)` behavior unchanged by making it call both in order with `input.signal`. Export the new functions from `modules/factory/src/index.ts`.
- Add `payo/apps/server/src/config.ts` for `PAYO_DATA_DIR`, `PAYO_REPO`, `PAYO_BASE_BRANCH`, `PAYO_MAX_CONCURRENT_AGENTS`, `PAYO_WEB_ORIGINS`, and `--dev-fakes` parsing. Defaults are `~/.payo`, server startup cwd, `main`, and `4`, respectively. Validate absolute data/repo paths, positive integer concurrency, and exact loopback origins. Production always binds to fixed port `7331`. An explicit `PAYO_TEST_PORT` override, including port `0`, is accepted only when `NODE_ENV=test`; other injected listener ports must be within `0..65535`.
- Add `payo/apps/server/src/auth.ts` to create/read `<dataDir>/server-token`, compare bearer tokens without early byte-by-byte exit, validate Host and Origin, and produce exact CORS headers only for the allowlist. Ensure `<dataDir>` and server-owned files are owner-only where POSIX permissions apply, correcting permissions on existing paths as well as new ones. Extend `payo/modules/factory/src/plans.ts` so run directories are mode `0700` and plan/temp files are mode `0600`; add POSIX-conditional tests for new and pre-existing paths in `modules/factory/src/plans.test.ts`.
- Add `payo/apps/server/src/composition.ts` to create the SQLite store, fake runner/ticket/workspace/role-source dependencies, one limiter, a run-handle map, tracked task promises and abort controllers, and startup recovery for every `listRunIds()` result. The start route calls `beginFactory`, registers its returned live handle, then schedules `executeFactory`; this makes status and SSE queries safe while attempts are running. Keep this file as the only place that imports concrete adapters. Use the fake fixture ticket `ABC-123`; the scripted fake produces one plan with one open question and a clean seven-lens review.
- Add `payo/apps/server/src/http.ts` for the routes above, JSON size limit of 64 KiB, safe JSON/error responses, and SSE polling. The handler uses only server services and contracts, not SQLite internals. Start/review/resume work is scheduled on the server and errors are caught and logged without token data.
- Replace the placeholder in `payo/apps/server/src/main.ts` with `node:http` startup, bind to `127.0.0.1:7331`, fail unless `--dev-fakes` is present, and handle termination signals by stopping new requests, aborting active task controllers, awaiting task settlement, then closing the listener and store. Bind before run recovery so another production server on the fixed port fails before it can become a writer; return `503 starting` until recovery completes. Under `NODE_ENV=test`, support `PAYO_TEST_PORT` and emit the actual bound address on the readiness channel for process tests.
- Add focused tests before implementation:
  - Unit `apps/server/src/config.test.ts` and `auth.test.ts`: defaults and overrides; invalid paths/concurrency/origins; token creation and reload; owner-only mode; missing/wrong token; exact Host/Origin acceptance; allowlisted preflight without bearer followed by bearer-required actual request; no wildcard; CLI requests with no Origin; reject `PAYO_TEST_PORT` outside test mode. Extend `modules/factory/src/plans.test.ts` to verify owner-only run-directory and plan-file modes for new and existing paths on POSIX. `http.test.ts` also checks injected listener port validation and `503 starting` before recovery completes.
  - Unit `apps/server/src/composition.test.ts`: compute the effective limiter cap as the minimum configured/active-run value; ignore ended runs; use the configured value when there are no active runs. Inject failures around initial factory persistence and prove recovery never encounters a listed run without a checkpoint or let one such record block recovery of other runs.
  - Unit `packages/contracts/src/api.test.ts`: DTO and request schema edge cases.
  - Component `apps/server/src/factory-flow.test.ts`: `beginFactory` returns at `FetchTicket` without runner calls; `executeFactory` advances the same handle to Approval; the existing `start` helper still completes the flow. This pins the new scheduling seam before server wiring.
  - Integration `apps/server/src/http.test.ts`, using a temp SQLite data dir and fake dependencies: route methods and statuses; invalid body and unknown run; start returns promptly with a registered live handle and reaches Approval; status and list summaries use JSON DTOs; event replay respects `fromSeq`; SSE emits ordered IDs, reconnects from `Last-Event-ID`, and stops on disconnect; a disconnected start request does not cancel the run; unauthorized and hostile-origin requests are rejected.
  - Store integration: existing memory and SQLite contract suites prove `listRunIds` without adding a second ad hoc storage harness, and verify an initial event batch is all-or-nothing in both stores.

### Success criteria

**Automated:**
- `pnpm -C payo exec vitest run packages/contracts/src/api.test.ts packages/kernel/src/store.memory.test.ts adapters/store-sqlite/src/index.test.ts modules/factory/src/plans.test.ts apps/server/src/config.test.ts apps/server/src/auth.test.ts apps/server/src/composition.test.ts apps/server/src/factory-flow.test.ts apps/server/src/http.test.ts`
- `pnpm -C payo check`

**Manual:** Start the fake server with a temporary data directory. Verify it listens only on `127.0.0.1`, rejects an unauthenticated request, accepts a CLI-style request with the token, writes the token with owner-only permissions, and shows the same run ID and current gate in both the status query and event log.

### What we're NOT doing

No real Pi, Jira, or Git adapter; no web UI; no TLS or remote binding; no user accounts; no token rotation; no multi-repository research; no arbitrary CORS origins; no auto-resume; no database-specific HTTP queries.

## Phase 2 — CLI commands and editor

### Overview

Turn the CLI package into the supported `payo` command. It sends versioned requests to the server, prints stable run IDs, streams logs over SSE, and opens the local plan in the user’s editor.

### Changes

- Add a `bin` entry for `payo` to `payo/apps/cli/package.json`, plus a Node 24 shebang and `payo/apps/cli/src/index.ts` argument dispatcher. Add `payo/apps/cli/src/client.ts` for authenticated `fetch`, JSON validation against `@payo/contracts`, and consistent error formatting. Resolve `<dataDir>` from `PAYO_DATA_DIR` with the same `~/.payo` default as the server for local token and plan-file operations. For spawned-process tests only, allow `PAYO_TEST_SERVER_URL` when `NODE_ENV=test` so the CLI can connect to a server bound to an ephemeral loopback port. Keep the package’s runtime imports limited to contracts and Node built-ins.
- Implement these exact commands in `index.ts`:
  - `payo serve --dev-fakes` launches the server child and forwards args, stdin/stdout/stderr, SIGINT, and SIGTERM.
  - `payo start <ticket-key> [--repo <path>] [--base <branch>]` posts to the server, prints the generated run ID, and exits without waiting for the run to finish.
  - `payo status <run-id>` prints the `RunSummary` including the effective repo/base, stage, outcome, and open gates.
  - `payo logs <run-id>` prints stored events; `payo logs <run-id> -f` follows the SSE stream until the run ends or the user interrupts the client.
  - `payo answer <run-id> <question-id> <answer...>`, `payo approve <run-id>`, `payo request-changes <run-id>`, and `payo resume <run-id>` invoke their matching HTTP commands.
  - `payo edit <run-id>` checks status, validates the UUID, and launches `$VISUAL` or `$EDITOR` with `<dataDir>/runs/<runId>/plan.md`; missing editor or plan errors are explicit.
  - `payo token` prints the persisted local bearer token only on explicit request.
- Add focused tests before implementation:
  - Unit `apps/cli/src/args.test.ts`: supported forms, required run IDs, missing values, answer text with spaces, invalid flags, and `--repo`/`--base` overrides.
  - Unit `apps/cli/src/client.test.ts`: bearer header, no Origin header, contract validation, server error mapping, SSE cursor handling, test-only server URL resolution, shared data-directory resolution, and `payo token` output only when explicitly invoked.
  - Unit/process integration `apps/cli/src/editor.test.ts`: launches a fixture editor with the exact plan path under both default and non-default `PAYO_DATA_DIR`, propagates its exit status, and rejects an unsafe run ID without touching another file.
  - Replace `apps/server/src/main.test.ts` placeholder-output assertion with a plain-Node startup/readiness/shutdown assertion, preserving the existing proof that workspace `.ts` packages load without Vitest’s resolver.

### Success criteria

**Automated:**
- `pnpm -C payo exec vitest run apps/cli apps/server/src/main.test.ts`
- `pnpm -C payo check`

**Manual:** Use the documented checkout invocation (for example, `pnpm --filter @payo/cli exec payo`) against the dev fake server. Run a clean ticket through `payo start ABC-123`, `payo status <id>`, `payo logs <id> -f` (then interrupt the follower), `payo edit <id>`, `payo request-changes <id>`, `payo answer <id> <question-id> "Because ..."`, and `payo approve <id>`. Confirm the editor modifies the same plan file the factory snapshots and that `edit`/`token` work with a non-default `PAYO_DATA_DIR`. In a separate hung-run scenario, restart the server and run `payo resume <id>` to verify the explicit recovery command.

### What we're NOT doing

No CLI run picker or implicit latest-run selection; no local TUI; no browser editing; no shell command that bypasses HTTP for factory operations; no real adapter selection.

## Phase 3 — Process-level acceptance and documentation

### Overview

Prove the full human-driven flow through separate server and CLI processes, including a client disconnect and a server crash/restart while a fake attempt is running. Update user-facing Payo guidance without changing the roadmap’s later slices.

### Changes

- Add `payo/apps/server/src/e2e.test.ts` using temporary data directories, actual Node 24 child processes, `payo serve --dev-fakes`, the CLI executable, and SQLite. Run the server subprocess with `NODE_ENV=test` and `PAYO_TEST_PORT=0`, read its actual loopback address from the readiness channel, and pass that address to the CLI through `PAYO_TEST_SERVER_URL`; production remains fixed to port `7331`. No test uses `~/.payo` or live network services.
- Write tests first for two scenarios:
  1. Start the fake `ABC-123` run through the CLI, observe status and logs, edit the plan, invoke request-changes, observe a second clean review cycle, answer the open question, approve it, and assert the persisted run outcome is `approved`, its gate is resolved, and the final plan retains both the edit and answer.
  2. Start a second server with a fake runner that hangs after `attempt.started`; issue start and disconnect the client; verify the run remains active; send `SIGKILL` to simulate an abrupt process crash; restart it with the same data directory; assert the attempt is `interrupted` and the run is gated before any retry; invoke `payo resume <run-id>` with the clean fake scenario; assert it reaches Approval, answer the open question, approve it, and verify the original event history remains intact. Add a separate graceful-shutdown test that sends `SIGTERM` during active work and verifies tasks settle before the store closes.
- Add fake-only scenario selectors in server composition (`clean`, `hang-planner`, and `clean-twice`) so the restart and request-changes tests deterministically control their scripted attempts. Reject unknown scenario names and keep the selector unavailable without `--dev-fakes`.
- Update `README.md`’s Payo section to remove “scaffold only,” document Node 24/pnpm setup and the supported checkout invocation (for example, `pnpm --filter @payo/cli exec payo`), `payo serve --dev-fakes`, the required run-ID workflow, repo/base defaults and overrides, shared `PAYO_DATA_DIR` resolution, local token handling, and the fact that fake mode is not a real ticket integration.
- Update `docs/payo/engine-design.md`’s “Not decided yet” authentication bullet to the implemented baseline: per-install bearer token, loopback-only binding, exact Origin allowlist, `payo token` handoff, session-memory storage by the future web UI, and authenticated fetch-based SSE (not token-bearing URLs or native `EventSource`). Do not change `.github/workflows/ci.yml`; its Node 24 Payo job already runs `pnpm check`.

### Success criteria

**Automated:**
- `pnpm -C payo exec vitest run apps/server/src/e2e.test.ts`
- `pnpm -C payo check`
- The existing `.github/workflows/ci.yml` Payo job passes on Node 24 with the full test suite.

**Manual:** From a temporary `PAYO_DATA_DIR`, run the documented fake flow using the documented checkout invocation; confirm the first process binds only to loopback, the server survives a client disconnect, and restarting after a hung attempt exposes an interrupted gate rather than replaying work. Verify the documented `PAYO_REPO`, `PAYO_BASE_BRANCH`, `--repo`, `--base`, shared data-directory resolution, and token behavior.

### What we're NOT doing

No real-ticket run or live smoke test; no web application; no web token prompt implementation; no production runner/workspace wiring; no automatic resume or retry after restart; no change to later roadmap steps 6–10.

## Nonblocking Assumptions and Validation

- The server defaults `PAYO_REPO` to its startup working directory and `PAYO_BASE_BRANCH` to `main`; CLI flags override either value per run. Server and CLI resolve `PAYO_DATA_DIR` identically, defaulting to `~/.payo`. Validate in the Phase 3 manual smoke test against a repo whose actual base branch is configured explicitly.
- The local browser token is copied with `payo token` and entered manually by the future UI, which keeps it in memory. Validate the origin and bearer contract with the future web app in step 10; no browser page is built here.
- Run-list ordering is newest first, derived from the first/last event timestamps, while `RunStore.listRunIds()` itself promises deterministic ID ordering. Pin both behaviors in the store and API tests.
- `PAYO_MAX_CONCURRENT_AGENTS` is a process-wide safety ceiling shared by runs. Persist the effective value in each new run’s configuration; on restart, cap the limiter at the minimum of the current setting and the recorded values for active runs. Pin this with a composition test where a completed run has a higher value than an active run.

## Plan Validation

Every step-5 roadmap requirement maps to a phase: server and security (phase 1), CLI/editor (phase 2), and disconnect/restart end-to-end acceptance plus user documentation (phase 3). Initial run creation is atomic with its checkpoint; graceful shutdown settles active server-owned tasks before store closure; abrupt-crash recovery is tested separately. Existing factory APIs and package boundaries remain intact except the explicitly scoped concurrency-config field and `RunStore.listRunIds()` addition. No live adapters or web UI are included, and every phase ends with automated checks that run within the existing Payo Vitest/Biome/TypeScript workspace.

## Implementation Notes

Completed 2026-10-31. Verified with `pnpm -C payo exec vitest run apps/server/src/e2e.test.ts` (3 process-level scenarios) and `pnpm -C payo check` (29 test files, 325 tests). A manual smoke run from a temporary `PAYO_DATA_DIR` using `pnpm payo serve --dev-fakes` confirmed loopback-only binding on `127.0.0.1:7331`, `401` without the bearer token, `200` with it, the full start → status → answer → approve flow, and owner-only `0700`/`0600` permissions on the data dir, token, database, artifacts, and plans.

Deviations from the plan text:

- The documented checkout invocation is `pnpm payo <command>` from `payo/`, backed by a root `payo` script. `pnpm --filter @payo/cli exec payo` does not expose a workspace package's own `bin` entry.
- Graceful shutdown during an active attempt settles as a `factory-escalation` gate with reason `<role> failed`, while abrupt-crash recovery uses `interrupted factory operation`. Both require explicit `resume`; there is no separate `escalation` gate kind.
- Test-only seams: `PAYO_TEST_PORT` and readiness lines on stdout are enabled only with `NODE_ENV=test`; `PAYO_SCENARIO` selects fake scripts only with `--dev-fakes`; `PAYO_TEST_SERVER_URL` is honored only with `NODE_ENV=test`.
- `beginFactory` writes `run.created`, initial role artifacts, and the checkpoint as one atomic store batch, so a listed run can never lack a checkpoint.
