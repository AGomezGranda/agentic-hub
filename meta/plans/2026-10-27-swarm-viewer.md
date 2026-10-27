---
date: 2026-10-27
title: Swarm viewer — standalone read-only Node dashboard for pi-subagents swarm runs
status: draft
---

## Current State

- Plans live in `meta/plans/`; format follows `meta/plans/2026-11-02-pi-bump.md`.
- The repo is Python-only. `pyproject.toml` (uv_build, `requires-python >=3.11`) and
  `.github/workflows/ci.yml:7-22` run one job `ci`: pyrefly, ruff, pytest. The only
  TypeScript is `pi/extensions/launch-header.ts`. No Node tooling exists yet.
- `README.md:180` (Development) lists `src/`, `tests/`, `meta/`. `README.md:207` (Docs)
  lists the docs. `README.md` already has uncommitted edits in the working tree.
- `docs/payo/high-level-architecture.md` proposes a profiler module and a Bun host.
  It is marked "not implemented" (`README.md` Docs section). This plan does not depend on it.
- pi-subagents writes per-run artifacts to
  `os.tmpdir()/pi-subagents-<scope>/async-subagent-runs/<runId>/`
  (`pi-subagents/src/shared/types.js:64-69,109`). The scope is `uid-<getuid()>`
  (`pi-subagents/bundle/chunk-5LFLVSTM.js:54-58`). Documented in
  `pi-subagents/docs/observability.md:201` ("Async run artifacts").
- Fields observed on this machine (51 run dirs; map checked against one swarm of 8 children):
  - Root status: `mode: "workflow"`, `state`, `startedAt`, `endedAt`, `pid`, `totalTokens.total`,
    `totalCost.costUsd`, `steps[]` (`workflowKey`, `runId`, `status`, `label`, `agent`), and
    `workflowChildren` (`inventoryComplete`, `children[]` with `childId`, `runId`, `agent`,
    `state`; no per-child cost). No `lifecycleArtifactVersion`.
  - Child status (one run dir per child): `lifecycleArtifactVersion: 3`, `parentWorkflowRunId`,
    `workflowKey`, `state`, `pid`, `startedAt`, `endedAt`, `totalTokens`, `totalCost`
    (`costUsd`), `toolCount`, `turnCount`, and `steps[0]` with `status`, `model`
    (`"provider/model"`), `resolvedModel` (object `{provider, model}`), `requestedModel`
    (string, missing on some steps), `recentTools` (`[{tool, args, endMs}]`), `recentOutput`
    (array of strings), `tokens`, `totalCost`, `startedAt`, `endedAt`. No `pid` on the step, no `label`.
  - Run `state` values seen: `complete`, `running`. Step `status` values seen: both
    `complete` and `completed`, so both must map to one state.
  - `workflow-receipt.json`: `entries[key].outputReference` is the absolute path of each
    child's report, under `~/.pi/agent/sessions/.../subagent-artifacts/outputs/`.
  - `events.jsonl` record types seen: `message_start`/`message_end` (system prompt in
    `message.sections`), `turn_end` (`message.usage` with `input`, `output`,
    `cacheRead`, `cacheWrite`, `totalTokens`, `cost.total`, `reasoning`; thinking blocks
    and `thinkingSignature` in `message.content`), `tool_execution_start`/`_end` (`toolName`; `args` on start; `result`, `isError`,
    `durationMs` on end), `subagent.*` lifecycle events (`lifecycleArtifactVersion: 3`).
- Node `v24.19.0` is installed locally.

## Design Decisions

- **Standalone tool at `tools/swarm-viewer/`** (decided). Not part of the Python package
  and not part of the payo workbench. `pi/` is excluded because `pi apply` reads it.
- **Zero npm dependencies.** Built-ins only (`node:http`, `node:fs/promises`,
  `node:test`). No `node_modules`, no lockfile, no build step.
- **Hexagonal layout (ports and adapters):**

  ```
  browser -> adapters/inbound/http.js -> core/use-cases.js -> core/ports.js <- adapters/outbound/artifacts-fs.js -> pi-subagents files
  browser -> adapters/inbound/ui/ (static)                               <- adapters/outbound/system.js (pid, clock)
                         compose.js: the only file that wires adapters into core
  ```

  Rules, enforced by `test/boundary.test.js` (Phase 2):
  - `src/core/**` imports no `node:*` module and nothing from `src/adapters/` or `compose.js`.
  - Adapters depend on core only through ports or use-case factories.
  - Ports are JSDoc typedefs, not classes. Core is tested with in-memory fakes.
  - **Open decision:** keep this layering (ports, use cases, boundary test) or fold use cases into the service. Kept as written until decided.
- **Single redaction point.** `core/model.js` `summarizeEvent` and `buildSwarm`'s node projection are the only code that turns a
  raw artifact into something the UI may show. It uses an allowlist of event types (default
  deny). It never copies thinking, system prompts, `message_update`, or tool result bodies.
  Tool arguments (event `args`, `recentTools[].args`) are shown only with `--show-args`. Node tool output (`recentOutput`) is shown only with `--show-output`, off by default.
- **Stages are inferred from timing, not from `swarm.js`.** A child starts a new stage when
  it starts after every child in the current stage has ended. Running children have no
  end time, so they keep their stage open.
- **Status normalization:** `complete` and `completed` map to `completed`. Any unknown value
  is shown verbatim as `unknown`, never guessed. A swarm with a child whose `lifecycleArtifactVersion` is not `3` (the root has none)
  is flagged `unsupportedVersion` and its nodes are not shown.
- **Stale detection:** `state === "running"` and `process.kill(pid, 0)` on the child's top-level `pid` says the pid is gone
  means `stale`. Pid liveness only. No boot-id check.
- **Cost is labelled "estimated, pi-reported".** It comes from `totalCost.costUsd` and
  `turn_end.message.usage.cost.total`. It is not billing.
- **Model shown as requested vs. ran.** `resolvedModel` (`{provider, model}`, compared as `provider/model`) is preferred. `modelMismatch` is set
  when both exist and the normalized strings differ.
- **Read-only, live, no history** (decided). Lists workflow roots only. Standalone
  non-workflow async runs are not listed in v1.
- **Security posture:** bind `127.0.0.1` only. Reject any `Host` header other than
  `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). GET and HEAD only.
  Report text is served as `text/plain` with `nosniff`. The UI renders with DOM APIs
  (`textContent`) only, and CSP is `default-src 'self'; frame-ancestors 'none'`.
- **Report paths come only from the receipt**, never from the request. The artifact store
  also refuses any path whose realpath is outside the allowed roots.
- **Default port `4317`**, overridable with `--port`.
- **Node support:** `engines.node >=22`. CI runs a matrix of 22 and 24.
- **CI:** one new job `swarm-viewer` in `ci.yml` (decided).

### Ports (sketch, `src/core/ports.js`)

```js
/**
 * @typedef {object} ArtifactStore
 * @property {() => Promise<string[]>} listRunIds
 * @property {(runId: string) => Promise<object|null>} readStatus
 * @property {(runId: string, file: string) => Promise<object|null>} readJson
 * @property {(runId: string, file: string, fromOffset: number|null) =>
 *   Promise<{records: object[], nextOffset: number, skipped: number}>} readEventsFrom
 * @property {(absPath: string, maxBytes: number) => Promise<string>} readText
 */
/** @typedef {{ isAlive: (pid: number) => boolean }} ProcessProbe */
/** @typedef {{ now: () => number }} Clock */
```

`fromOffset: null` means "start from the last 2 MiB, aligned to a newline".

## Risks & Mitigations

- **Artifact format changes with pi updates** → map only documented fields, ignore unknown
  fields, flag unsupported versions (see Design Decisions).
- **Sensitive content in `events.jsonl` and `status.json`** (system prompts, thinking, tool arguments, tool output) → one gate in `summarizeEvent` and `buildSwarm`'s node projection; canary-string tests cover both (Phase 1); args and output hidden by default.
- **Model output rendered in the browser (XSS)** → `textContent` only; no `innerHTML`;
  CSP `default-src 'self'`; reports shown as plain text; test greps `app.js` (Phase 5).
- **DNS rebinding against a localhost server** → Host allowlist (Phase 4 test).
- **Path traversal through the report route** → path from receipt only; realpath check
  under allowed roots; symlink test (Phase 3).
- **Partial writes while the run is live** → JSON parse failure means "unreadable this
  poll", not an error. JSONL reads stop at the last newline and keep the partial line for
  the next read (Phase 3 tests).
- **Polling cost** (one `status.json` per run per second) → mtime+size cache in the
  adapter; at most 20 swarms listed; reports capped at 512 KiB; initial event backlog capped
  at 2 MiB per run.
- **Truncated or rotated `events.jsonl`** → if the file is shorter than the saved offset,
  restart from 0 (Phase 3 test).
- **Pid reuse makes a dead run look alive** → accepted limitation, documented in
  `tools/swarm-viewer/README.md` (Phase 6).
- **Dirty working tree** (`README.md`, `docs/behavior-modes.md`,
  `skills/_shared/fanning-out/pi.md`, `tests/test_skills.py`, staged `pi/AGENTS.md`,
  `pi/workflows/`, and this plan; all staged, none committed) → the implementation stages only its own files. The README edit in
  Phase 6 touches one section and keeps the existing uncommitted edits. Committing or
  stashing those edits is the user's call, before any branch is cut.
- **Node version drift** → CI matrix 22 and 24 (Phase 0).

## Assumptions (non-blocking, each with a validation step)

- **A1:** Every swarm child has an async `status.json` with `workflowKey` and
  `parentWorkflowRunId`. Validation: fixtures are copied from a real swarm run (Phase 1).
- **A2:** Field paths in Current State match a real swarm (root, children, receipt, events). Validation: a Phase 1 test asserts them against the copied fixture, with prompts and content removed.
- **A3:** Plain `node --test` discovers `test/**/*.test.js` with no config. Validation: Phase 0.
- **A4:** A pid liveness probe is enough for stale detection. Validation: manually kill a
  running child during Phase 5 and confirm the node shows `stale` within one poll.
- **A5:** Stage inference holds for failed, stopped, and paused steps. None were observed in local runs (statuses seen: `complete`, `completed`, `running`). Validation: capture one failed swarm into the Phase 1 fixtures before relying on it.

## Implementation Phases

0. **Scaffold and CI gate**: package, test command, CI job, no logic.
1. **Core model (domain)**: pure functions for nodes, stages, totals and event summaries.
2. **Ports and use cases (application)**: services over the ports, plus the boundary test.
3. **Outbound adapters**: artifact store (cache, JSONL tail, realpath guard) and system probe/clock.
4. **Inbound HTTP adapter, composition and CLI**: JSON API, SSE, report route, guards.
5. **UI (inbound static adapter)**: one page, DOM APIs only.
6. **Docs**: tool README and one root README line.

### Phase 0 — Scaffold and CI gate

**Overview:** a runnable, empty package and the CI job exist before any logic, so every later
phase is gated from the start.

**Changes**

- New `tools/swarm-viewer/package.json`:
  `{"name":"swarm-viewer","version":"0.1.0","private":true,"type":"module","engines":{"node":">=22"},"bin":{"swarm-viewer":"bin/swarm-viewer.js"},"scripts":{"start":"node bin/swarm-viewer.js","test":"node --test"}}`
  with no `dependencies` key.
- New `tools/swarm-viewer/bin/swarm-viewer.js`: `#!/usr/bin/env node`; prints a usage line
  and exits 0. Replaced in Phase 4.
- `.github/workflows/ci.yml`: new job after `ci`:
  ```yaml
    swarm-viewer:
      name: swarm-viewer tests
      runs-on: ubuntu-latest
      strategy:
        matrix:
          node-version: [22, 24]
      defaults:
        run:
          working-directory: tools/swarm-viewer
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: ${{ matrix.node-version }}
        - run: npm test
  ```
  The existing `ci` job is unchanged.

**Tests** (new `tools/swarm-viewer/test/package.test.js`)

- `package.json` has no `dependencies`, `devDependencies` or `optionalDependencies` key.
- `package.json` `type` is `module` and `bin/swarm-viewer.js` exists.
- Validates A3: `npm test` discovers this file with no config.

**Success criteria**

- Automated: `cd tools/swarm-viewer && npm test` on Node 22 and 24; CI `swarm-viewer` job green.
- Manual: none.

**What we're NOT doing:** lint, type checking, coverage thresholds, npm scripts beyond
`start` and `test`.

### Phase 1 — Core model (domain)

**Overview:** pure functions in `src/core/model.js`. No I/O, no `node:*` imports.

**Changes**

- New `src/core/model.js` exporting:
  - `normalizeState(raw)`: `running`→`running`; `complete`/`completed`→`completed`;
    `failed`, `paused`, `stopped` kept as-is; anything else→`unknown`.
  - `nodeState(status, {pidAlive})`: normalized state, but `running` with `pidAlive === false`
    → `stale`.
  - `inferStages(nodes)`: sort by `startedAt`. Start a new stage when a node's `startedAt`
    is `>=` the max `endedAt` of the current stage, treating an open `endedAt` as `Infinity`.
    Returns `stage` index on each node. A node with no `startedAt` gets stage `null`.
  - `summarizeEvent(raw, {showArgs})`: allowlist of types →
    - `tool_execution_start`: `{type, tool, args?}` (`tool` is the event's `toolName`; `args` only with `showArgs`).
    - `tool_execution_end`: `{type, tool, isError, durationMs}` (`tool` from `toolName`). Never the `result` body.
    - `turn_end`: `{type, model, usage: {input, output, cacheRead, cacheWrite, costUsd}}`
      from `message.usage` (`costUsd` from `cost.total`). Never `content`.
    - `subagent.step.started|completed|failed|paused|stopped`, `subagent.run.started|completed|stopped`:
      `{type, ts, stepIndex?, agent?}`.
    - Anything else → `null`.
  - `buildSwarm({root, children, receipt, nowMs, pidAlive, showArgs, showOutput})`: returns
    `{id, state, startedAt, endedAt, durationMs, unsupportedVersion, partial, totals: {tokens, costUsd},
    nodes: [{key, runId, agent, label, state, stage, startedAt, endedAt, durationMs, model,
    requestedModel, modelMismatch, tokens, costUsd, toolCount, turnCount, recentTools,
    recentOutput?}], stageCount}`.
    - Members are the `runId`s in `root.workflowChildren.children`, each read from its own `status.json`. `partial` is `!inventoryComplete`.
    - `unsupportedVersion` is true when any child status has `lifecycleArtifactVersion` other than `3`. The root has none and is not checked. An unsupported swarm has `nodes: []`.
    - Node `state` is the child's top-level `state`, normalized. `pid` is the child's top-level `pid`, which `pidAlive` is applied to.
    - `label` comes from the root `steps[]` entry with the same `workflowKey`; child steps have no label.
    - `model` is `provider/model` from `resolvedModel` (object `{provider, model}`), falling back to `requestedModel` (a string). `modelMismatch` compares the two normalized strings.
    - Node `tokens` and `costUsd` come from the child's top-level `totalTokens.total` and `totalCost.costUsd`. `totals` come from the root's, labelled estimated by the UI. `durationMs` for an open node is `nowMs - startedAt`.
    - `recentTools` is `[{tool, endMs}]`, with `args` added only with `showArgs`. `recentOutput` is present only with `showOutput`.
- Field paths are asserted by a Phase 1 test against the copied fixture (A2).

**Tests** (new `tools/swarm-viewer/test/core/model.test.js`)

- `normalizeState`: `complete` and `completed` both give `completed`; `running` with
  `pidAlive: false` gives `stale`; unknown string gives `unknown`.
- `inferStages` on a scout → two overlapping reviewers → verifier fixture gives stages
  `[0, 1, 1, 2]`. A still-running reviewer keeps verify out of its stage.
- `summarizeEvent`: canary strings placed in a thinking block, a system prompt section, a
  tool result body and a `message_update` produce no output for any allowed type. Unknown
  type returns `null`. `tool_execution_start` has no `args` key unless `showArgs` is true.
- `buildSwarm`: totals come from root fields; a child with `lifecycleArtifactVersion: 4` gives
  `unsupportedVersion: true` and `nodes: []`; a root with no version is supported; the same model as `resolvedModel` `{provider, model}` and `requestedModel` string does not set `modelMismatch`, a different one does; a child's dead top-level `pid` gives `stale`; `recentTools[].args` and `recentOutput` are absent unless their flags are set; a child missing from the receipt is still listed.

**Success criteria**

- Automated: `node --test test/core/model.test.js`.
- Manual: none.

**What we're NOT doing:** markdown, cost recalculation, token pricing, tool-argument
redaction heuristics beyond the allowlist.

### Phase 2 — Ports and use cases (application)

**Overview:** `src/core/ports.js` holds the typedefs. `src/core/use-cases.js` composes the
model with injected ports.

**Changes**

- New `src/core/ports.js`: the typedefs from "Ports (sketch)" above.
- New `src/core/use-cases.js` exporting `createSwarmService({store, probe, clock,
  listLimit = 20, reportMaxBytes = 512 * 1024, showArgs = false, showOutput = false})` returning:
  - `listSwarms()`: run ids → statuses; roots are `mode === "workflow"` with no
    `parentWorkflowRunId`; sorted by `startedAt` descending; `listLimit` applied.
  - `getSwarm(id)`: reads the root, then only the members in `workflowChildren.children[].runId` (no scan of other run dirs); receipt via
    `readJson(id, "workflow-receipt.json")`; returns `buildSwarm(...)` or `null`.
  - `followSwarm(id, cursors)`: returns `{view, activity, cursors}`. `activity` is
    `summarizeEvent` output from `readEventsFrom(runId, "events.jsonl", offset)` for every run in the swarm. `cursors` is
    `{[runId]: {[file]: offset}}`, starting from `null` (backlog). The handler keeps cursors per SSE connection; the service holds no state.
  - `reportFor(id, nodeKey)`: the node must exist in the swarm and the receipt entry must
    have `outputReference`; otherwise `null`. Calls `store.readText(path, reportMaxBytes)`.
    The path never comes from the caller.
- New `test/boundary.test.js`: reads every file under `src/core/` and asserts no `node:`
  import and no import from `src/adapters/` or `src/compose.js`.

**Tests** (new `test/core/use-cases.test.js`, in-memory fake store and probe; fake clock)

- `listSwarms` returns only workflow roots, newest first, capped at `listLimit`.
- `getSwarm` reads members from `workflowChildren.children[].runId` only, never by scanning. A member with a missing status is
  listed with state `unknown` and does not throw. A run dir whose `parentWorkflowRunId` matches but that is not in the list is not included.
- `reportFor`: unknown node key → `null`; key present in the swarm but missing from the
  receipt → `null`; `readText` called with `reportMaxBytes`.
- `followSwarm` with a cursor returns only new records. A cursor of `null` requests backlog.
- Boundary test passes.

**Success criteria**

- Automated: `node --test test/core test/boundary.test.js`.
- Manual: none.

**What we're NOT doing:** caching in core (the adapter caches), pagination beyond
`listLimit`, authentication, write operations.

### Phase 3 — Outbound adapters

**Overview:** the filesystem and OS adapters that implement the ports.

**Changes**

- New `src/adapters/outbound/artifacts-fs.js` exporting `createArtifactStore({root,
  allowedRoots})`:
  - `listRunIds()`: directory entries under `root` that are directories. `root` is the `async-subagent-runs/` directory, never the scope dir. Missing root → `[]`.
  - `readStatus` and `readJson`: `fs.readFile` plus `JSON.parse`. Missing or unparsable →
    `null`. Parsed values cached by `path`, with `mtimeMs` and `size` as the key. Changed
    files are re-read.
  - `readEventsFrom(runId, file, fromOffset)`: `fromOffset === null` → start at
    `max(0, size - 2 MiB)`, then advance to the byte after the first `\n`. If
    `fromOffset > size` (truncation) → restart at 0. Reads through the last `\n` only and
    returns `nextOffset` there. Malformed lines are skipped and counted in `skipped`.
  - `readText(absPath, maxBytes)`: `fs.realpath(absPath)` must start with
    `realpath(allowedRoot) + path.sep` for some `allowedRoot`; otherwise throws
    `Error("forbidden")`. Reads at most `maxBytes` bytes as UTF-8.
- New `src/adapters/outbound/system.js` exporting `processProbe` (`isAlive(pid)` via
  `process.kill(pid, 0)`: `ESRCH` → `false`; `EPERM` → `true`) and `systemClock`
  (`now: () => Date.now()`), and `defaultArtifactsRoot({env, tmpdir, getuid})`: `PI_SUBAGENTS_TEMP_ROOT` (resolved) if set, else `<tmpdir>/pi-subagents-uid-<uid>`, plus `/async-subagent-runs`. Mirrors `pi-subagents/src/shared/types.js:106-111`. Throws when `getuid` is missing.

**Tests** (new `test/adapters/artifacts-fs.test.js`, `test/adapters/system.test.js`; temp
dirs; fixture copied per test)

- `listRunIds` on a missing root returns `[]` and ignores plain files.
- `defaultArtifactsRoot`: unset env gives `<tmp>/pi-subagents-uid-<uid>/async-subagent-runs`; `PI_SUBAGENTS_TEMP_ROOT=/x` gives `/x/async-subagent-runs`. On a temp tree shaped like the real scope dir (sibling dirs `async-subagent-results/`, `nested-subagent-events/`, `run-fanout-budgets/`, `supervisor-channels/` present), `listRunIds` on the runs dir returns only run ids.
- Malformed `status.json` → `null`, no throw. Missing → `null`.
- A changed `status.json` (same path, new content) is re-read.
- JSONL: a partial trailing line is not returned until its `\n` is written; the next call
  from `nextOffset` returns only new records.
- Truncation: file shorter than the saved offset restarts from 0.
- Backlog on a 3 MiB file with `fromOffset: null` returns only whole lines.
- A malformed JSONL line is skipped and counted.
- `readText`: symlink inside root pointing at a file outside → throws `forbidden`; a path
  outside the roots → `forbidden`; a file larger than `maxBytes` → exactly `maxBytes` bytes.
- `processProbe.isAlive(process.pid)` → `true`; the pid of a child that has already exited
  → `false`.

**Success criteria**

- Automated: `node --test test/adapters`.
- Manual: none.

**What we're NOT doing:** `fs.watch` (polling only), Windows path semantics, file locking,
reading session JSONL transcripts.

### Phase 4 — Inbound HTTP adapter, composition and CLI

**Overview:** the single HTTP surface. `compose.js` is the only file that wires concrete
adapters into the service.

**Changes**

- New `src/adapters/inbound/http.js` exporting `createHttpHandler({service, uiFiles, getPort,
  pollMs = 1000, pingMs = 15000})`, where `service` is the Phase 2 service:
  - Host guard: `Host` must be `127.0.0.1:<p>` or `localhost:<p>`, where `<p>` is `getPort()` read per request (so `port: 0` works), else `403`.
  - Method guard: GET and HEAD only, else `405`.
  - `GET /`, `/app.js`, `/styles.css`: a fixed map from URL to file in
    `src/adapters/inbound/ui/`. No URL-to-path join.
  - `GET /api/swarms` → `listSwarms()` JSON.
  - `GET /api/swarms/:id` → `getSwarm(id)` JSON, or `404`.
  - `GET /api/swarms/:id/nodes/:key/report` → `reportFor` as `text/plain; charset=utf-8`
    with `X-Content-Type-Options: nosniff`, or `404`.
  - `GET /api/swarms/:id/events`: `text/event-stream`. Sends `event: snapshot` when the view
    JSON changes and `event: activity` for new summaries. Polls `service.followSwarm` every `pollMs`. Sends a `:
    ping` comment every `pingMs`. Clears timers on `req` `close`.
  - `:id` and `:key` must match `^[A-Za-z0-9._-]{1,128}$`, else `404`.
  - Every response: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`,
    `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
  - Anything else → `404`.
- New `src/compose.js` exporting `createApp({artifactsRoot, piSessionsRoot, port,
  showArgs, showOutput})`: builds `createArtifactStore({root: artifactsRoot, allowedRoots:
  [artifactsRoot, piSessionsRoot]})`, `processProbe`, `systemClock`, the service (with `showArgs`, `showOutput`), and the
  HTTP handler, with `getPort` reading `server.address().port`. Returns `{server}` that is not yet listening.
- `bin/swarm-viewer.js` (replaces the Phase 0 stub): flags `--artifacts-dir` (default
  `defaultArtifactsRoot()` from `system.js`), `--sessions-dir`
  (default `~/.pi/agent/sessions`), `--port` (default `4317`), `--show-args`, `--show-output` (shows `recentOutput`), `--help`.
  Listens on `127.0.0.1` only and prints the URL. Port busy → message and exit `1`.
  `process.getuid` missing (Windows) → message asking for `--artifacts-dir`, exit `1`.

**Tests** (new `test/adapters/http.test.js`, fake service and follow, `port: 0`, `node:http` requests (`fetch` cannot override `Host`);
new `test/e2e.test.js`)

- `Host: evil.example` → `403`. `POST` → `405`. `/../etc/passwd` and `/%2e%2e/x` → `404`.
  Unknown route → `404`.
- `GET /api/swarms/:id` returns JSON; unknown id → `404`; id with a `/` → `404`.
- Report route: text body, `nosniff` header, `404` for a key absent from the receipt.
- SSE: connect, mutate the fake store, receive a `snapshot` event within 2 s. Closing the
  connection stops further writes (assert with a counter on the fake).
- Every response carries the three security headers.
- E2E (`test/e2e.test.js`): `createApp` with the real artifact store and
  `test/fixtures/artifacts` + `test/fixtures/sessions`, `port: 0`. `GET /api/swarms` lists
  the fixture swarm; `GET` its report and compare with the fixture file. Also checks that
  the canary strings from the fixture's thinking, system prompt, `recentTools` args and `recentOutput` are absent from every
  response.
- Fixtures under `test/fixtures/artifacts/` mirror the real `async-subagent-runs/` layout: one dir per run id, plus sibling dirs (`async-subagent-results/`, `nested-subagent-events/`, `run-fanout-budgets/`, `supervisor-channels/`) that must be ignored. Built by copying a real swarm's tree (root and child `status.json`, `workflow-receipt.json`, `events.jsonl`) with ids and paths replaced and content scrubbed. Canary strings in thinking, system prompt, `recentTools[].args`, and `recentOutput`. Report files that receipts point to live under `test/fixtures/sessions/`.

**Success criteria**

- Automated: `npm test` green on Node 22 and 24.
- Manual: `npm start` with no flags lists this machine's workflow roots, so the default root works. Then `npm start -- --artifacts-dir test/fixtures/artifacts --sessions-dir test/fixtures/sessions`,
  then `curl -s http://127.0.0.1:4317/api/swarms` lists the fixture swarm, and
  `curl -s -H 'Host: evil.test' http://127.0.0.1:4317/api/swarms` returns `403`.

**What we're NOT doing:** authentication tokens, HTTPS, CORS, any write endpoint, rate
limiting, HTTP/2, a configurable bind address.

### Phase 5 — UI (inbound static adapter)

**Overview:** one page that talks only to the Phase 4 JSON and SSE API. No framework, no
build step, DOM APIs only.

**Changes**

- New `src/adapters/inbound/ui/index.html`: header with the totals bar (estimated tokens
  and cost, labelled "est."); left column with the swarm list; main area with one column
  per stage and one card per node; right drawer with node details, model
  (requested → ran when `modelMismatch`), report text, and that node's summaries; bottom
  timeline with a node filter. A banner for `unsupportedVersion`. Stale and unknown badges.
  No inline `<script>`, no `on*=` attributes.
- New `src/adapters/inbound/ui/app.js`: `fetch` for the list and swarm; `EventSource` on
  `/api/swarms/:id/events` for the selected swarm; renders with `createElement` and
  `textContent`.
- New `src/adapters/inbound/ui/styles.css`: minimal readable layout.

**Tests** (new `test/adapters/ui-static.test.js`)

- `app.js` contains none of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
  `eval(`, `new Function`.
- `index.html` has no inline `<script>` and no `on*=` attribute (CSP compatibility).

**Manual checklist** (A4 validated here)

- Open against the fixture: stage columns render, drawer shows the report as plain text,
  the timeline filters by node.
- Open against a live swarm: a running node updates within about 1 s.
- Page text contains none of the fixture's canary strings.
- Kill a running child's pid during the run: its node shows `stale` within one poll.
- DevTools console has no CSP violations and no errors.

**Success criteria**

- Automated: `node --test test/adapters/ui-static.test.js`.
- Manual: the checklist above, recorded in the PR description.

**What we're NOT doing:** markdown rendering of reports, charts, dark mode, keyboard
shortcuts, mobile layout, any client-side storage.

### Phase 6 — Docs

**Overview:** how to run it, what it reads, what it does not show, and its security posture.

**Changes**

- New `tools/swarm-viewer/README.md`: purpose; run with `npm start` and its flags; what it
  reads (default artifact and session paths, including the macOS `$TMPDIR` form); what it
  does not show (system prompts, thinking, tool arguments unless `--show-args`, foreground
  runs, standalone non-workflow runs, history after pi prunes its files); security posture;
  "cost is estimated"; the pid-reuse limitation.
- `README.md`: one bullet in a new `## Tools` section placed before `## Docs` (`README.md:207`):
  "`tools/swarm-viewer/`: read-only local dashboard for pi-subagents swarm runs (`npm start`
  in that directory)." Keep every existing uncommitted edit in that file.

**Tests:** none. Checked by following the README on a clean shell.

**Success criteria**

- Automated: `npm test` still green.
- Manual: a clean terminal follows `tools/swarm-viewer/README.md` and reaches the page.

**What we're NOT doing:** a docs site, a changelog, screenshots, a tutorial.

## PR Strategy

- **PR 1 — Phases 0–4:** backend, tests, CI job. Usable through `curl`. Mergeable alone.
- **PR 2 — Phases 5–6:** UI and docs, stacked on PR 1.
- Both branch off `main`. The working tree's uncommitted changes must be committed or
  stashed separately first, which is the user's decision. Nothing is pushed or merged
  without an explicit request.

## Overall verification

- `cd tools/swarm-viewer && npm test` on Node 22 and 24.
- CI `swarm-viewer` job green; existing `ci` job unchanged.
- Manual checklist from Phase 5; `curl` checks from Phase 4.
- After Phase 4 and again after Phase 5, run the audit swarm on `tools/swarm-viewer/` per
  the standing orders in `pi/AGENTS.md`. Lenses: correctness, architecture, quality, tests,
  simplicity, security.

## What we're NOT doing (whole plan)

- Steer, stop or any other write action against pi-subagents.
- Run history, snapshots or a database.
- Standalone non-workflow async runs and foreground (in-process) children.
- Authentication, HTTPS, CORS, remote access.
- npm dependencies, a bundler, a UI framework, Markdown rendering.
- Windows support.
- Changes to pi-subagents or to `pi/`.
- Integration with `docs/payo/`.

## Implementation log: PR 1 (Phases 0-4)

Status: implemented in `tools/swarm-viewer/` (untracked, not committed). `npm test`: 153 passing on Node 24.19. The Node 22 leg is CI only; it was not run locally.

Deviations and decisions (confirm the two marked "confirm"):
- `createApp` takes no `port`. It returns a server that is not listening; `getPort` reads `server.address()`.
- Views add `hasReport` (the node has a receipt report) and `memberCount` (list). Activity items carry `nodeKey`.
- SSE sends `gone` (the swarm vanished and the stream ends) and `error` (a poll failed and the stream continues). Neither is in the plan's SSE contract.
- Unreadable artifacts keep the last good value. A half-written or string-coded-errno `status.json` returns the last parse. A failed `events.jsonl` read returns an empty page with the cursor unchanged. A failed report read returns null. A null backlog cursor stays null, so the 2 MiB cap holds on retry.
- `readEventsFrom` `nextOffset` is `number|null` (ports typedef). The plan sketch says `number`.
- Stage closing (confirm): a non-running node closes at `endedAt`, then `lastActivityAt`, then `lastUpdate`. A running node keeps its raw `endedAt`. A node with none of these keeps its stage open. The plan was silent on stale children.
- Unsupported-version swarms emit no activity, as well as no nodes.
- Layering (confirm): ports, use cases and the boundary test are kept. This closes the "open decision" in Design Decisions.
- The report route returns 404 for a forbidden or unreadable report and 500 only for unexpected errors.
- Fixture receipts keep a `{{SESSIONS_ROOT}}` placeholder that the test helper fills in on a temp copy. Reports cannot be served straight from `test/fixtures`.

Not in PR 1: the UI and docs (PR 2). Known limits: `listSwarms` reads every run's status with an unbounded `Promise.all`; the EMFILE path is untested. The readText realpath-then-open gap is same-user only. The 512 KiB report cut is silent. The snapshot is re-sent on every duration change. The server is loopback with no auth, and the Linux default root is shared `/tmp`.

## Implementation log: PR 2 (Phases 5-6)

Status: implemented in `tools/swarm-viewer/` (uncommitted, not pushed), on top of PR 1's tree. `npm test`: 164 passing on Node 24.19. The Node 22 leg is CI only; it was not run locally.

Phase 5 manual checklist, run in headless Chrome over the DevTools protocol against a copied fixture:
- Stage columns, drawer (report as plain text), and the node filter in the timeline: pass.
- Live update: an event appended to a running child reached the timeline without a reload: pass.
- No fixture canary in page text or HTML with default flags: pass. With `--show-args` or `--show-output`, args and output show, by design.
- A4: a killed running child showed `stale` on the next poll: pass.
- Console: no errors and no CSP violations. The first run had a 404 for the favicon and a CSP-blocked `data:` icon. The favicon is now served same-origin.

Phase 4 manual check, run on a free port with no flags (`npm start -- --port 4318`): the default root lists this machine's 15 workflow roots, `Host: evil.test` gets 403, and `/` gets 200. A first attempt on 4317 hit a different process already listening there. That process was stopped by my cleanup, and I did not identify it first.

Deviations from the plan:
- Activity cap is 300 rows per node, not 2000 in total. Round 1 found that a global cap dropped an early node's whole backlog (BLOCKER, fixed). 300 per node shows the same rows as the 300-row timeline and the 50-row drawer.
- `ui/activity.js` is a new pure helper so the cap is unit-tested. `app.js` is a module script. `ui/favicon.svg` is served for the console check.
- A `#<id>` link to a swarm that is not in the 20-item list opens the newest swarm and rewrites the URL. This is documented in the tool README.
- Report text is served as written and is not gated by `--show-args` or `--show-output`. The redaction gate covers events and status only. Reports can quote tool output. This is open for a decision.

Audit swarm, three rounds (`pi/AGENTS.md` standing orders):
- Round 1 (scout, six lenses, verifier): one BLOCKER (V01, activity cap), fixed and checked in the browser. Accepted small items: V02 (`||` for `--sessions-dir`), V08 (root-stale limit documented), V09 (comment corrected), V18 (two test names corrected).
- Round 2 (correctness, tests, simplicity; verifier): no blocker. Accepted P1s: VF-01 (wiring guard, checked with four planted mutants), VF-03, VF-09, VF-10 (false README and on-page claims). Accepted P2s: VF-02 (stuck deep link), VF-05 (per-node 300), VF-06, VF-07. Rejected: VF-08 (favicon). The Phase 5 console check needs it.
- Round 3 (correctness, tests; verifier): no blocker. Accepted: V3-01 (the on-page note said either flag unlocked both args and output), V3-02, V3-04, V3-05. Rejected: V3-06 (no flag-on report test, since `reportFor` takes no flags). V3-03 is a documented tradeoff. V3-07 is invalid. V3-08 is out of slice.
- V3-01 was edited after round 3 and was not re-audited. Its wording is "not shown", not "never reads". The viewer does parse those event fields and discards them.

Deferred (real, not merge-blocking; not applied):
- Cursor reader (V03, V04): the tail read has no cap while one line is still being written. A 2 MiB window that starts exactly on a line break drops one whole record.
- Stalled client (V05): snapshots and activity queue while a client does not read. Fix: skip the poll while `res.writableLength > 0`.
- Stuck state (V06, V10): "swarm no longer available" stays until reload, and a first-read root failure is not retried.
- Error contract by message (V07), special files and `jsonCache` pruning (V11, V12), no `maxConnections` (V13).
- Tests (V14–V17, V19, V20): no e2e for out-of-root receipts or the `showArgs` wiring, no cursor boundary cases, no first-poll-throw or ping test. UI behaviour is checked by regex only, with no DOM run in CI.
- Speculative (V21, V22): a terminal node with no end timestamp, malformed `members`.
- Root `running` is not probed. Documented in the tool README.

Not checked: Node 22 (CI only); a real swarm above 2000 rows (only a synthetic 2100+2100 backlog); a browser run in CI (none exists); paths on Linux and Windows; the `status: draft` header is unchanged.
