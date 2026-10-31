# Plan Review: Payo step 6 — real adapters for slice 1

**Date:** 2026-10-31
**Target:** meta/plans/2026-10-31-payo-real-adapters.md
**Review:** 1
**Verdict:** REVISE

## Assessment

The plan is well researched and its Pi 1.4.0 claims (flags, JSONL framing, `message_end`/`agent_settled`, usage shape) check out against the installed harness. The port/adapter boundaries and the fixture-injection strategy are sound. However, several process-level details are missing or wrong in ways that make real runs impossible rather than merely imperfect: the child process is never given the worktree as `cwd`, stdin is left as an open pipe that Pi blocks on before it starts, and Phases 2–4 reference contracts that do not exist until Phase 5. The raw-log capture ordering also fails on exactly the failure paths it is meant to diagnose. These need fixing before implementation.

Baseline on this checkout: Biome clean, `tsc --noEmit` exit 0, Vitest 29 files / **332** tests (the plan says 329).

## Cross-Cutting Themes

1. **The real Pi process contract is underspecified.** The plan describes arguments and JSONL mapping in detail, but not `cwd`, `stdin`, or process teardown. Fixture tests drive `mapPiRecord`/a spawn stub and cannot catch any of the three; only the opt-in live smoke would.
2. **Phase gates are not independently shippable.** Phase 2's declared API depends on `DoctorCheck`, added in Phase 5; `PiExec` is never defined; the fake/real split changes existing composition semantics; and the lockfile step names a command that does not run in this environment. Each phase claims green `tsc`/Vitest.
3. **Fake and real paths diverge.** The fake runner becomes a singleton, the scenario guard cannot serve both modes, and role text is read from `HEAD` while worktrees are created at the base commit.
4. **Failure and verification paths are under-tested.** Raw-log capture on throw, worktree cleanup for non-approved runs, `remove()` with a missing directory, doctor rejection handling, and the real `createAdapterSet` branch all lack coverage. The live test as sketched cannot settle the OAuth-race question it exists for.
5. **Documentation contradicts the chosen design.** The roadmap still mandates `--skill` and says worktrees are removed when the run ends; Phase 6 updates neither.

## Findings

### Critical

- **[Correctness] Phase 2** (`:119-120`, `:93-97`): `spawn` never receives `cwd: spec.cwd`. `AgentSpec.cwd` is the per-run worktree (`contracts/src/agent.ts:13`; set at `modules/factory/src/roles.ts:69` from `commands.ts:208`), and Pi resolves project config, resource discovery, and relative reads from the process cwd (`pi docs/cli.md:39`). Every real step would inspect the server's checkout; in write mode `edit`/`write`/`bash` could modify the server repo, and the Phase 6 canary assertion would pass vacuously. Fix: specify `spawn(bin, args, { cwd: spec.cwd, ... })` and assert the spawn options in the argument test.

- **[Correctness] Phase 2** (`:120`, `:132`): Pi blocks on piped stdin. `readPipedStdin()` waits for stdin `end` for every mode except RPC (`~/.pi/.../dist/main.js:52-66,726-734`), and Node `spawn` defaults stdin to a pipe the parent never closes. `pi --mode json` would never start its prompt; every attempt would run to the kernel deadline and escalate. Fix: specify `stdio: ["ignore", "pipe", "pipe"]` (plus merged `process.env`) and test the spawn options. The fixture/stub tests cannot catch this.

- **[Plan Mechanics] Phase 2 (and 3–4)** (`:106-116`, `:350-361`): Phase 2 does not compile as declared. `checkPi` returns `DoctorCheck`, which Phase 5 adds; `PiExec` is referenced at `:115` but never defined; `createPiRunner` omits the required `readonly id: string` (`kernel/src/agent.ts:5`); and Phase 5 declares `export const DoctorCheck = z.object(...)` without the `export type DoctorCheck = z.infer<typeof DoctorCheck>` that every signature uses as a type. `checkPi` also has no argv/output contract — the tests assume `{"status":"ready"}` but the plan never specifies `pi auth check --provider … --json`, a timeout, or a malformed-output case. Fix: move the `DoctorCheck`/`DoctorReport` schemas and type aliases into Phase 1, define `PiExec`, specify `id: "pi"`, and spell out the argv/parse contract.

### Major

- **[Correctness] Phase 1** (`:66`, `:82`): Raw-log capture cannot satisfy “before `attempt.finished`” on the throw path. `streamAttempt` writes `attempt.finished` in its own catch and rethrows (`kernel/src/agent-step.ts:236-250`), so capture placed in `executeAttempt` after the `await` runs after it — or not at all. A failing runner, schema-invalid event, or store write is exactly when the raw log matters. Fix: move the failure `attempt.finished` write up to `executeAttempt`, capture in `catch`/`finally`, then write it; add a failing-runner ordering test.

- **[Correctness] Phase 1** (`:66-67`, `:119`): The kernel reads and deletes the temp log while the adapter may still own it. The kernel does not await `iterator.return()` (`agent-step.ts:229-232`), so closing/flushing the raw file in the generator's `finally` races the kernel's read and `rm(dir)`; the stored artifact can be empty or truncated. Fix: define a “raw log closed” contract (await generator cleanup, or close before yielding the terminal event) before capture and removal; test with a delayed close.

- **[Correctness] Phase 2** (`:126`, `:130`): A `stopReason: "error"` message is mapped to a terminal `error`, but `agent_end` is not the end and Pi may still auto-retry until `agent_settled` (`pi docs/json.md:44-48,161-170`). The kernel treats the first `error` as terminal (`agent-step.ts:213-218`), so a transient provider error that Pi would retry aborts the attempt. Fix: end only on `agent_settled` (or a final `auto_retry_end` failure); treat per-message errors as informational.

- **[Correctness] Phase 2** (`:122`, `:126`, `:132`): No process cleanup when the kernel stops consuming after a terminal error/result, a malformed line, or a deadline. The adapter only kills on `signal` abort, and the kernel's un-awaited `iterator.return()` can leave the `pi` child alive writing into a pipe with no reader (which the Pi docs warn stalls it). Fix: kill SIGTERM→SIGKILL and close/destroy stdout in the generator's `finally` on every exit path; test early-stop cleanup.

- **[Correctness] Phase 2** (`:107-110`, `:137`): `mapPiRecord(record, state)` cannot implement the “parent signal not aborted” checks (`:126`, `:130`) because it receives no signal, and the malformed-JSONL test (`:137`) cannot exercise malformed framing because that is detected in the stream loop, not in a function that receives an already-parsed `unknown`. Fix: pass the run signal (or put it in state), name it the run signal (the kernel passes the combined parent+deadline signal), and test malformed framing through `run()` with the spawn stub.

- **[Correctness] Phase 5** (`:319`, `:332`): Role sources are read from `HEAD:<path>`, while worktrees are created at the resolved base commit (`:250`). `config.repo` is an arbitrary checkout and `baseBranch` defaults to `main` (`config.ts:93`); the HTTP API accepts any base (`http.ts:89-96`). Agents would read skill text from a different commit than the tree they inspect, defeating the recorded-SHA provenance rationale. Fix: resolve role blobs against the same base commit used for the run, or require/validate `HEAD == base`.

- **[Correctness] Phase 5** (`:288-290`, `:332`, `:348`): `PAYO_PI_PROVIDER` only feeds the doctor. `createPiRunner` never receives a provider and the argument list has no `--provider` (`:120`), so with `model: null` the runner uses Pi's configured default provider while doctor checks `anthropic`; doctor can be green while every run fails auth. Fix: pass provider/model to the runner and use `--model <provider/model>`, or check the same default the runner will use. Fail startup when no model is pinned if that is the requirement.

- **[Correctness] Phase 5** (`:313-319`, `:343-348`): `checkRoleSources` has no defined failure return, and `runDoctor` uses `Promise.all`. If it rejects (missing `skills/` at HEAD, spawn failure), the doctor rejects, `main` has no catch around it, and neither the expected failure line nor the HTTP report is produced. The plan only tests `loadRoleSources` success, not `checkRoleSources` failure. Fix: make `checkRoleSources` catch and return `{ ok: false, detail }`, make every probe and `runDoctor` total, and test the failure path.

- **[Correctness] Phase 4** (`:253-256`): `remove()` returns early when the path is missing, but the registration can remain; `create()` only reuses a path that exists and otherwise fails because git refuses to add a registered-but-missing path. If deriving `--git-common-dir` fails (path gone), the fallback has no repo to prune. A failed `remove` permanently blocks `approve` (`factory-flow.test.ts:54-63`). Fix: persist the repo per run (or parse the registration), prune stale registrations, and test “directory deleted → remove → create”.

- **[Correctness] Phase 4/5** (`:269-276`, `:334`): Real worktrees are only removed on `approve` (`modules/factory/src/commands.ts:698`). Escalated, cancelled, interrupted, or abandoned runs keep a worktree forever in `~/.payo/worktrees/<runId>`. The roadmap says “removed when the run ends” (`docs/payo/implementation-roadmap.md:103`). Fix: define the lifecycle — retain while resumable, prune on `run.ended`/abandon, and sweep ended runs at startup — or put the leak explicitly in Out of Scope.

- **[Test Coverage] Phase 4** (`:273`): The automated criterion “`git worktree list --porcelain` for the temp repo is empty after each removal test” can never pass. The listing always includes the main worktree (verified on this repo). Fix: assert only that the linked worktree path is absent / that only the main worktree remains.

- **[Test Coverage] Phase 6** (`:393-404`, `:419-421`): The live test is a comment sketch, not a step. It omits `sessionRoot`, `correlation` (the runner throws without it, `:119`), `rawLogPath`, the worktree `root`, and `spec.cwd`; `timeout 120000` is ineffective because the kernel enforces `spec.timeoutMs`, and this test drives the runner directly under Vitest's default 5 s timeout. Fix: spell out the full spec/options, pass an `AbortSignal.timeout`, and set a Vitest timeout.

- **[Test Coverage] Phase 6** (`:408`, `:419-421`, `:439`): The OAuth-race question cannot be settled by the planned test. It runs two Pi calls sequentially, directly against the runner, bypassing composition and the limiter; `PAYO_MAX_CONCURRENT_AGENTS=2` has no effect. Fix: run the calls concurrently in-process (or through `createComposition`) and record whether refresh races.

- **[Test Coverage] Phase 5** (`:329-333`): The real `createAdapterSet` branch is never tested. Composition tests inject `AdapterSet`, `main.test` exits at doctor, and the live test builds adapters directly, so session roots, worktree roots, role sources, and model/env propagation can be wired wrong without a failure. Fix: add a unit test with the real factories stubbed (or an injected factory seam) asserting the real wiring under `dataDir`.

- **[Architecture] Phase 5** (`:323-333`): Moving the fake runner into one `AdapterSet.runner` breaks fake scenarios and recovery. Today `createFakeRunner(scriptsFor(scenario))` is created per `depsForRun()` (`composition.ts:186-194`), and `runner-fake` selects scripts by per-instance call count (`adapters/runner-fake/src/index.ts:18-25`). A second run on the same server consumes the next script index and throws `no script for session N`. Fix: make `AdapterSet.runner` a factory (`runner: () => AgentRunner`) or keep the fake runner per run.

- **[Correctness] Phase 5** (`:292`, `:331-333`, `:372`): The scenario guard cannot satisfy both modes as written. `scenarioOf` throws for every `devFakes: false` config (`composition.ts:142-147`), including `scenario: null`; calling it unconditionally bricks real mode, while moving it only into the fake branch makes `composition.test.ts:165-180` (`devFakes:false, scenario:"clean"`) stop throwing. `loadConfig` cannot help because the test builds a literal. Fix: guard `config.scenario !== null && !config.devFakes` at the composition boundary and select adapters by `devFakes` only.

- **[Correctness] Phase 5** (`:30`, `:369`, `:384`, `:406`): `payo doctor` is unreachable in the case it exists to diagnose. Real mode exits before binding when the doctor fails, so the CLI's HTTP call gets a connection error; only `--dev-fakes` serves a report, and the README example does not say so. Startup does print failures to stderr, but the “one report shared by startup and CLI” rationale does not hold. Fix: add an in-process/local doctor path for the CLI, or bind and serve doctor while refusing runs, or document fake mode as the diagnosis route.

- **[Correctness] Phase 3** (`:188`): Treating any non-empty stderr as failure is brittle. CLIs commonly log progress/warnings to stderr on success; if `acli` does, every ticket fetch fails and the run gates in `FetchTicket`. `acli` is not installed here, so this is unverified. Fix: gate on exit code and include stderr only in the error message.

- **[Plan Mechanics] Phase 5** (`:371`): The lockfile command is not executable as written. The plan calls `pnpm install --lockfile-only` “or the working `rtk proxy pnpm …`”, but this shell's `pnpm` shim is unset (`mise: No version is set for shim: pnpm`) and the `rtk` form fails the same way; CI uses `pnpm install --frozen-lockfile` (`.github/workflows/ci.yml:64`). Fix: give a command that works here (`npx pnpm@10.9.0 -C payo install --lockfile-only` or a corepack/mise pin).

- **[Plan Mechanics] Phases 2–4** (`:91-145`, `:165-200`, `:219-265`): Each adapter is a single 50+ line change bullet covering options, spawning, parsing, mapping, usage, abort/kill, tee, check, fixtures, and ~11 tests. That is far beyond the 2–15 minute action granularity the plan claims elsewhere. Fix: split each by seam (args/session dir, stream/tee, mapping/usage, error/abort, check, fixtures) so progress and failures are attributable.

- **[Plan Mechanics] Phase 6** (`:407-408`): The documentation update leaves contradictions in place. `docs/payo/implementation-roadmap.md:101` still says the adapter uses `--skill` (the plan deliberately does not) and `:103` says worktrees are removed when the run ends; `docs/payo/engine-design.md:96` still shows `get(key: string)`. Phase 6's own criterion “documentation links and command examples match the implemented flags” (`:416`) would fail. Fix: update those lines and state the detached-base decision in the roadmap.

### Minor

- **[Plan Mechanics] Phase 1** (`:51`, `:54`): “Blank `rawLogPath` is rejected” does not follow from `z.string().min(1)`; whitespace passes, and `Id` is only `min(1)` (`primitives.ts:49`). Use `.trim().min(1)` / a non-blank refine, or word the test as “empty”.
- **[API/Compatibility] Phase 1** (`:53`): Only `AgentEvent.started.model` gets a 256 cap, while `AgentSpec.model` and `attempt.started.model` stay uncapped (`run.ts:48`). A >256 model is a valid spec; the adapter truncates the event but the attempt record keeps the full value, and any runner echoing it untruncated makes `AgentEvent.parse` throw. Define one `ModelId` and use it everywhere.
- **[Correctness] Phase 2** (`:125-130`): Only `message`, `started.model`, and tool `name` are truncated. `result` text, `error.message`, `tool_result.name`, and `callId` are not; the Phase 1 caps then make the kernel throw. Apply one clamp helper per cap and test each.
- **[Correctness] Phase 2** (`:122`, `:141`): Cross-chunk line buffering is unstated and untested. State that a partial trailing line is carried across `data` events; add a fixture split mid-line.
- **[Plan Mechanics] Phase 2** (`:134-144`): The tests use a spawn stub but never assert `cwd`, `stdio`, env merging, or the child's `kill` on early stop — the three things the fixture tests cannot otherwise cover.
- **[Plan Mechanics] Phase 5** (`:370`): The real-mode `main.test.ts` omits `PAYO_DATA_DIR`, `NODE_ENV=test`, and `PAYO_TEST_PORT=0`; if the doctor unexpectedly passes, `ensureServerToken` writes to `~/.payo` (`main.ts:24`) and the real port binds. The asserted “doctor failure line” is also unspecified, and a `checkRoleSources` rejection would print only `payo serve: …`. Set temp values and pin the per-check line format.
- **[Test Coverage] Phase 5** (`:320`): The `role-sources.test.ts` temp repo sets no `user.name`/`user.email` and no `commit.gpgsign=false`; a clean CI or a global `commit.gpgsign=true` fails the commit. Use `git -c …` or explicit env, as Phase 4 already says for its repo.
- **[Test Coverage] Phase 4** (`:36`, `:258`): The design decision says “fixture tests inject `spawn`/`exec`; only live tests spawn real binaries”, but Phase 4 mandates real `git init`/commit and the Phase 5 main test runs real `git`; the criteria only forbid real `pi`/`acli`. Either add a tmp-`PATH` git fake or amend the decision/criteria to permit offline git.
- **[Test Coverage] Phase 2** (`:121`, `:134-144`): The correlation env vars (`PAYO_RUN_ID`, `PAYO_STEP_ID`, `PAYO_ATTEMPT_ID`) are specified but never asserted; a silent rename passes. Add one captured-env assertion.
- **[Plan Mechanics] Phase 5** (`:363`): The doctor route must match exactly `segments.length === 3`; the current dispatcher only checks `segments[2] !== "runs"` (`http.ts:77`), so `/api/v1/doctor/anything` would be accepted.
- **[Architecture] Phase 5** (`:321`): “`adapters.ts` is the only server module that imports adapter values” is false: `doctor.ts` imports `checkPi`/`checkAcli`/`checkGit`, and `composition.ts`/`factory-fixtures.ts` already import `@payo/store-sqlite` and `@payo/runner-fake`. Either drop the claim or state the real invariant and enforce it in Biome.
- **[Architecture] Phase 5** (`:319`, `:332`): `role-sources.ts` may import only the `GitExec` type, so it must implement its own git spawning/timeout/argv path — a second invocation path not covered by the git adapter tests. Export a `createGitExec`/`gitExec` value from `@payo/git` and pass it in.
- **[Security] Phase 3/5** (`:191`, `:350-356`): `DoctorCheck.detail` is unbounded and copies raw stdout/stderr; the route and CLI print it. Cap it, emit exit code plus a short excerpt, redact token-shaped strings, and never pass `--credentials`.
- **[Security] Phase 2/3/4**: The plan never mandates shell-free execution. `repo`/`baseBranch`/`ticketKey` are HTTP-controlled and `bin` comes from env; state that all adapters use `spawn`/`execFile` with argv and `shell:false`.
- **[Security] Phase 2** (`:123`): Raw logs contain prompts and tool output; the parent dir is `0700` but the file mode is unspecified. Create it `0600`.
- **[Security] Phase 4** (`:248`, `:255`): Path containment is underspecified. Compare `resolve(root) + sep`, resolve symlinks for existing paths, and verify the path is a registered worktree before the `rm` fallback.
- **[Plan Mechanics] Phase 5** (`:371`): Baseline is 332 tests, not 329; the “all 329 existing tests” regression claim is stale. Prefer “the existing suite” to a count.
- **[Test Coverage] Phase 4** (`:263`): The remove tests do not cover a dangling registration or a broken `rev-parse`, and “leaves an unregistered path outside `root` untouched” does not say whether the call throws or no-ops (`:255` says reject). Specify both.

### Suggestions

- **[Architecture] Phase 1/3**: The `TicketSource.get(key, context?)` widening exists only to add `run <id>` to an error string the factory already knows. Prefix the gate reason in `FetchTicket` instead and leave the port unchanged.
- **[API/Compatibility] Phase 3**: Move the Jira key regex into `contracts` (`TicketKey` already exists but is unused) and validate in `StartRunRequest`/CLI, so a bad key returns 400 instead of creating a run that immediately gates.
- **[Plan Mechanics] Phase 5**: Give every doctor probe a timeout; `pi auth check` refreshes OAuth by default and can hang startup, which runs before binding. (Doctor totality is covered above.)
- **[Plan Mechanics] Phase 5**: State the Pin: the fake branch should be selected by `devFakes`, and scenario validation should happen at both `loadConfig` and composition/config construction.

## Strengths

- The Pi 1.4.0 facts are accurate: all documented flags exist, `--mode json` is one-shot, `agent_settled` semantics and `message_end` authority are right, and the usage fields match.
- The adapter seam is clean: injected `spawn`/`exec`, fixtures instead of live binaries, and an opt-in smoke test keep `pnpm check` deterministic.
- Contract additions are optional and backward compatible; the worktree design (detached base, idempotent create, containment checks, refuse-unregistered) is careful.
- Doctor probes are injectable and the report shape is shared between startup and CLI.
- The plan documents its deviations and risks instead of hiding them.

## Recommended Changes

1. **Phase 2 spawn contract.** Add `cwd: spec.cwd` and `stdio: ["ignore","pipe","pipe"]` (merged env), then assert both in the spawn-options test. This is the difference between a working adapter and one that inspects the wrong tree or hangs.
2. **Move `DoctorCheck`/`DoctorReport` (schemas, type aliases, index export) into Phase 1; define `PiExec`; add `id: "pi"`.** Re-run each phase's `tsc` gate.
3. **Phase 1 raw capture.** Move the failure `attempt.finished` write to `executeAttempt`, capture in `catch`/`finally`, and await adapter cleanup before reading/removing the temp dir. Add success, failure, and delayed-close tests.
4. **Phase 2 mapping.** Pass the run signal to the mapper; end only on `agent_settled`; kill the child and close stdout on every exit path; clamp every emitted string to its contract cap; test malformed framing and mid-line chunk splits through `run()`.
5. **Phase 4 lifecycle.** Fix the worktree-list criterion, prune dangling registrations in `remove`/`create`, and define cleanup for non-approved runs.
6. **Phase 5 wiring.** Add cwd/provider/model to the runner, make `AdapterSet.runner` a factory (or per-run fake), fix the scenario guard, resolve role blobs at the base commit, make every doctor probe total (`checkRoleSources` included), and decide how `payo doctor` is reachable when startup fails.
7. **Phase 6 verification.** Specify the live test's `correlation`/`sessionRoot`/`rawLogPath`/`cwd` and Vitest timeout, run the two Pi calls concurrently so the OAuth-race criterion is meaningful, and add a test for the real `createAdapterSet` wiring.
8. **Plan mechanics.** Replace the unusable lockfile command with one that works here, split the three adapter phases into seam-sized steps, and gate `acli` on exit code only; update the roadmap `--skill` and worktree-lifecycle lines.
