# Payo step 6 — real adapters for slice 1

**Date:** 2026-10-31
**Work Item:** n/a (roadmap step 6)
**Status:** Complete

## Overview

Replace the empty `runner-pi`, `jira-acli`, and `git` stubs with real adapters behind the existing ports, add attempt correlation IDs and a raw Pi JSONL artifact, and make real adapters the default in `apps/server`. `payo doctor` fails fast on missing binaries or logins, and live tests stay opt-in because the current environment has no `acli` and no ready Pi login.

## Current State

- Roadmap step 6 defines the scope and exit criteria: `docs/payo/implementation-roadmap.md:97-109`. Step 7 owns tuning; this plan only makes real adapters the default and proves them with fixtures plus an opt-in smoke test.
- The engine design fixes Pi invocation, isolation flags, raw logs, and the OAuth-race question: `docs/payo/engine-design.md:107,169-174`.
- `payo/adapters/runner-pi/src/index.ts:1`, `payo/adapters/jira-acli/src/index.ts:1`, and `payo/adapters/git/src/index.ts:1` are `export {};`. Their packages already declare only `@payo/kernel` and `@payo/contracts`.
- `AgentRunner.run(spec, signal)` is defined at `payo/packages/kernel/src/agent.ts:5-8`. The kernel owns the attempt lifecycle at `payo/packages/kernel/src/agent-step.ts:149-251`; it already persists every normalised `AgentEvent`, records `attempt.started` with role/runner/model/skill SHA/input hashes, and records usage with an all-`"unknown"` default (`:158-179`).
- `AgentSpec` has no run/step/attempt IDs and no raw-log path: `payo/packages/contracts/src/agent.ts:9-20`. `AgentEvent` ids and model strings are uncapped (`:23-40`), a trust boundary step 3 deferred to step 6 (`meta/plans/2026-10-30-payo-agent-execution.md:572`).
- `TicketSource.get(key)` and `Workspace` are defined at `payo/packages/kernel/src/workspace.ts:3-9`. The factory calls both in `FetchTicket` (`payo/modules/factory/src/commands.ts:149-174`) and already snapshots the returned ticket as `factory-ticket-v1` (`:162`). The port stays unchanged: the factory already knows the run id and can prefix its own gate reason.
- Factory roles embed the exact snapshotted skill content and resources in `AgentSpec.instructions` (`payo/modules/factory/src/roles.ts:39-87`); the factory records skill path and SHA in run configuration (`commands.ts:343-357`). `RoleSource` is `{path, sha, content, resources}` (`modules/factory/src/types.ts:16-21`).
- `apps/server/src/composition.ts:154-194` is the only place concrete adapters are wired, and it currently hardcodes fakes, fake tickets, fake workspaces, and synthetic role sources. `apps/server/src/main.ts:16-22` refuses to start without `--dev-fakes`.
- `ServerConfig` has no binary, provider, or model fields (`apps/server/src/config.ts:7-17`). Configuration tests build literals in `apps/server/src/composition.test.ts:19-31` and `apps/server/src/config.test.ts:20-48`.
- `payo/package.json:5-17` defines `check` as Biome + `tsc` + Vitest. On this checkout the direct binaries pass: Biome clean, `tsc --noEmit` exit 0, Vitest 29 files / the existing suite (332 tests at review time). The `pnpm` shim is not configured in this shell; CI uses pnpm 10.9.0.
- Pi 1.4.0 is installed. Its local `docs/json.md` specifies strict LF-framed JSONL, `agent_settled` as the true end (after retries), `message_end` as the authoritative message, and top-level cumulative usage on `message_update`/message objects. `pi auth check --provider anthropic --json` returns `not_ready` here, and `acli` is not installed, so live checks cannot run in this environment.
- Pi reads the process cwd for project config, resource discovery, and relative reads, and it blocks on piped stdin unless stdin is closed (`pi docs/cli.md:39`; installed `pi` entrypoint). The adapter contract below makes both explicit.

## Design Decisions

| Decision | Options Considered | Rationale |
|---|---|---|
| Pass the snapshotted role text as the Pi prompt; do not use `--skill` | Prompt-only / materialise a temp `SKILL.md` and pass `--skill` / pass the repo skill path | The factory already embeds exact snapshot content and resources. `--skill` would either duplicate that or let the workspace drift from the recorded SHA. `--no-skills` keeps discovery out. Record the deviation in the engine design. |
| Real adapters are the default; `--dev-fakes` is explicit | Real default now / opt-in `--real` until step 7 | User chose real default. Startup doctor makes a broken environment fail before the port binds. Existing tests keep using `--dev-fakes`. |
| Every adapter spawns with argv, `shell: false`, and the run worktree as `cwd` | Shell strings / inherited cwd | `repo`, `baseBranch`, and `ticketKey` are HTTP-controlled and `bin` comes from env. `cwd` must be `spec.cwd`, or Pi inspects the server checkout and write tools can modify it. |
| Kernel captures raw Pi JSONL | Kernel temp capture / session-dir file only / new runner artifact event | The port has no store access. Kernel already owns artifacts and attempt ids, so it creates a temp `rawLogPath`, the adapter tees stdout, and the kernel stores one immutable artifact. |
| Raw tee appends each chunk and the kernel waits for adapter cleanup | Open file handle + close in `finally` / append per chunk | An open handle races the kernel's read and `rm`. `appendFile` with mode `0600` makes each chunk durable before its events are yielded; `streamAttempt` awaits `iterator.return()` for up to 1 s so the adapter stops writing before capture. |
| `payo doctor` is a server route plus a thin CLI command | Server route + CLI / CLI spawns binaries | Preserves the thin-client rule; adapters expose their own check flags. Real-mode startup prints failures to stderr and exits; the HTTP route is reachable in `--dev-fakes` mode, which is the documented diagnosis route. |
| Flatten Jira ADF to plain text | Store raw ADF / flatten | `Ticket.description` is a string and agents need readable text. Raw JSON is still visible in acli output if debugging; the factory snapshots the mapped ticket. |
| Worktrees are detached at the resolved base commit | Checkout the base branch / detached commit | Multiple runs must not fight over one local branch. Slice 1 is read-only; later slices create their own branches. |
| Role provenance uses the git blob SHA from the configured base commit, not `HEAD` | `HEAD:<path>` / working-tree hash / base commit | `config.repo` is an arbitrary checkout and `HEAD` may differ from `baseBranch`. Reading `HEAD` would record provenance for a different tree than the agent inspects. The base is resolved at composition time; restart if the branch moves. |
| Fixture tests inject `spawn`/`exec`; only live tests spawn real binaries | Spawn real binaries in unit tests / inject seams | Keeps `pnpm check` deterministic and offline while preserving a real smoke path. |
| Pin the provider and model in real mode | Allow harness defaults / require `PAYO_MODEL` | The doctor checks a provider; the runner must use the same provider. Requiring a bare `PAYO_MODEL` in real mode makes `--model <provider>/<model>` deterministic and prevents a green doctor with failing runs. |

## Implementation Phases

### Phase 1: Contracts, doctor schemas, and kernel correlation/raw-log capture

Add the fields every real attempt needs, move the doctor contracts ahead of their first use, and make the kernel persist the raw runner log without giving adapters store access.

**Changes:**

- `payo/packages/contracts/src/primitives.ts` — add:
  ```ts
  export const ModelId = z.string().min(1).max(256);
  export type ModelId = z.infer<typeof ModelId>;
  ```
  Use it for `AgentSpec.model` (`agent.ts`), `AgentEvent.started.model`, `attempt.started.model`, and `AttemptRecord.model` (`run.ts`).
- `payo/packages/contracts/src/agent.ts` — extend `AgentSpec` with optional fields:
  ```ts
  correlation: z
    .object({ runId: Id, stepId: Id, attemptId: Id })
    .optional(),
  rawLogPath: z.string().trim().min(1).optional(),
  ```
  Keep them optional so existing `AgentSpec` literals and factory role specs compile. Change `AgentEvent` trust-boundary caps: `started.model` becomes `ModelId.nullable()`; `tool_call.callId` and `tool_result.callId` become `z.string().min(1).max(256)`. `model` uses `ModelId.nullable()`.
- `payo/packages/contracts/src/api.ts` — add the doctor contracts here, before any adapter uses them:
  ```ts
  export const DoctorCheck = z.object({
    name: Id,
    ok: z.boolean(),
    detail: z.string().max(512),
  });
  export type DoctorCheck = z.infer<typeof DoctorCheck>;
  export const DoctorReport = z.object({
    ok: z.boolean(),
    checks: z.array(DoctorCheck),
  });
  export type DoctorReport = z.infer<typeof DoctorReport>;
  ```
  `contracts/src/index.ts` already re-exports `api.ts`; no new export line is needed.
- `payo/packages/contracts/src/agent.test.ts` — add: a spec with `correlation` and `rawLogPath` parses; a spec with an empty `runId`, a blank `rawLogPath`, or a 257-character `model` is rejected; a `started` event with a 257-character model is rejected; a `tool_call` with a 257-character `callId` is rejected.
- `payo/packages/contracts/src/api.test.ts` — add: `DoctorCheck` rejects a `detail` longer than 512 characters; `DoctorReport` parses an ordered check list.
- `payo/packages/kernel/src/agent-step.ts` — change `executeAttempt` so the attempt record is written in one place on every path:
  - Create a temp directory with `mkdtemp(join(tmpdir(), "payo-attempt-"))` and set `rawLogPath = join(dir, "events.jsonl")`. If creation fails, set it to `undefined` and continue; raw capture is best-effort. Create it inside a `try` whose `finally` removes it, so a later parse failure cannot leak the directory.
  - Build the runner spec with `AgentSpec.parse({ ...spec, correlation: { runId: deps.log.current().runId, stepId: input.stepId, attemptId }, rawLogPath })` and pass that spec to `streamAttempt`.
  - Remove the `attempt.finished` write from `streamAttempt`'s catch; `streamAttempt` flushes pending events and rethrows.
  - In `executeAttempt`, wrap `streamAttempt`:
    - On success, capture the raw log, then write `attempt.finished` with the run outcome and usage.
    - On failure, capture the raw log, then write `attempt.finished` with outcome `"failed"`, the watch usage, and `describeReason(error)`, then rethrow. The write is best-effort so the original error is preserved. A failing runner, schema-invalid event, or store write therefore still records the artifact before `attempt.finished`.
  - `captureRawLog` reads `rawLogPath` if it exists; when it has bytes, call `deps.store.putArtifact(bytes, { kind: "agent-raw-log", mediaType: "application/x-ndjson" })` and write `{ type: "artifact.recorded", artifact, attemptId }` through `deps.log`. Ignore read/put/log failures.
  - In `streamAttempt`'s `finally`, await `iterator.return()` for at most 1000 ms before returning, so the adapter stops writing before capture. Add `shortcut: awaiting runner cleanup for up to 1 s; upgrade if a real adapter needs longer.`
  - Remove the temp directory in `executeAttempt`'s existing `finally` with `rm(dir, { recursive: true, force: true })`, after capture.
  - Add a `shortcut:` comment: the raw log is unbounded; cap it when a real attempt produces a log large enough to matter.
- `payo/packages/kernel/src/agent-step.test.ts` — add four tests:
  1. A scripted runner reads `spec.correlation`, writes a known JSONL string to `spec.rawLogPath`, and emits a valid result. After the step, the log contains an `artifact.recorded` whose artifact kind is `agent-raw-log` and whose bytes equal the written string; `calls[0].correlation` equals `{ runId: "r1", stepId: "s1", attemptId: "a1" }`; the artifact row precedes `attempt.finished`.
  2. A runner that writes raw bytes and then throws still records the `agent-raw-log` artifact before the `attempt.finished` row with outcome `"failed"`.
  3. A runner that yields a result, then on `return()` waits 25 ms and appends bytes, produces an artifact containing those bytes (the kernel's bounded cleanup await).
  4. A runner that ignores `rawLogPath` emits a valid result; no `agent-raw-log` artifact is recorded.
- `payo/modules/factory/src/commands.ts` — in the `FetchTicket` catch, prefix the gate reason with the current run id: `run ${log.current().runId}: <message>`. The `TicketSource.get(key)` port does not change.
- `payo/adapters/runner-fake/src/index.test.ts` and `payo/packages/kernel/src/agent-step.test.ts` spec builders do not need changes because the new fields are optional.

*Implementation note:* the two failure-reason expectations in `apps/server/src/factory-flow.test.ts` were updated to include the new `run <runId>:` prefix.

**Success Criteria:**

#### Automated Verification:
- [x] Contracts and agent-step tests pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run packages/contracts/src/agent.test.ts packages/contracts/src/api.test.ts packages/kernel/src/agent-step.test.ts`
- [x] Types pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/tsc --noEmit`
- [x] Biome passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/biome check .`

#### Manual Verification:
- [ ] Read the new `artifact.recorded` ordering: raw artifact is written while the attempt is still running and before `attempt.finished`, on both success and failure.
- [ ] Confirm the temp directory is removed after success and after failure.

### Phase 2: `runner-pi`

Implement the Pi adapter: process contract, argument construction, strict JSONL framing, normalised mapping, cumulative usage, raw-log tee, abort/kill, and `checkPi`.

**Changes:**

- `payo/adapters/runner-pi/src/index.ts` — replace `export {};` with:
  ```ts
  export type PiExec = (
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  export interface PiRunnerOptions {
    bin?: string;              // default "pi"
    provider?: string;         // default "anthropic"; must match checkPi
    sessionRoot: string;       // absolute; per-attempt --session-dir parent
    spawn?: typeof spawn;      // test seam
  }
  export interface PiMapState {
    signal: AbortSignal;       // the run signal the kernel passed to run()
    model: string | null;
    started: boolean;
    finalText: string | null;
    lastStopReason: string | null;
    lastError: string | null;
    usage: UsageRecord;        // attempt-to-date totals
    done: boolean;
  }
  export function createPiRunner(options: PiRunnerOptions): AgentRunner; // id: "pi"
  export function mapPiRecord(
    record: unknown,
    state: PiMapState,
  ): AgentEvent[];
  export async function checkPi(options: {
    bin?: string;
    provider?: string;
    model?: string | null;
    exec?: PiExec;
  }): Promise<DoctorCheck>;
  ```
  Behaviour:
  - `run(spec, signal)` returns an async generator and has `id: "pi"`. The `sessionRoot` plus safe path segments (`runId`, `stepId`, `attemptId`, replacing characters outside `[A-Za-z0-9._-]` with `_`) is created with mode `0700` and passed as `--session-dir`. A missing `spec.correlation` throws `Error("runner-pi requires AgentSpec.correlation")`; the factory/kernel always supplies it.
  - Spawn contract: `spawn(bin, args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAYO_RUN_ID, PAYO_STEP_ID, PAYO_ATTEMPT_ID }, shell: false })`. Stdin is ignored so Pi does not wait for an `end`; the run worktree is the process cwd.
  - Arguments, in order: `--mode json`, `--tools <list>`, `--session-dir <dir>`, `--no-context-files`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-mcp`, `--no-approve`, optional `--model <provider>/<model>`, then `--`, then `spec.instructions`. Read-only tools are `read,grep,find,ls`; write tools are `read,grep,find,ls,edit,write,bash`. No `--skill` (see Design Decisions). If `spec.model` already contains `/`, use it unchanged; otherwise prefix `provider`.
  - Environment adds `PAYO_RUN_ID`, `PAYO_STEP_ID`, `PAYO_ATTEMPT_ID` from `spec.correlation`.
  - Stdout is consumed as bytes, decoded with a stream `TextDecoder`, and buffered across chunks: split only on `\n`, strip a trailing `\r`, keep the trailing partial line in a carry buffer, and flush the carry as a final line when stdout ends. Empty lines are skipped. A malformed line yields one `error` event whose message names the line number and stops the run. Unknown record types are ignored.
  - Each chunk is appended to `spec.rawLogPath` when set with `appendFile(path, chunk, { mode: 0o600 })` before its lines are processed; create the parent directories with mode `0700`. Ignore tee failures. There is no open file handle to close.
  - `mapPiRecord` mapping:
    - First assistant `message_end`: emit `{ type: "started", model }` once, clamped to 256 chars.
    - Assistant `message_end`: emit `{ type: "message", text }` for non-empty concatenated text blocks (clamped to 262144). Record `stopReason`/`errorMessage` for the terminal decision; do not emit an `error` here. Pi may still retry after `agent_end`.
    - `tool_execution_start`: emit `tool_call` with `callId` (clamped to 256), `name` (clamped to 128).
    - `tool_execution_end`: emit `tool_result` with clamped `callId`/`name` and `ok: !isError`.
    - `message_update`, `agent_end`, and retry records: ignore.
    - `agent_settled` is the only terminal record. If `done`, ignore. If `aborted` and `state.signal` is not aborted, emit `error` with the last error or `"pi aborted"`. Else if the last assistant `stopReason` is `"error"`, emit `error` with the last error text (clamped to 262144). Else if `finalText` exists, emit `result` (clamped to 262144); otherwise emit `error("pi ended without assistant text")`. Set `done`.
    - Usage: on each assistant `message_end`, add `input + cacheRead + cacheWrite` to `tokensIn`, `output` to `tokensOut`, and `cost.total` to `cost`; emit one cumulative `usage` event. Non-finite or missing values make that field `"unknown"` forever and never `0`.
    - Use one `clamp(value, max)` helper for `message`, `result`, `error.message`, `started.model`, tool `name`, `tool_result.name`, and `callId`.
  - Process exit before `agent_settled`: emit `error` with the exit code and the last 8192 characters of stderr. A child `error` event (for example `ENOENT`) becomes an `error` event, not a throw. Abort sends `SIGTERM`, then `SIGKILL` after 2000 ms (timer unref'd), and ends the stream without emitting an error.
  - Every exit path runs the generator's `finally`: if the child has not exited, kill it (`SIGTERM`, then the 2 s `SIGKILL` timer) and destroy stdout/stderr. An abort listener does the same when the run signal fires, which unblocks a stdout read.
- `payo/adapters/runner-pi/src/fixtures/valid.jsonl`, `tool-loop.jsonl`, `malformed.jsonl`, `error-exit.jsonl`, `split-line.jsonl` — recorded Pi 1.4.0-shaped streams containing: session header, agent/turn events, assistant `message_end` with text/usage, tool execution pair, `agent_end`, `agent_settled`; one tool loop with two assistant messages; one malformed line; one stream that ends without `agent_settled`; one fixture whose stdout is split mid-line.
- `payo/adapters/runner-pi/src/index.test.ts` — use `readFileSync(new URL("./fixtures/<name>.jsonl", import.meta.url), "utf8")` and a `spawn` stub that returns an `EventEmitter`-like child with `stdout`/`stderr` streams and a `kill` recorder. Tests:
  - `mapPiRecord` maps a valid stream to `started`, `message`, `usage`, and a final `result`; cumulative usage sums two assistant messages.
  - `mapPiRecord` maps tool execution start/end to `tool_call`/`tool_result`.
  - A per-message `stopReason: "error"` does not terminate; a later `agent_settled` still produces `result`.
  - A missing final text produces an `error`, not a `result`.
  - A 257-character model/callId and a 129-character tool name are clamped to the contract caps; a long result/error text is clamped.
  - Argument test: read-only spec produces exactly the documented flags and excludes `edit`/`write`/`bash`; a non-null model adds `--model <provider>/<model>`; the prompt follows `--`.
  - Spawn-options test: `cwd` is `spec.cwd`, `stdio` is `["ignore","pipe","pipe"]`, `shell` is false, `PAYO_*` is merged into `env`, and `kill("SIGTERM")` is called when the consumer stops early.
  - Session dir is under `sessionRoot/<run>/<step>/<attempt>`.
  - Raw tee: the bytes written to `rawLogPath` equal the fixture bytes and the file mode is `0600`.
  - Malformed JSONL through `run()` with the spawn stub produces an `error` event naming the line and no `result`.
  - A fixture split mid-line produces the same events as the same fixture delivered in one chunk.
  - Abort calls `kill("SIGTERM")` and the stream ends.
  - Non-zero exit with no `agent_settled` emits an error containing the exit code.
  - The default `PiExec` wraps `execFile`, resolves nonzero exits as `{ stdout, stderr, exitCode }`, and rejects only on spawn failure.
  - `checkPi` reports `ok: true` for exit 0 and `{"status":"ready"}`, and `ok: false` for `not_ready`/spawn failure; detail is capped to 512 characters and `runDoctor` redacts it.
- `payo/adapters/runner-pi/package.json` — no dependency changes.

**Success Criteria:**

#### Automated Verification:
- [x] Runner tests pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run adapters/runner-pi`
- [x] Types pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/tsc --noEmit`
- [x] Biome passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/biome check .`
- [x] No test invokes the real `pi` binary.

#### Manual Verification:
- [ ] Read the captured spawn options and confirm `cwd`, ignored stdin, merged env, and `shell: false`.
- [ ] Read the captured argument list in the test and confirm `--no-skills`, `--no-context-files`, `--no-extensions`, `--no-prompt-templates`, `--no-mcp`, and `--no-approve` are present.
- [ ] Confirm read-only tools do not include `bash`, `edit`, or `write`.

### Phase 3: `jira-acli`

Read one ticket through `acli`, flatten its ADF description, and expose an auth check.

**Changes:**

- `payo/adapters/jira-acli/src/index.ts` — replace `export {};` with:
  ```ts
  export type AcliExec = (
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  export interface AcliTicketSourceOptions {
    bin?: string;              // default "acli"
    exec?: AcliExec;           // test seam
    timeoutMs?: number;        // default 30000
  }
  export function createAcliTicketSource(
    options: AcliTicketSourceOptions,
  ): TicketSource;
  export function parseAcliTicket(raw: unknown): Ticket;
  export function adfToText(node: unknown): string;
  export async function checkAcli(options: {
    bin?: string;
    exec?: AcliExec;
  }): Promise<DoctorCheck>;
  ```
  Behaviour:
  - `get(key)` rejects keys that do not match `^[A-Z][A-Z0-9_]*-\d+$` before spawning. The `TicketSource` port stays `get(key: string)`; Jira key validation is adapter-local because fake and internal runs use short keys.
  - The default `AcliExec` wraps `execFile`, resolves nonzero exits as `{ stdout, stderr, exitCode }`, and rejects only on spawn failure.
  - Runs `["jira", "workitem", "view", key, "--json"]` with `execFile`/argv and `shell: false`. A non-zero exit throws `acli jira workitem view <key> failed (exit N): <stderr>`. Non-empty stderr on exit 0 is not a failure; stderr is used only in the error message.
  - `parseAcliTicket` accepts `{ key, fields: { summary, description }, self? }`; requires a non-blank key and summary; maps `description` through `adfToText` (a string passes through, null becomes `""`); derives `url` from `self` as `<origin>/browse/<key>` when `self` parses as a URL, else `null`; validates with `Ticket.parse`.
  - `adfToText` handles `text`, `hardBreak`, `paragraph`, `heading`, `bulletList`/`orderedList` with `listItem`, `codeBlock`, `blockquote`, `mention`, `inlineCard`, and nested `content`; joins text nodes without separators, separates blocks with `\n\n`, and trims the result. Unknown nodes recurse into `content` and otherwise contribute nothing.
  - `checkAcli` runs `["jira", "auth", "status"]` with a timeout; `ok` when exit code is 0; otherwise `detail` is the exit code plus a 512-character-capped stderr/stdout excerpt or the spawn error. `runDoctor` redacts token-shaped strings before the report is served. Never pass `--credentials`; never print tokens.
- `payo/adapters/jira-acli/src/fixtures/ticket-adf.json` — `{key, self, fields:{summary, description}}` with paragraphs, a bullet list, a hard break, inline code, and a mention.
- `payo/adapters/jira-acli/src/fixtures/ticket-minimal.json` — string description and no `self`.
- `payo/adapters/jira-acli/src/index.test.ts` — tests:
  - The ADF fixture becomes a `Ticket` whose description contains the paragraph text, list items on separate lines, and the mention; URL is `<origin>/browse/<key>`.
  - Minimal fixture gives a string description and `url: null`.
  - Missing key/summary, non-object JSON, and an invalid ticket key throw.
  - The exec seam receives exactly `jira workitem view ABC-123 --json`; non-zero exit includes stderr in the error; exit 0 with non-empty stderr succeeds.
  - `checkAcli` maps exit 0 to ok and exit 1 to a failed check; detail is capped to 512 characters.
- `payo/adapters/jira-acli/package.json` — no dependency changes.

**Success Criteria:**

#### Automated Verification:
- [x] Adapter tests pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run adapters/jira-acli`
- [x] Types pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/tsc --noEmit`
- [x] Biome passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/biome check .`
- [x] No test invokes the real `acli` binary.

#### Manual Verification:
- [ ] Inspect the flattened description from the ADF fixture and confirm no block text was dropped.

### Phase 4: `git` workspace

Create and remove per-run worktrees safely, keep registrations recoverable, and expose a repository/base check plus a shared `GitExec` for other server modules.

**Changes:**

- `payo/adapters/git/src/index.ts` — replace `export {};` with:
  ```ts
  export type GitExec = (
    args: string[],
    options: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  export function createGitExec(options?: {
    bin?: string;
    timeoutMs?: number;
  }): GitExec;
  export interface GitWorkspaceOptions {
    root: string;              // <dataDir>/worktrees
    bin?: string;              // default "git"
    exec?: GitExec;            // test seam
    timeoutMs?: number;        // default 30000
  }
  export function createGitWorkspace(options: GitWorkspaceOptions): Workspace;
  export async function resolveBaseCommit(
    repo: string,
    base: string,
    exec: GitExec,
  ): Promise<string>;
  export async function checkGit(options: {
    bin?: string;
    repo: string;
    base: string;
    exec?: GitExec;
  }): Promise<DoctorCheck>;
  ```
  `createGitExec` uses `execFile` with argv, `shell: false`, and a timeout; it resolves nonzero exits as `{ stdout, stderr, exitCode }` and rejects only on spawn failure. `createGitWorkspace` uses the injected `exec` or creates one from `bin`/`timeoutMs`; the workspace and `role-sources.ts` share one instance.
  Behaviour:
  - `create(runId, repo, base)`:
    - Validate `runId` with `^[A-Za-z0-9][A-Za-z0-9._-]*$` and reject `.`/`..`.
    - Resolve `path = join(root, runId)` and reject unless `resolve(path)` is strictly inside `resolve(root)` (compare against `resolve(root) + sep`).
    - Validate `repo` is an absolute path and `git -C repo rev-parse --show-toplevel` succeeds.
    - `resolveBaseCommit` tries `refs/heads/<base>^{commit}`, then `refs/remotes/origin/<base>^{commit}`, then `<base>^{commit}`; it returns the commit id or throws `base <base> not found in <repo>`.
    - If `path` exists, resolve it with `realpath(path)` and re-check containment; a symlink escaping `root` is rejected. If it appears in `git -C repo worktree list --porcelain`, rewrite the metadata and return it unchanged (idempotent after a crash). If it exists and is not registered, throw; never delete it.
    - Create `root` and `<root>/.meta` with mode `0700`; write `<root>/.meta/<runId>.json` with `{ repo }` mode `0600` (so `remove` can prune even when the directory is gone).
    - Run `git -C repo worktree prune` to clear dangling registrations, then `git -C repo worktree add --detach <path> <commit>`.
  - `remove(path)`:
    - Read `runId = basename(path)` and reject unless `resolve(path)` is strictly inside `resolve(root)` (throw, do not no-op).
    - If `path` exists, resolve symlinks with `realpath(path)` and re-check containment; a symlink escaping `root` is rejected.
    - Read the meta repo from `<root>/.meta/<runId>.json` when present.
    - If `path` does not exist: if a meta repo exists, run `git -C repo worktree prune`, delete the meta file, and return. If no meta exists, return. A missing directory is not an error.
    - If `path` exists: derive `common = resolve(path, await git -C path rev-parse --git-common-dir)`; if that fails, derive it from the meta repo with `git -C repo rev-parse --git-common-dir`. Verify the path is a registered worktree via `git --git-dir=<common> worktree list --porcelain`; if not, throw `not a registered worktree`. Run `git --git-dir=<common> worktree remove --force <path>`. If that fails, remove the directory and run `git --git-dir=<common> worktree prune`. Delete the meta file. A path that exists but is not a worktree is rejected and never deleted.
  - `checkGit` uses the injected `exec` or creates one from `bin`; it runs `git --version`, then `resolveBaseCommit` in `repo`; `ok` when both succeed, `detail` names the resolved commit or the failure (capped to 512 characters).
- `payo/adapters/git/src/index.test.ts` — use `mkdtemp` plus real `git init`, config, commit on a temporary repo; no network and no fixtures:
  - `create` produces a worktree whose `HEAD` equals the base commit and whose path is `<root>/<runId>`.
  - A second `create` for the same run returns the same path without error.
  - An existing unregistered directory is rejected and left untouched.
  - Invalid run ids, traversal attempts, a non-git repo, and a missing base throw.
  - `remove` deletes a created worktree, is idempotent, and rejects an unregistered path outside `root` (throws).
  - “Directory deleted → `remove` → `create`” works: `remove` prunes the stale registration, and `create` adds the worktree again.
  - A path that exists but is a plain directory with no registration is rejected by `remove`.
  - A broken `rev-parse` is rejected; a meta repo lets `remove` prune without reading the deleted directory.
  - `checkGit` reports ok with a commit for a valid repo/base and fails for a bad base.
- `payo/adapters/git/package.json` — no dependency changes.

**Success Criteria:**

#### Automated Verification:
- [x] Adapter tests pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run adapters/git`
- [x] Types pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/tsc --noEmit`
- [x] Biome passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/biome check .`
- [x] After each removal test, `git -C <temp-repo> worktree list --porcelain` contains only the main worktree, and the linked worktree path is absent.

#### Manual Verification:
- [ ] Confirm a second `create` after a simulated crash reuses the registered worktree and does not reset it.
- [ ] Confirm deleting a worktree directory, then `remove`, then `create` succeeds.

### Phase 5: Real composition, role sources, doctor, and real default

Wire the adapters as the default, resolve real role sources from the configured base commit, expose doctor, and keep fakes behind `--dev-fakes`.

**Changes:**

- `payo/apps/server/src/config.ts` — add to `ServerConfig`:
  ```ts
  piBin: string;       // PAYO_PI_BIN, default "pi"
  acliBin: string;     // PAYO_ACLI_BIN, default "acli"
  gitBin: string;      // PAYO_GIT_BIN, default "git"
  piProvider: string;  // PAYO_PI_PROVIDER, default "anthropic"
  model: string | null;// PAYO_MODEL, default null; required in real mode
  ```
  Trim and reject blank binary/provider values. Reject a `PAYO_MODEL` containing `/` (the provider is separate). `loadConfig` still returns `model: null` when unset; real mode requires a non-blank `PAYO_MODEL` at startup (`main.ts`) and again in `createAdapterSet` for direct callers. Reject `PAYO_SCENARIO` unless `--dev-fakes` is present. Keep `devFakes: argv.includes("--dev-fakes")`; real is the default.
- `payo/apps/server/src/config.test.ts` — assert the new defaults (`piBin`, `acliBin`, `gitBin`, `piProvider`, `model: null`) and overrides; assert `PAYO_SCENARIO` without `--dev-fakes` throws `/--dev-fakes/`; assert blank bins/provider and a slash in the model are rejected.
- `payo/apps/server/src/role-sources.ts` — new file:
  ```ts
  export const roleSkillPaths = {
    planner: { path: "skills/create-plan/SKILL.md", resources: [] },
    reviser: { path: "skills/create-plan/SKILL.md", resources: [] },
    reviewer: {
      path: "skills/review-plan/SKILL.md",
      resources: ["skills/review-plan/references/lenses.md"],
    },
    verifier: {
      path: "skills/review-plan/SKILL.md",
      resources: ["skills/review-plan/references/lenses.md"],
    },
  } as const;
  export async function loadRoleSources(
    repo: string,
    base: string,
    exec: GitExec,
  ): Promise<Record<"planner" | "reviewer" | "verifier" | "reviser", RoleSource>>;
  export async function checkRoleSources(
    repo: string,
    base: string,
    exec: GitExec,
  ): Promise<DoctorCheck>;
  ```
  The `resources` arrays above are path lists; load each and return `RoleSource.resources` as `Record<path, content>` to match `modules/factory/src/types.ts:16-21`. Resolve the base commit once with `resolveBaseCommit(repo, base, exec)`, then for each path run `git -C repo rev-parse <commit>:<path>` for the blob SHA and `git -C repo show <commit>:<path>` for content; do the same for resources. Reject empty content, absolute paths, and paths escaping the repo. Throw `role source <path> not found at <commit> in <repo>` on failure. `checkRoleSources` returns ok with `"4 role sources at <commit>"` when all load. It receives the same `GitExec` instance as the workspace, so there is only one git invocation path. The base is resolved once at composition time; if the base branch moves while the server runs, restart before starting runs so role text and worktrees share a commit.
- `payo/apps/server/src/role-sources.test.ts` — create a temp git repo with committed `skills/create-plan/SKILL.md` and `skills/review-plan/SKILL.md` plus `references/lenses.md`; assert content and SHA equal the base commit, that a working-tree edit after the commit does not change the loaded content, that loading an older base commit returns that commit's bytes while `HEAD` is newer, and that a missing path fails with the named error.
- `payo/apps/server/src/adapters.ts` — new file:
  ```ts
  export interface AdapterSet {
    runner: () => AgentRunner;
    tickets: TicketSource;
    workspace: Workspace;
    roleSources: Record<"planner" | "reviewer" | "verifier" | "reviser", RoleSource>;
  }
  export async function createAdapterSet(config: ServerConfig): Promise<AdapterSet>;
  ```
  `runner` is a factory so each run gets its own fake script cursor; a real Pi runner is stateless and can be returned from the same factory.
  - Fake branch (selected only by `config.devFakes`): keep the existing `Scenario`, scripts, fake ticket/workspace, and synthetic role sources from `composition.ts`/`factory-fixtures.ts`. `runner: () => createFakeRunner(scriptsFor(scenario))`.
  - Real branch: if `config.model === null` throw `PAYO_MODEL is required in real mode`; create `const gitExec = createGitExec({ bin: config.gitBin })`; `const pi = createPiRunner({ bin: config.piBin, provider: config.piProvider, sessionRoot: join(config.dataDir, "sessions") })`; `runner: () => pi`; `tickets: createAcliTicketSource({ bin: config.acliBin })`; `workspace: createGitWorkspace({ root: join(config.dataDir, "worktrees"), bin: config.gitBin, exec: gitExec })`; `roleSources: await loadRoleSources(config.repo, config.baseBranch, gitExec)`.
  - Move `scenarioOf` and the fake scripts here; keep `factory-fixtures.ts` exports unchanged. `scenarioOf` is called only in the fake branch. The server may import adapter values; the real invariant is that `createAdapterSet` is the only place that constructs them from config, while `doctor.ts` imports the probe functions.
- `payo/apps/server/src/composition.ts` — before creating anything, guard `if (config.scenario !== null && !config.devFakes) throw new Error("fake scenarios require --dev-fakes")`. Remove the hardcoded fake runner/tickets/workspace/role sources. Add `adapters?: AdapterSet` and `doctor?: () => Promise<DoctorReport>` to `CompositionOptions`; use `options.adapters ?? await createAdapterSet(config)`. `depsForRun()` calls `adapters.runner()` for a fresh runner and uses `adapters.tickets`/`workspace`/`roleSources`. Build `roles` from `config.model` for all four roles with the existing 120000 ms timeouts. Add `doctor(): Promise<DoctorReport>` to `Composition`, backed by `options.doctor ?? (() => runDoctor(config))`. Keep startup recovery, limiter, and handle logic unchanged.
- `payo/apps/server/src/doctor.ts` — new file:
  ```ts
  export interface DoctorProbes {
    pi: typeof checkPi;
    acli: typeof checkAcli;
    git: typeof checkGit;
    roleSources: typeof checkRoleSources;
  }
  export async function runDoctor(
    config: ServerConfig,
    probes?: Partial<DoctorProbes>,
  ): Promise<DoctorReport>;
  ```
  Create one `const gitExec = createGitExec({ bin: config.gitBin })`. Run the four checks concurrently, in order `pi`, `acli`, `git`, `skills`; `ok` is true only when every check is ok. Wrap each probe in a `safeCheck` that catches a rejection and returns a failed check, so `runDoctor` is total. Cap each `detail` at 512 characters and redact token-shaped strings (`ghp_…`, `sk-…`, `Bearer …`, long JWT-like strings). Pass `config.piBin`, `config.piProvider`, and `config.model` to `checkPi`; `config.acliBin` to `checkAcli`; `config.repo`, `config.baseBranch`, and `gitExec` to `checkGit`; and `config.repo`, `config.baseBranch`, and `gitExec` to `checkRoleSources`. Every probe gets a timeout (`pi auth check` may refresh OAuth and can hang).
- `payo/apps/server/src/doctor.test.ts` — stub each probe and assert: all-ok report; a single failure makes the report not ok; a rejecting probe becomes a failed check, not a rejected doctor; the names/order are `pi`, `acli`, `git`, `skills`; probe arguments receive the config values; details are capped and redacted.
- `payo/apps/server/src/http.ts` — add a doctor route before the `runs` check: accept only `segments.length === 3 && segments[2] === "doctor"`; return `DoctorReport.parse(await services.doctor())` with the existing CORS/JSON helpers. Other methods return 405. `/api/v1/doctor/anything` falls through to 404.
- `payo/apps/server/src/http.test.ts` — pass a stub `doctor` in the harness composition and assert `GET /api/v1/doctor` returns the report, requires the bearer token, rejects `POST`, and that `/api/v1/doctor/anything` is 404.
- `payo/apps/cli/src/args.ts` — add `{ command: "doctor" }`; it takes no arguments.
- `payo/apps/cli/src/client.ts` — import `DoctorReport` and add `doctor(): Promise<DoctorReport>` calling `/api/v1/doctor`.
- `payo/apps/cli/src/index.ts` — handle `doctor`: print one line per check (`ok <name>: <detail>` or `FAIL <name>: <detail>`), then return `report.ok ? 0 : 1`.
- `payo/apps/cli/src/args.test.ts` and `client.test.ts` — cover the new command, no-argument rejection, contract validation, and exit code mapping.
- `payo/apps/server/src/main.ts` — remove the `--dev-fakes` refusal. After loading config and before `ensureServerToken`/binding, when `!config.devFakes`, fail with `PAYO_MODEL is required in real mode` if `config.model` is null; otherwise run `runDoctor(config)`, print each failed check to stderr, set `process.exitCode = 1`, and return before binding when the report is not ok. Fake mode skips startup doctor but still serves the doctor route. Keep the existing bind-then-compose flow.
- `payo/apps/server/src/main.test.ts` — keep the `--dev-fakes` startup test. Add a real-mode test that spawns with `PAYO_PI_BIN=/nonexistent-payo-pi`, `PAYO_ACLI_BIN=/nonexistent-payo-acli`, a temp `PAYO_REPO`, temp `PAYO_DATA_DIR`, `NODE_ENV=test`, `PAYO_TEST_PORT=0`, and `PAYO_MODEL=test-model`, and asserts the process exits non-zero with a `doctor`/`FAIL` line and never prints `payo server ready`.
- `payo/apps/server/package.json` — add `@payo/runner-pi`, `@payo/jira-acli`, and `@payo/git` workspace dependencies. Update `pnpm-lock.yaml` with `cd payo && pnpm install --lockfile-only` (or the working `rtk proxy pnpm -C payo install --lockfile-only`); verify the diff touches only the `apps/server` importer.
- `payo/apps/server/src/composition.test.ts` — add the new config fields to the local `config()` helper. Add a test that a real-mode composition uses an injected adapter set (pass fake adapters with `devFakes: false, scenario: null, model: "test-model"`) and serves summaries; keep the scenario-without-fakes error test. Add a test that a second run gets a fresh fake runner from `adapters.runner()`.

*Implementation note:* the `apps/server` lockfile importer was updated by hand because the `pnpm` shim is not configured in this shell; the diff touches only that importer.

**Success Criteria:**

#### Automated Verification:
- [x] Server/config/doctor/CLI tests pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run apps/server/src/config.test.ts apps/server/src/role-sources.test.ts apps/server/src/doctor.test.ts apps/server/src/composition.test.ts apps/server/src/http.test.ts apps/server/src/main.test.ts apps/cli/src/args.test.ts apps/cli/src/client.test.ts`
- [x] Types pass: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/tsc --noEmit`
- [x] Biome passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/biome check .`
- [x] Boundary tests pass, including the new server imports: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run test/boundaries.test.ts`
- [x] No test invokes real `pi` or `acli`.

#### Manual Verification:
- [x] Start `payo serve --dev-fakes` against a temp data dir and run `payo doctor`; it reports real-tool readiness without changing fake behavior. This is the documented diagnosis route when real-mode startup fails.
- [x] With a temporary repo that has no `skills/` at the base commit, real-mode startup exits non-zero with a `doctor` failure before listening.

### Phase 6: Opt-in live smoke and documentation

Prove the Pi adapter against the real harness without making `pnpm check` depend on credentials, and record the decisions.

**Changes:**

- `payo/apps/server/src/live.test.ts` — new file:
  ```ts
  describe.runIf(process.env.PAYO_LIVE === "1")("live Pi smoke", () => {
    // create a temp data dir and session root
    // use createGitWorkspace on PAYO_REPO (default cwd) at PAYO_BASE_BRANCH (default "main")
    // drive createPiRunner directly with a read-only spec; the kernel assigns its own rawLogPath in normal runs
  });
  ```
  Each spec includes `cwd` (the worktree), `correlation: { runId, stepId, attemptId }`, `sessionRoot` via the runner options, a temp `rawLogPath`, `model`, and `timeoutMs: 120000`.
  Two runs:
  1. Instructions: `Return exactly {"ok":true} and nothing else.` with `jsonEnvelope(z.object({ ok: z.literal(true) }))`. Assert the result parses.
  2. Instructions: `Create a file named canary.txt with the text "x", then return exactly {"ok":true} and nothing else.` with read-only tools. Assert the envelope parses and `canary.txt` does not exist in the worktree.
  Assert `spec.rawLogPath` receives the raw JSONL bytes. Remove the worktree in `finally`.
- `payo/package.json` — add `"smoke": "PAYO_LIVE=1 vitest run apps/server/src/live.test.ts"`.
- `README.md` — update the Payo section: real adapters are the default; `payo serve --dev-fakes` is the fake mode; `payo doctor` and startup doctor; `PAYO_PI_BIN`, `PAYO_ACLI_BIN`, `PAYO_GIT_BIN`, `PAYO_PI_PROVIDER`, `PAYO_MODEL` (required in real mode); `pnpm -C payo payo doctor`; `pnpm --filter @payo/cli smoke` is not the command — use `pnpm -C payo smoke` from the repo root; live tests require `pi` auth and a real repo. State that when real-mode startup fails the doctor is reachable by running `payo serve --dev-fakes` and then `payo doctor`.
- `docs/payo/engine-design.md` — update the status line to say real adapters exist behind the ports and the server defaults to them. Update the Pi paragraph: role text is passed as the prompt from the snapshot; `--skill` is intentionally not used; the child runs with `cwd` set to the worktree and stdin ignored; raw JSONL is stored as an `agent-raw-log` artifact. Leave the OAuth-race item in "Not decided yet" until the live smoke is run, then record the observed result and workaround. Leave `TicketSource.get(key: string)` unchanged.
- `docs/payo/implementation-roadmap.md` — replace the step 6 `--skill` sentence with the prompt-from-snapshot decision; state that worktrees are detached at the resolved base commit, removed on approve, and retained while a run is resumable; note that escalated/cancelled/abandoned worktrees are a known cleanup gap deferred to a later slice. Change the step 7 bullet “Wire the real adapters in `apps/server` as the default” to “Tune the real adapters now that they are the default.” After the live smoke runs, replace the step 6 "Settles" sentence with the observed result (race or no race, and the workaround). Do not mark step 7 complete.

*Implementation note:* the live test asserts the `{"ok":true}` envelope with a small `OutputValidator` instead of `jsonEnvelope(z.object(...))` because `apps/server` has no direct `zod` dependency; no dependency was added. The OAuth-race sentence stays unmeasured until the live smoke runs.

**Success Criteria:**

#### Automated Verification:
- [x] The live file is skipped without the flag: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run apps/server/src/live.test.ts` reports the suite skipped and exits 0.
- [x] Full suite passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/vitest run`
- [x] Full check passes: `cd /Users/alvarogomez/code/python/agentic-hub/payo && ./node_modules/.bin/biome check . && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run` (CI equivalent: `pnpm -C payo check`).
- [x] Documentation links and command examples match the implemented flags.

#### Manual Verification:
- [ ] With a ready Pi login and a git repo at the base branch: `cd /Users/alvarogomez/code/python/agentic-hub/payo && PAYO_LIVE=1 PAYO_REPO=/Users/alvarogomez/code/python/agentic-hub npx vitest run apps/server/src/live.test.ts` passes both runs, and `canary.txt` is absent.
- [ ] `git worktree list --porcelain` no longer lists the smoke worktree after the test.
- [ ] If two parallel Pi runs are attempted through `PAYO_MAX_CONCURRENT_AGENTS=2`, record whether the OAuth token refresh races; if it does, set the documented workaround (concurrency 1 or a warm-up call) in the engine design.
- [ ] `payo doctor` against a configured environment reports pi, acli, git, and skills as ok and never prints a token.
- [ ] In a repo where `HEAD` differs from `PAYO_BASE_BRANCH`, the recorded skill SHA and content match the base commit, not `HEAD`.

## Out of Scope

- Jira writes, transitions, comments, or attachments; the ticket adapter stays read-only.
- Branch creation, commits, pushes, pull requests, `gh`, `CodeHost`, `Checks`, and PR review; later slices.
- The web UI, browser authentication, and token prompt.
- Multiple repositories, extra read-only repos, or a repo different from the one holding `skills/`.
- Model routing, model fallback, thinking levels, Ollama Cloud, Claude Code, or Codex runners.
- Retrying failed real attempts automatically; the existing one-retry-on-invalid-output rule is unchanged.
- Exact billing reconciliation; Pi cost remains an estimate and `unknown` stays `unknown`.
- Windows path/permission behavior; the repo targets Node 24 on POSIX.
- Capping raw-log size or attempt-event rows; both remain documented shortcuts.
- Sweeping worktrees for escalated, cancelled, interrupted, or abandoned runs. They are retained while a run can resume; approved runs remove theirs. This gap is recorded in the roadmap.
- Moving Jira key validation into `StartRunRequest`: fake and internal runs use short ticket keys, so the adapter validates Jira-shaped keys before spawning.
- Fixing the OAuth race before it is observed; step 6 measures and documents it.

## Risks & Mitigations

- **Pi inspects the wrong tree or hangs on stdin.** → Spawn with `cwd: spec.cwd`, `stdio: ["ignore","pipe","pipe"]`, merged env, `shell: false`; test the spawn options. The fixture/stub tests cannot catch either without this assertion.
- **A raw log is captured while the adapter is still writing.** → The adapter appends each chunk durably with mode `0600`; `streamAttempt` awaits `iterator.return()` for up to 1 s before `executeAttempt` reads and removes the temp dir. Tests cover success, failure, and delayed cleanup.
- **Parallel Pi runs race on OAuth token refresh.** → Keep the process-wide limiter. The live smoke records whether two runs race; if they do, document concurrency 1 or a warm-up call. Do not silently retry.
- **Pi's JSON stream changes between releases.** → Map only documented record types, ignore unknown types, keep fixtures from Pi 1.4.0, and turn malformed lines into an `error` event so the attempt ends in an escalation gate rather than hanging.
- **A per-message Pi error aborts a retryable attempt.** → Only `agent_settled` ends the run; per-message `stopReason: "error"` is informational until the terminal record.
- **A large prompt exceeds the argv limit.** → Current role content is a few tens of KB (`create-plan` 111 lines, `review-plan` 146 lines). If a future skill grows past the limit, write the prompt to a temp file and pass `@path`; not needed now.
- **Raw logs grow without bound.** → One `shortcut:` comment; add a size cap when a real attempt produces a log large enough to matter.
- **Worktree cleanup deletes the wrong directory.** → Require the path to be strictly inside the configured root, resolve symlinks for existing paths, accept only registered worktrees for reuse, and refuse an unregistered existing directory. Removal falls back only after the worktree command fails.
- **`git worktree remove` cannot find the main repo from a linked worktree.** → Persist `{ repo }` per run under `<root>/.meta`, derive `--git-common-dir` when the path exists, and prune with the persisted repo when the directory is gone.
- **A stale registration blocks re-creation.** → `create` runs `worktree prune` before `worktree add`; `remove` prunes and deletes the metadata even when the directory is missing. Test “directory deleted → remove → create.”
- **ACLI exits 0 but writes warnings to stderr.** → Gate on exit code; use stderr only in error messages.
- **ACLI ADF shapes vary.** → Recurse on `content` and fall back to text nodes; unknown blocks lose formatting, not text. The mapped ticket is snapshotted by the factory.
- **Role text comes from a different commit than the worktree.** → Resolve role blobs against the configured base commit, not `HEAD`; test a repo where `HEAD` differs from the base. If the base branch moves while the server runs, restart before starting runs so role text and worktrees share a commit.
- **A real server starts without `pi`/`acli` and fails mid-run.** → Real mode runs `runDoctor` before binding and exits non-zero with the failed checks. `--dev-fakes` remains for offline work.
- **`payo doctor` is unreachable when real startup fails.** → Startup prints the failed checks to stderr; the HTTP doctor route is documented as available via `payo serve --dev-fakes`, which uses the same config and probes.
- **Doctor produces false negatives due to network or auth expiry.** → Every probe has a timeout; a rejected probe becomes a failed check; the report names the exact failure and never treats an unchecked tool as ready.
- **Doctor output leaks a token.** → `DoctorCheck.detail` is capped at 512 characters; `runDoctor` redacts token-shaped strings; adapters never pass `--credentials`.
- **Kernel raw capture fails on a read-only temp dir.** → Treat raw capture as best-effort; the attempt proceeds and only the raw artifact is missing.
- **Schema additions break existing callers.** → `correlation` and `rawLogPath` are optional; `ModelId` only tightens already-overlong values; the existing suite remains the regression gate.
- **Fake scenarios break when the runner becomes a singleton.** → `AdapterSet.runner` is a factory, so each run gets a fresh fake script cursor; real Pi is stateless.
- **Scenario validation bricks real mode.** → `loadConfig` rejects `PAYO_SCENARIO` without `--dev-fakes`; composition guards `config.scenario !== null && !config.devFakes`; adapters are selected by `devFakes` only.
- **Doctor and runner use different providers.** → Real mode requires a bare `PAYO_MODEL` at startup and in `createAdapterSet`; the runner passes `--model <PAYO_PI_PROVIDER>/<PAYO_MODEL>` and the doctor checks the same provider.
- **Lockfile drift.** → Add server dependencies to `package.json`, regenerate with `pnpm install --lockfile-only`, and confirm only the `apps/server` importer changed.
- **Live tests accidentally run in CI.** → `describe.runIf(process.env.PAYO_LIVE === "1")`; the default suite reports the file skipped.

## Plan Validation

- Roadmap step 6 maps to: Pi adapter (Phase 2), Jira adapter (Phase 3), Git workspace (Phase 4), correlation/raw logs (Phase 1), doctor and real wiring (Phase 5), fixtures and live smoke (Phases 2–4 and 6).
- Every phase ends with `vitest`/`tsc`/Biome checks that run offline, and each phase compiles independently: the doctor contracts ship in Phase 1, `PiExec` is defined in Phase 2, and `id: "pi"` is explicit.
- Names are consistent across phases: `AgentSpec.correlation`, `AgentSpec.rawLogPath`, `ModelId`, `DoctorCheck`, `DoctorReport`, `agent-raw-log`, `createPiRunner`, `createAcliTicketSource`, `createGitExec`, `createGitWorkspace`, `loadRoleSources`, `createAdapterSet`, `runDoctor`.
- The real Pi process contract is explicit: `cwd: spec.cwd`, stdin ignored, merged env, `shell: false`, and kill/destroy on every exit path.
- The raw-log contract is explicit: append per chunk (`0600`), bounded cleanup await, capture before `attempt.finished` on success and failure.
- Worktree lifecycle is explicit: detached at the base commit, reused only when registered, pruned when stale, removed on approve, retained while resumable, with the non-approved sweep deferred.
- Live verification is a manual gate because this environment has no `acli` and no ready Pi login; automated verification covers the same mappings with fixtures.
