---
date: 2026-10-30
title: Payo step 2 — kernel core and event store
status: draft
---

Roadmap step 2 of [docs/payo/implementation-roadmap.md](../../docs/payo/implementation-roadmap.md)
(section "2. Kernel core and event store"). Goal: durable runs whose state is derived from an
append-only event log, with restart recovery, against an in-memory store and SQLite.

Builds on step 1 (`meta/plans/2026-10-30-payo-workspace-scaffold.md`), which is not yet
committed. Branch from the step 1 branch.

## Current State

- Step 1 is implemented locally and green: `payo/` `pnpm check` passes (Biome, `tsc`, 30 tests).
- The three step 2 packages are empty stubs, each `export {};`:
  `payo/packages/contracts/src/index.ts:1`, `payo/packages/kernel/src/index.ts:1`,
  `payo/adapters/store-sqlite/src/index.ts:1`.
- `payo/packages/kernel/package.json` depends only on `@payo/contracts`. Zod is a dependency
  of `payo/packages/contracts/package.json` (zod 4.6.7). `store-sqlite` already depends on
  `@payo/kernel` and `@payo/contracts`.
- Port sketch to honour: `docs/payo/engine-design.md:100-104` (`RunStore.append(runId, events,
  expectedSeq)`, `read(runId, fromSeq?)`, `putArtifact(content, meta)`). The design does not
  yet give `Buffer` vs `Uint8Array`, a `readArtifact`, or the event shapes; this plan decides them.
- Records and durability rules: `docs/payo/engine-design.md:123-143`. Usage stays `unknown`
  when unreported (`:135-136`).
- Dependency rules and Biome enforcement: `payo/biome.json` `overrides` (kernel at `:41`,
  adapters at `:101`) and `payo/test/boundaries.test.ts` (table at `:23-100`, adapter rows at
  `:86-`).
- Verified locally: Node 24.19.0, `node:sqlite` loads with no flag and no warning, SQLite
  3.53.3; `@types/node` 24.19.2 ships `sqlite.d.ts`; pnpm 10.9.0.
- Existing relative imports use the `.ts` extension (`apps/server/src/main.test.ts:2`). `tsc`
  runs `module: nodenext`, so relative imports must keep the extension.
- Biome forbids `"../../*/**"` relative escapes between packages (step 1 deviation log,
  `meta/plans/2026-10-30-payo-workspace-scaffold.md:368-395`).

## Design Decisions

- **Kernel knows no factory states.** A run is `active` or `ended` with an outcome string. The
  factory maps its own states (Approved, Escalated, …) onto steps, gates and the outcome.
- **Run config is opaque, module-validated JSON.** `startRun` receives an already-resolved
  `RunConfig` (a JSON object). The kernel stores it unchanged. The factory validates its
  per-role model and limits in step 4. `dataDir` is not recorded on the Run: it is
  infrastructure, and moving the data must not change what a run means. This deviates from roadmap step 2; see Deviations.
- **Config resolution is a pure function.** `resolveRunConfig(defaults, overrides)` is a
  recursive merge of plain objects, with overrides winning. Arrays and scalars are replaced.
  No file or env reading in this step; that is step 5.
- **Commands decide, `commit` validates, the store appends.** The `decide*` functions return
  event bodies. `commit(store, state, bodies)` parses each body with `RunEventBody`, then folds them through the reducer, before
  writing. A schema-invalid or invariant-breaking event never reaches the log, and the log stays replayable: `read` parses every row.
- **The store assigns `seq` and `at`.** Callers pass event bodies only. `expectedSeq` is the
  `lastSeq` of the state the caller folded (0 when the run does not exist yet).
- **Recovery is an ordinary commit.** `recover(state)` yields `attempt.finished{outcome:
  "interrupted"}` plus `gate.raised` for each running attempt. The gate id is derived from the
  attempt id, so a second recovery finds nothing running and adds nothing. Usage on those
  attempts is `"unknown"` for all three fields.
- **Interrupted gates use kernel-level commands** `["retry", "abandon"]`. The factory can
  map them to its own commands in step 4.
- **Kernel generates no ids.** Callers supply run, step, attempt, gate and artifact ids.
  Tests use readable literals. The server generates UUIDs in step 5.
- **Artifacts are content-addressed and verified on read.** A file is named by its sha256.
  `readArtifact` recomputes the hash and throws on mismatch. Attaching an artifact to a run
  goes through an `artifact.recorded` event. The caller puts the artifact before committing the event that references it; the store cannot check that in `append`, so it is a caller invariant.
- **Shared store contract, exported from kernel.** `@payo/kernel/testing` exports
  `runStoreContract(name, factory)`, which both stores run. It is the only place `vitest`
  appears in kernel, as a devDependency. The in-memory store is exported from the root, since
  step 4 fakes need it.
- **Usage shape:** `{ tokensIn, tokensOut, cost }`, each `number | "unknown"`. `cost` is the
  harness-reported estimate, not billing. Step 6 sets the estimate flag; this step does not.

## Risks & Mitigations

- **Biome `@payo/*` does not match the subpath `@payo/kernel/testing`, so modules and cli would import it unblocked.**
  Mitigation: spike in phase 2 (throwaway dir, as step 1 did) confirms it. Add the positive literal
  `"@payo/kernel/testing"` to the modules and cli groups. The boundary rows prove it.
- **`vitest` leaks into kernel's runtime surface.** Mitigation: a subpath export only, never
  re-exported from the root; only adapter tests import it. A boundary row checks that
  `modules/` cannot import `@payo/kernel/testing`.
- **`node:sqlite` is still Node's experimental API.** Mitigation: only `store-sqlite` touches
  it, behind a small internal wrapper. Node is pinned to `>=24` in `payo/package.json`.
- **Events are persisted, so shape changes later need migration.** Mitigation: no production
  data exists yet, and phase 1 fixes the shapes the roadmap names. Later changes are additive
  where possible. The SQLite file records `PRAGMA user_version = 1`, and `open` throws on any
  other value, so a future schema change fails loudly.
- **Two processes recovering the same run.** The second `commit` gets `StaleSeqError`. Mitigation:
  `openRun` surfaces it, and the single-host server (step 5) is the only writer. `openRun` is startup-only, before any executor starts for the run, so the same process cannot race itself.
- **Tests touching real data.** Mitigation: every store test uses `mkdtemp`. Nothing in this
  step reads or writes `~/.payo`; only the caller that passes a data dir does.
- **Atomic artifact writes.** Mitigation: write to a temp file in the same directory, then
  `rename`, with `fsync` on the file and on `artifacts/` before the event is committed. An existing hash is never overwritten.

## Phase 1: Contracts

### Overview

Zod schemas for the run event union and the state records, plus the shared JSON, usage and
artifact types. No runtime logic beyond parsing.

### Changes

- `payo/packages/contracts/src/run.ts` (new):
  - `Json`: recursive `z.ZodType<Json>` built with `z.lazy` over string, number, boolean,
    null, array and `z.record(z.string(), Json)`.
  - `RunConfig = z.record(z.string(), Json)`.
  - `Usage = z.union([z.number().nonnegative(), z.literal("unknown")])`.
  - `UsageRecord = z.object({ tokensIn: Usage, tokensOut: Usage, cost: Usage })`.
  - `ArtifactRef = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.int().nonnegative(),
    kind: z.string().min(1), mediaType: z.string().min(1) })`.
  - `AttemptOutcome = "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted"`.
  - `StepOutcome = "succeeded" | "failed" | "escalated"`.
  - Event bodies, as `RunEventBody = z.discriminatedUnion("type", [...])` with these members
    (all ids are `z.string().min(1)`):
    - `run.created` `{ runId, repo, baseBranch, config: RunConfig }`
    - `run.ended` `{ outcome: z.string().min(1) }`
    - `step.started` `{ stepId, name }`
    - `step.finished` `{ stepId, outcome: StepOutcome }`
    - `attempt.started` `{ attemptId, stepId, role, runner, model: string | null,
      roleSpecSha: string | null, inputArtifacts: string[] }`
    - `attempt.finished` `{ attemptId, outcome: AttemptOutcome, usage: UsageRecord, error?: string }`
    - `gate.raised` `{ gateId, stepId, kind: string (min 1), allowedCommands: string[] (min 1), reason }`
    - `gate.resolved` `{ gateId, command, note: string | null }`
    - `artifact.recorded` `{ artifact: ArtifactRef, attemptId: string | null }`
  - Types: `RunEventBody = z.infer<…>`; `RunEvent = RunEventBody & { seq: number; at: string }`
    with `seq` a positive integer. `at` is an ISO-8601 string.
  - State records, as Zod schemas and inferred types:
    - `StepRecord { stepId, name, status: "running" | StepOutcome }`
    - `AttemptRecord { attemptId, stepId, role, runner, model, roleSpecSha, inputArtifacts,
      status: "running" | AttemptOutcome, usage: UsageRecord | null, error?: string }`
    - `GateRecord { gateId, stepId, kind, allowedCommands, reason, status: "open" | "resolved",
      resolution: { command, note } | null }`
- `payo/packages/contracts/src/index.ts`: replace `export {};` with
  `export * from "./run.ts";`.
- `payo/packages/contracts/src/run.test.ts` (new).

### Tests

Write first, in `run.test.ts`:

- `Usage` accepts `0`, `1.5` and `"unknown"`. It rejects `"0"`, `-1`, `null`, `undefined` and
  `NaN`. Edge: `0` must pass, because zero is a real reading.
- `RunEventBody` rejects an unknown `type`, a missing required field (`gate.raised` without
  `allowedCommands`) and an empty `allowedCommands` array.
- `ArtifactRef` rejects an uppercase or short `sha256`.
- `Json` rejects an object with an `undefined` value. `RunConfig` accepts nested objects and
  arrays, and rejects a top-level array.

Level: unit only. Contracts is pure schemas, so these are fast and need no integration tier.

### Success criteria

**Automated:**
- `cd payo && pnpm check` passes.
- `cd payo && pnpm exec vitest run packages/contracts` passes.

**Manual:** none.

### What we're NOT doing

- No API schemas (HTTP, SSE). Those come in step 5.
- No agent event union (`AgentEvent`). That is step 3.
- No `Ticket` or `Workspace` schemas. Those come in steps 4 and 6.
- No `Run` record schema. `RunState` is kernel-internal (it holds `Map`s); step 5 defines any wire shape.

## Phase 2: Kernel

### Overview

The reducer, the `RunStore` port with `expectedSeq` checks, the in-memory store, the
`commit`/`startRun`/`openRun` flow, gate decisions, recovery, config resolution, and the
shared contract suite. Ends with the in-memory store passing the contract suite.

### Changes

- `payo/packages/kernel/src/store.ts` (new):
  - `interface RunStore { append(runId: string, events: RunEventBody[], expectedSeq: number):
    Promise<void>; read(runId: string, fromSeq?: number): Promise<RunEvent[]>;
    putArtifact(content: Uint8Array, meta: { kind: string; mediaType: string }): Promise<ArtifactRef>;
    readArtifact(sha256: string): Promise<Uint8Array>; close(): Promise<void>; }`
    `read` returns events with `seq >= fromSeq`, default `fromSeq = 1`.
  - `class StaleSeqError extends Error { readonly expected: number; readonly actual: number }`. `expected` is the caller's `expectedSeq`; `actual` is the stored `MAX(seq)`.
    Declared fields, no parameter properties (`erasableSyntaxOnly`).
  - `createMemoryRunStore(backing?: { events: Map<string, RunEvent[]>; artifacts: Map<string, Uint8Array> })`.
    `at` is `new Date().toISOString()`. `readArtifact` rejects a sha256 that is not 64 lowercase hex, and throws if the hash is unknown.
- `payo/packages/kernel/src/state.ts` (new):
  - `interface RunState { runId; repo; baseBranch; config: RunConfig; status: "active" | "ended";
    outcome: string | null; lastSeq: number; steps: Map<string, StepRecord>;
    attempts: Map<string, AttemptRecord>; gates: Map<string, GateRecord>; artifacts: ArtifactRef[] }`.
  - `reduce(state: RunState | null, event: RunEvent): RunState`. It is pure: it returns a new state and never mutates its input. It throws on any
    invariant break:
    - `run.created` only as the first event, and only once.
    - Any event after `run.ended` throws.
    - `run.ended` throws while any attempt is running or any gate is open.
    - `step.started` needs a fresh id. `step.finished` needs a running step.
    - `attempt.started` needs a fresh id and a running step. `attempt.finished` needs a running attempt.
    - `gate.raised` needs a fresh id and a known step. `gate.resolved` needs an open gate.
    - `artifact.recorded` needs `attemptId` null or known. Duplicate hashes are kept once.
  - `fold(events: RunEvent[]): RunState` runs `reduce` over an array. An empty array throws.
    It is used by `openRun` and tests.
- `payo/packages/kernel/src/run.ts` (new):
  - `resolveRunConfig(defaults: RunConfig, overrides?: RunConfig): RunConfig`. Recursive merge,
    then parsed by `RunConfig`.
  - `decideGateRaise(state, gate: { gateId; stepId; kind; allowedCommands; reason }): RunEventBody[]`.
    Rejects an ended run, an unknown step, a non-running step and a duplicate gate id.
  - `decideGateResolve(state, input: { gateId; command; note: string | null }): RunEventBody[]`.
    Rejects an unknown or resolved gate, and a `command` not in `allowedCommands`.
  - `recover(state: RunState): RunEventBody[]`. For each running attempt, emits
    `attempt.finished{outcome: "interrupted", usage: all "unknown"}` and
    `gate.raised{gateId: "interrupted:" + attemptId, stepId, kind: "interrupted-attempt",
    allowedCommands: ["retry", "abandon"], reason: "attempt was running when the process stopped"}`.
  - `commit(store, state: RunState | null, bodies: RunEventBody[]): Promise<RunState>`.
    Parses each body with `RunEventBody` (a schema failure throws), then folds `bodies` onto `state`; a throw aborts before any write. Then
    `store.append(runId, bodies, state?.lastSeq ?? 0)`. Returns the folded state. Because `reduce` is pure, a `StaleSeqError` leaves `state` untouched.
    An empty `bodies` returns `state` unchanged. `runId` comes from the state, or from the
    `run.created` body when `state` is null.
  - `startRun(store, input: { runId; repo; baseBranch; config: RunConfig }): Promise<RunState>`.
    `commit(store, null, [run.created])`. Starting an existing run fails with `StaleSeqError`.
  - `openRun(store, runId): Promise<RunState>`. Reads, folds, then
    `commit(store, state, recover(state))`. Returns the folded state. Idempotent. Startup only: call it before any executor starts for the run; while an attempt is live, it would mark that attempt interrupted.
- `payo/packages/kernel/src/testing.ts` (new): `runStoreContract(name: string,
  factory: { open(): Promise<RunStore> })`. Calls `describe(name, …)` from `vitest` and
  registers the cases listed under Tests. Each case calls `factory.open()`, and a reopen is a
  second `open()` on the same storage.
- `payo/packages/kernel/src/index.ts`: `export *` from `./store.ts`, `./state.ts`, `./run.ts`.
  Do not re-export `testing.ts`.
- `payo/packages/kernel/package.json`:
  - `exports`: add `"./testing": "./src/testing.ts"` next to `"."`.
  - `devDependencies`: `"vitest": "^5.0.5"`, the same range as the root.
- `payo/biome.json`: add the positive literal `"@payo/kernel/testing"` to the modules and cli groups. Adapters need no change.
  Spike result is recorded in Deviations.
- `payo/test/boundaries.test.ts`: add three rows. `adapters/store-sqlite/src/a.test.ts` importing
  `@payo/kernel/testing` is allowed (`undefined`). `modules/factory/src/a.ts` importing
  `@payo/kernel/testing` is blocked (`MODULES`). Add `apps/cli/src/a.ts` importing it as blocked (`CLI`). The modules row is the real guard:
  it fails until `biome.json` has the positive literal.
- Tests, in `payo/packages/kernel/src/`: `state.test.ts`, `run.test.ts`, `store.memory.test.ts`.

### Spike (first, in a throwaway dir, as in step 1)

Copy `payo/biome.json` into a temp dir with three files, each containing the import below: `adapters/x/src/a.ts` (must be clean), `modules/x/src/a.ts` and `apps/cli/src/a.ts` (each must fail `noRestrictedImports`). Before the config change the last two are expected to be clean, because `@payo/*` does not match a subpath.
`import "@payo/kernel/testing";`. Run `biome lint` on all three. Add
the positive literal (see Changes) and re-run until the expectations hold. Record the before and after results in the
Deviations log.

### Tests

Write first, in this order:

1. `state.test.ts` (reducer invariants). One case per rule above, each asserting the throw
   message names the id:
   - a happy-path fold: run, step, attempt, artifact, gate, resolve, step finished, run ended.
   - `run.ended` with an open gate throws. With a running attempt, also throws.
   - an event before `run.created` throws. A second `run.created` throws.
   - a duplicate `step.started` id throws. Attempt on a finished step throws.
   - `attempt.finished` on an already-finished attempt throws.
   - `gate.resolved` twice throws.
   - a duplicate artifact hash is stored once.
   - `reduce` does not mutate its input: a snapshot taken before the fold is equal after it.
2. `run.test.ts` (decisions, recovery, commit):
   - `resolveRunConfig`: overrides win at depth; arrays replace; a non-JSON override throws.
   - `decideGateResolve` rejects a command not in `allowedCommands`, and a resolved gate.
   - `recover` on a state with one running attempt emits exactly one finish and one gate with
     id `interrupted:<attemptId>`. Running it again on the resulting state emits `[]`.
   - `commit` with a schema-invalid body (e.g. `gate.raised` with `allowedCommands: []`) and with an invariant-breaking body each write nothing: the memory store's events array is unchanged
     (asserted on the backing `Map`). A `StaleSeqError` from `commit` leaves the input state's `lastSeq` and maps unchanged.
   - `startRun` twice on one run id throws `StaleSeqError` with `expected: 0`, `actual: n`.
   - `openRun` on a run with an attempt left running, after the store is reopened, returns
     `attempts` with `status: "interrupted"` and an open gate with `kind: "interrupted-attempt"`.
     Edge: an attempt that already finished is not interrupted.
3. `store.memory.test.ts`: `runStoreContract("memory", { open: () => … })` over a shared
   backing `Map`, so reopen sees the same data. This runs the contract cases below.

Contract cases, in `testing.ts`, run for every store:

- `append` then `read` returns events in order with `seq` 1..n, the runId intact, and `at` an
  ISO string.
- `read(runId, 3)` returns only `seq >= 3`.
- `append` with a stale `expectedSeq` rejects with `StaleSeqError`, and the log is unchanged.
- Two writers, each from its own `open()` store and both starting from `expectedSeq = 0`, run concurrently (`Promise.allSettled`): one rejects with `StaleSeqError`, and only the winner's
  events are stored.
- `putArtifact` returns a 64-hex `sha256` with the right `size`. The same bytes give the same
  ref. Different bytes give a different ref. `readArtifact` returns the same bytes.
- Durability: after `close()` and `open()` again, events and artifacts are still there, and
  `openRun` rebuilds the same state as the pre-close fold, with a running attempt interrupted.
- `openRun` twice after a reopen adds no second interrupted gate.
- Batch atomicity: a batch whose last row fails to serialise (inject a `bigint` in `config`) leaves zero rows.
- `append([])` is a no-op; `read` of an unknown run returns `[]`.
- `readArtifact("../x")` and any non-hex name reject before any file access.

Level: unit for the reducer and decisions (fast, pure); the contract suite is the integration
tier for the store port, and it runs against both stores. Step 3 and later only add cases to
the suite when a new port behaviour appears.

### Success criteria

**Automated:**
- `cd payo && pnpm check` passes.
- `cd payo && pnpm exec vitest run packages/kernel` passes.
- The spike result is recorded, and `pnpm check` passes with any boundary rows added.

**Manual:** none.

### What we're NOT doing

- No SQLite. That is phase 3.
- No gate command handlers. Step 4 wraps `decideGateResolve` and the `commit` flow.
- No fan-out, no concurrency limiter. Step 3 owns them.
- No ticket, workspace or code-host ports. Steps 4, 6 and 9.
- No runtime check that `dataDir` stays out of the Run. The type does not carry it.
- No in-process run lock. `openRun` is startup-only; step 5 enforces the order.

## Phase 3: `store-sqlite`

### Overview

The durable `RunStore` on `node:sqlite`, with artifacts as files under the data dir. It runs the
same contract suite as the memory store, plus SQLite-specific checks.

### Changes

- `payo/adapters/store-sqlite/src/index.ts`: `createSqliteRunStore(options: { dataDir: string }):
  Promise<RunStore>`.
  - Creates `<dataDir>/` and `<dataDir>/artifacts/` with `mkdirSync({ recursive: true })`.
  - Opens `<dataDir>/payo.db` with `DatabaseSync` from `node:sqlite`. Sets
    `PRAGMA journal_mode = WAL` and `PRAGMA user_version`. If `user_version` is 0, it creates, in one transaction, the schema
    and sets 1 (`CREATE TABLE IF NOT EXISTS`, so a crash between the two cannot wedge the file). If it is neither 0 nor 1, it throws.
  - Schema: `CREATE TABLE events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY (run_id, seq))`.
  - `append`: `BEGIN IMMEDIATE`, then read `MAX(seq)` for the run (0 when none). If it does not
    equal `expectedSeq`, roll back and throw `StaleSeqError`. Otherwise insert each body with
    `seq = expectedSeq + i + 1` and `at = new Date().toISOString()`, then `COMMIT`. A throw
    rolls back. An empty array is a no-op.
  - `read`: `SELECT ... WHERE run_id = ? AND seq >= ? ORDER BY seq`. Each `body` goes through
    `JSON.parse` and `RunEventBody.parse`. A malformed row throws, naming run id and seq.
  - `putArtifact`: sha256 of the bytes. If `artifacts/<sha256>` exists, skip the write. Otherwise
    write `artifacts/<sha256>.tmp-<random>`, `fsync` it, `renameSync` to the final name, then `fsync` the `artifacts/` directory. Returns
    `{ sha256, size, kind, mediaType }`.
  - `readArtifact`: reject a name that is not 64 lowercase hex before building the path; read the file, recompute the sha256, and throw on a mismatch or a missing file.
  - `close()`: `db.close()`.
  - The `DatabaseSync` calls are synchronous. Wrap them in `async` methods, with no extra
    concurrency.
- `payo/adapters/store-sqlite/src/index.test.ts` (new, colocated as in `apps/server/src/main.test.ts`):
  - `runStoreContract("sqlite", { open: () => createSqliteRunStore({ dataDir }) })`, with
    `dataDir` from `mkdtemp(join(tmpdir(), "payo-store-"))` per test, removed afterwards.
  - Plus the SQLite-specific cases below.
- `payo/adapters/store-sqlite/package.json`: no changes. Its dependencies already cover kernel
  and contracts. `node:sqlite` is built in.

### Tests

Write first, in the store-sqlite test file:

- Tampered artifact: overwrite `artifacts/<sha256>` with other bytes, then `readArtifact`
  throws an integrity error. Edge: the error names the expected hash.
- Malformed row: insert a row with `body = "{not json"` via a second `DatabaseSync` on the same
  file, then `read` throws and names the run id and seq. This pins parse-on-read.
- Schema version guard: set `PRAGMA user_version = 2` on a fresh file, then open the store and
  expect it to throw. Edge: an unrelated version must not be silently migrated.
- Data location: with a `mkdtemp` dir, the store creates only `payo.db` (plus its `-wal` and
  `-shm` files) and `artifacts/` under it. Nothing is created outside it. This guards the
  "tests never touch `~/.payo`" rule.
- The simulated-crash case (running attempt, close, reopen, interrupted gate) is already in the
  contract suite. Do not repeat it here.

Level: integration for the SQLite file, since the behaviour is the file's. Contract suite for the
port. No e2e in this step; step 5 owns the e2e test.

### Success criteria

**Automated:**
- `cd payo && pnpm check` passes.
- `cd payo && pnpm exec vitest run adapters/store-sqlite` passes.
- The temp dirs are gone after the run: `ls $TMPDIR | grep payo-store-` prints nothing.

**Manual:** none. Optional: open a test-created `payo.db` with `sqlite3` to see the rows.

### What we're NOT doing

- No `~/.payo` default. The caller passes `dataDir`; the server chooses it in step 5.
- No migrations framework. `user_version` is only a guard.
- No artifact garbage collection and no artifact index table. Events reference artifacts.
- No change to the `RunStore` port from phase 2.
- No WAL checkpoint tuning or sync-mode tuning.

## PR Strategy

Three phases, two PRs, stacked on step 1:

1. **PR A: phases 1 and 2** (contracts and kernel, including the in-memory store and the
   contract suite). Reviewable on its own. The kernel is pure and has no I/O.
2. **PR B: phase 3** (`store-sqlite`), on top of PR A. It is the only place `node:sqlite` and
   the filesystem appear.

Order: step 1 PR, then PR A, then PR B. Each is revertable: PR B alone can be reverted without
touching the kernel.

Nothing is pushed or opened without an explicit ask.

## Deviations (implementation log)

Planned before implementation (from review 1, `meta/reviews/plans/2026-10-30-payo-kernel-event-store-review-1.md`):

- Roadmap step 2 lists the data dir and concurrency in the effective config recorded on the Run. This plan records neither: `RunConfig` is opaque, `dataDir` is infrastructure, and the concurrency limiter arrives in step 3, with its setting coming in through config in step 5. The roadmap line needs updating by the owner.
- The roadmap lists a Run record under contracts. This plan has no `Run` record schema; `RunState` is kernel-internal.
- Biome spike, expected before the config change: `modules/` and `apps/cli/` imports of `@payo/kernel/testing` are not blocked. Record the actual result below.

Implementation (phases 1 and 2):

- Biome spike, run in a temp dir with a copy of `biome.json`. Before the change: `adapters/x` clean, `modules/x` clean, `apps/cli` clean, so `@payo/*` does not match the subpath, as expected. After adding `"@payo/kernel/testing"` to the modules and cli groups: `adapters/x` clean, `modules/x` and `apps/cli` each report `noRestrictedImports`.
- Phase 2 contract harness: `runStoreContract(name, makeHarness)` takes a per-case harness `{ open(), dispose() }`, not a single `{ open() }`. Each case needs fresh storage, and `dispose` removes the temp dir.
- `reduce(state, event)` takes `RunEventBody & { seq }`, not `RunEvent`. State holds no timestamps, so `at` is not needed to fold. `commit` folds with the seq it will write.
- `decideGateRaise` checks only that the step is running. The reducer enforces the rest (ended run, unknown or duplicate gate id) at commit, so the rule is not duplicated.
- The memory store round-trips each row through JSON, which copies the caller's data. The schema parse rejects a bigint before either store writes, so the batch-atomicity case tests the schema path for both stores, not serialisation. Round 3 renamed the case to say so. No test reaches a store-level serialisation failure; the case no longer claims one.
- `@payo/kernel/testing` also exports the event builders (`body`, `seqd`, `testRunInput`, `sha`) that the kernel tests share.
- `readArtifact` in the memory store checks the name and that the hash exists. It does not recompute the hash, as Phase 2 specifies. Only `store-sqlite` recomputes on read, since only it can be tampered with on disk. This amends the Design Decisions line "verified on read" for the memory store.
- Deferred to phase 3: the Biome adapters group does not carry the `@payo/kernel/testing` literal, so a production adapter file importing it is not blocked. Phase 3 adds `store-sqlite/src/index.test.ts`, the one legitimate importer. Close the gap then with a test-file override plus a failing row for a production adapter file.
- Phase 1 schemas: `seq` is typed `number`, not a positive integer, because the store assigns it. `model`, `roleSpecSha` and `attemptId` use `min(1)` on their non-null values, so an empty string is rejected; `null` still means absent.
- `sha256Hex`, `assertSha256` and the contracts `Sha256` schema are exported from the root. Phase 3 reuses them.

Review round 1 (audit swarm: scout, 7 lenses, verifier): the verifier returned BLOCK on missing reducer tests. Accepted and fixed: reducer tests for the four plan-mandated invariants; a step cannot finish while one of its attempts runs; a gate cannot be raised with the reserved `interrupted:` prefix (round 2 found the guard checked only the kind, so a running attempt could wedge `openRun`; fixed in round 2); a resolve with a command the gate did not offer is rejected in the reducer, not only in `decideGateResolve`; a `__proto__` config key throws, not silently drops; memory `append` validates (memory `putArtifact` validated after storing; corrected in round 2); the durability case uses the real artifact size; `openRun` names a missing run. Rejected as speculative or out of scope: the `z.json()` swap for `Json`, readonly collections on `RunState`, `type` placed after the spread in `decideGateRaise`, and step-5 config bounds.

Open questions for the owner: the `run.ended` running-step question is resolved above. The roadmap lines `docs/payo/implementation-roadmap.md:43,45` still need the owner's edit to match the plan.

Phase 3 (`store-sqlite`):

- Busy timeout: the connection opens with `timeout: 5000`. The Node default of 0 fails a contended write at once with "database is locked", not `StaleSeqError`. Probed across two processes: at 0 ms the loser gets SQLITE_BUSY; at 5000 ms it waits for the winner, then reads the winner's `MAX(seq)` and gets `StaleSeqError`. This makes the Risks line at 86-87 true. Cost: the synchronous wait blocks the event loop for up to 5 s. Accepted for the single-host server; step 5 owns any change.
- Bodies are parsed before `BEGIN IMMEDIATE`, so a bad batch never opens a transaction. The plan does not say this.
- The malformed-row test UPDATEs an existing row through a second connection. The plan says insert. Same guarantee (parse on read).
- The test-file Biome override is `adapters/**/*.test.ts`, which the plan's "only adapter tests import it" supports. Two boundary rows prove its negative side.
- `putArtifact` validates the `ArtifactRef` before writing, so invalid metadata leaves no file. A failed tmp write is removed. `readArtifact` rethrows any read error other than a missing file, instead of reporting it as "not found".
- `append` rolls back only when a transaction is still open (`db.isTransaction`), so a write that already rolled back (e.g. SQLITE_FULL) keeps its original error.
- Review round 1 (swarm, six lenses, verifier): no blocker. Accepted and fixed: the busy timeout, the validate-before-write order, tmp cleanup, the ENOENT-only read error, the guarded ROLLBACK, and the test gaps (invalid metadata, EISDIR, two runs in one store, stale-then-correct seq, the cross-process busy case, artifact listing before close, and the two test-file boundary rows). Rejected: byte caps and off-loop I/O (step 5), a stale-artifact re-hash on skip (the plan says an existing hash is never overwritten), and speculative notes. - Round 1 owner decisions, resolved by the owner (local-only tool, follow good patterns; fix now):
  - Owner-only modes: directories 0700 and files 0600 (`payo.db`, `-wal`, `-shm`, artifacts). SQLite copies the db file's mode to the WAL and shm files. Files that already exist in a caller's data dir keep their mode; only files the store creates are tightened.
  - Kernel contention test: the memory store's `append` now yields before it reads the log, as real I/O does, so the contract race is real. Proof: a mutated non-atomic check-then-write made the test fail; the restored code passes.
- `run.ended` with a running step is now refused, naming the step. This closes the plan's open question. The check runs after the attempt and gate checks, so the existing gate test keeps its message.
- Review round 2 (swarm, correctness, tests, security, verifier): one blocker and five non-blockers. Accepted and fixed: the reserved-gate guard now also requires the named attempt to be `interrupted` (the blocker); the memory store validates before storing; the SQLite store reads `user_version` before setting WAL, so a refused file keeps its journal mode; a test proves a partly written batch rolls back (the rollback guard is mutation-checked); the owner-only test uses a fresh data dir, so the store itself sets the mode; the cross-process test fails fast if the child exits early. Rejected: the subpath-grouping gap in Biome, which is latent (there is one subpath today).
- Not covered by a test: the tmp-file cleanup, and the `isTransaction === false` branch of the rollback guard (needs a fault that aborts the transaction itself), and the cross-process case runs on one machine only. The cross-process test's early-exit branch has no test.

- Review round 3 (swarm, correctness, tests, security, verifier; the last allowed round, so the fixes below were checked by tests, not re-swarmed). No blocker. Accepted and fixed: the recovery gate must also be on its attempt's step, with a test that pins the kind check (mutation-checked); `commit` and `startRun` now reject a `__proto__` config key before zod drops it silently, matching the plan's "throws, not drops" promise (that promise was true only for `resolveRunConfig` before); the SQLite artifacts directory is fsynced on the already-present path too; the cross-process test closes its store in `finally`; the owner-only test title says what it checks.
- Rejected: the speculative notes (no spec reserves the `interrupted-attempt` kind; the refused-file guarantee holds for the version check as written; no CI timing data).
- Deferred to step 4, a decision for the factory: a crash can leave a step `running` after its attempt is recovered. `run.ended` refuses while any step runs, so the factory must finish that step (for example with `step.finished` as failed) before it can end the run. Recovery does not close steps, on purpose.
- Known gap: the `__proto__` guard covers only `run.created` bodies. No other body carries a config.

_Further entries are added during implementation._
