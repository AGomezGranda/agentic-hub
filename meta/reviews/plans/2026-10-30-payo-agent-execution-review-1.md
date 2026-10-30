## Plan Review: Payo step 3, agent execution
**Verdict:** REVISE

Two confirmed P1s. First, the attempt outcome is read from signal state after the stream loop, so a valid result can be recorded as `timed_out` or `cancelled`. Second, a crash between attempts leaves the step `running` with no gate, and recovery ignores it, while the plan says step 3 adds nothing to crash recovery. The layering and dependency rules hold, and most file and API claims check out. The remaining findings are P2 fixes to the spec and tests, most of them one or two lines.

### Coverage
- **Checked:** Architecture, Simplicity, Correctness, Test Coverage, Code Quality, Compatibility, Security/Safety. Three reviewers each read the full plan. I re-verified the P1s and the disputed anchors against `payo/packages/kernel/src/run.ts`, `state.ts`, `payo/package.json`, `payo/adapters/runner-fake/package.json`, and `payo/adapters/store-sqlite/src/index.ts`.
- **Not applicable:** Performance, Usability, Standards, Documentation, Portability. This is an internal step with no UI, deploy or API-surface change.
- **Unverified:** `pnpm check` and the test suite were not run. Zod 4 and Node 24 APIs were not executed. The `store-sqlite` `append` batch atomicity was not read. Pi's JSON stream (step 6) was not checked. The pnpm hoisting config was checked only by absence (no `.npmrc`).

### Cross-Cutting Themes
- **Escalation and retry state** (Correctness, Security): the crash window, the cancel gate, and the stored-artifact asymmetry all come from the same retry and escalation design.
- **Tests that cannot fail** (Test Coverage, Correctness): the concurrency bound, the usage default, and the race cases are not exercised by the listed scenarios.
- **Tradeoff, both sides shown:** Simplicity wants `cwd`, the `"write"` tool mode and `renderInstructions` cut from step 3. Architecture and the roadmap want them kept, since step 6 and the roadmap name them. I recommend keeping them and documenting that `tools` is advisory until step 6.

### Findings

#### Critical
- 🔴 **Correctness**: Outcome is classified from signal state after the loop, so a valid result can be discarded. **Location**: Phase 4, `executeAttempt`, "Pick the outcome, in this order". **Summary**: The plan checks `input.signal.aborted`, then `deadline.aborted`, after the loop. The `attempt.event` write waits behind the RunLog chain, so the 10 s deadline can fire while a valid `result` is still being written. The attempt is then recorded `timed_out` or `cancelled`, and the step fails with the output thrown away. Scenarios 6–8 never produce a result, so they cannot catch this. **Fix**: record the terminal reason inside the loop (`result`, `error`, `aborted`, `deadline`, `ended`) and classify only from that. State precedence: a `result` or `error` received first wins. Add scenarios: (a) `result` emitted, deadline forced during the event write, expect `succeeded`; (b) parent abort after `result` and before `attempt.finished`, expect the result to win.

- 🔴 **Correctness** (also Security/Safety): A crash between attempts strands the step, and the plan says recovery is unchanged. **Location**: Design Decisions, "Records durable on crash" and "Retry and escalation"; Phase 4 flow steps 2–3. **Summary**: Between attempt 1's `attempt.finished` and attempt 2's `attempt.started`, and during the escalation batch, the step is `running` with no running attempt and no gate. `recover()` (`payo/packages/kernel/src/run.ts:81`) only handles running attempts, so it returns `[]`. `run.ended` refuses a running step (`state.ts`, `run.ended` case). No command can resolve it, because no gate exists. The plan's "Step 3 adds nothing new to that path" is false, since the retry window is new. **Fix**: make recovery also gate a running step that has no running attempt (for example `kind: "interrupted-step"`, `allowedCommands: ["retry", "abandon"]`). State whether the escalation gate and `step.finished` are one atomic append, after reading `store-sqlite` `append`. Add a recovery test for the window.

#### Major
- 🟡 **Correctness**: A throw inside `runAgentStep` after `step.started` leaves the step `running`. **Location**: Phase 4, `executeAttempt` wrap bullet; scenario 9. **Summary**: The attempt has a catch-and-rethrow, but `runAgentStep` does not. A validator bug or a `RunEventBody.parse` rejection leaves the step `running`, and `run.ended` refuses. The text "no attempt is ever left running by a bug" also overstates it, since a failed finish write leaves the attempt running until restart recovery. **Fix**: catch in `runAgentStep` after `step.started`, make a best-effort `step.finished{failed}`, then rethrow. Scenario 9 asserts the step status. Reword the guarantee.

- 🟡 **Architecture**: Cancellation raises a blocking escalation gate. **Location**: Design Decisions, "Retry and escalation"; Phase 4 flow step 3. **Summary**: Both failure paths raise `escalation:<stepId>`, which includes cancel. Cancel is an operator action, not a fault. The gate blocks `run.ended`, and `abandon` has no handler until steps 4–5. **Fix (recommended)**: cancelled writes `step.finished{failed}` with no gate. Timeout and runner error keep the gate. Scenario 8 asserts no gate. *Value decision for you; see questions below.*

- 🟡 **Test Coverage**: The concurrency-bound scenario can pass with sequential runs. **Location**: Phase 4, scenario 10. **Summary**: "Five steps… maximum observed is 2" does not say they start together. Sequential runs give a maximum of 1 and still pass. **Fix**: launch the five through `fanOut` or `Promise.all`, and assert `maxInFlight` `toBe(2)`.

- 🟡 **Correctness**: A queued attempt that is cancelled still starts the runner. **Location**: Phase 4, `executeAttempt`, limiter and `attempt.started` bullets. **Summary**: The permit is taken before any abort check, so a cancelled queued attempt writes `attempt.started` and calls the runner with an aborted signal. **Fix**: check `input.signal.aborted` after acquiring the permit and before `attempt.started`. Record `cancelled` and skip the runner. Test: limiter of 1, abort the queued attempt, expect `calls` empty.

- 🟡 **Correctness**: `fanOut` can throw synchronously and skip its siblings. **Location**: Phase 2, `fanOut<T>(tasks)`. **Summary**: `tasks.map(t => t())` throws before `allSettled` runs if a task throws synchronously. This is a one-token fix. Confidence medium, since the plan gives no implementation. **Fix**: wrap each task as `async () => task()`, and add a sync-throw row to the fan-out test.

- 🟡 **Correctness**: One abort listener is added per `next()`. **Location**: Phase 4, "race each `next()`". **Summary**: Each event adds an `abort` listener to `combined` that is not removed when the event wins. Long streams accumulate listeners. **Fix**: create one abort promise per attempt before the loop, and remove its listener in `finally`. Hygiene, not a correctness failure.

- 🟡 **Test Coverage**: No test for the usage default or for partial usage on a timeout. **Location**: Phase 4, scenario 1; "Usage" design bullet. **Summary**: Scenario 1 covers reported usage on success only. A regression that writes `0`, or drops the last usage event, would pass. **Fix**: add (a) no `usage` event, expect all `"unknown"`; (b) two `usage` events then a timeout, expect the second values recorded.

- 🟡 **Architecture**: The core use case is tested only from the adapter package. **Location**: Phase 4, "Tests" and success criteria. **Summary**: All ten `runAgentStep` scenarios live in `payo/adapters/runner-fake/src/agent-step.test.ts`. `pnpm vitest run packages/kernel` never runs `agent-step.ts`, so the core's behaviour depends on an adapter. **Fix**: move the scenarios to `payo/packages/kernel/src/agent-step.test.ts`, with an inline scripted runner, the same pattern the plan uses for modules. Keep one or two `runner-fake` wiring tests.

- 🟡 **Code Quality**: The Phase 4 test imports `zod`, which no package declares. **Location**: Phase 3, `package.json` "unchanged"; Phase 4 test using `jsonEnvelope(z.object(...))`. **Summary**: `payo/adapters/runner-fake/package.json` and the root `payo/package.json` do not declare `zod`, and there is no `.npmrc`. Under pnpm's strict layout, the import fails the Phase 4 gate. **Fix**: add `zod` as a `runner-fake` devDependency and change the "unchanged" line, or export a schema from `@payo/contracts` for the test.

- 🟡 **Architecture**: The "contracts holds data schemas only" rule is contradicted by Phase 1. **Location**: Design Decisions, "Data lives in contracts" and "Ports are defined by the core"; Phase 1 `jsonEnvelope`. **Summary**: `jsonEnvelope` is a runtime parser, and `OutputValidator` is a function type. Both go in contracts. Step 4 and step 6 authors will read the rule and guess wrong. **Fix**: reword to "schemas and pure parsing helpers", or move `OutputValidator` and `jsonEnvelope` to kernel.

- 🟡 **Security/Safety**: Agent text is persisted with no size cap, and the plan does not say it is unredacted. **Location**: Design Decisions, "Agent events are persisted"; Risks, "Unbounded log growth". **Summary**: `message.text`, `result.text` and `error.message` come from model output, which is a trust boundary, and go into a replayable log without a bound. A shortcut is acceptable, but the cap is one schema line, and the plan should say that persisted text may include secrets the model echoes. **Fix**: add `.max(N)` to the three fields now, with `N` chosen by you, and add a sentence on redaction (none).

- 🟡 **Security/Safety**: `tools` is unenforced and `cwd` is unchecked, and the log records neither. **Location**: Phase 1, `AgentSpec`; Phase 3, "What we're NOT doing". **Summary**: Nothing enforces `tools` until step 6. `attempt.started` records neither `cwd` nor `tools`, so the log cannot show what an attempt was allowed. **Fix**: state in Design Decisions that `tools` is advisory until step 6, and that `cwd` must be absolute with no `..` when step 6 reads it.

- 🟡 **Security/Safety**: The second rejected output is never stored as an artifact. **Location**: Phase 4, flow step 2 (stores artifacts only when `n === 0`). **Summary**: The escalation gate's `reason` is the error text. The rejected output exists only in a `result` event, so a later retry or review cannot reference it. **Fix**: store it as `agent-output` and reference it from the gate's `reason` or an artifact link.

#### Minor
- 🔵 **Code Quality**: Anchors in Current State point at the wrong lines. `run.ts:80` is the `attempt.started` header; `inputArtifacts` is at `run.ts:87`. `state.ts:123` is the `attempt.finished` case; the attempt-needs-running-step check is at `state.ts:108-110`.
- 🔵 **Compatibility**: `AttemptRecord.inputArtifacts` stays `z.array(Id)` at `run.ts:135`, while the event is `Sha256`. Tighten both, or state why not.
- 🔵 **Compatibility**: `store-sqlite` parses every row with `RunEventBody.parse` (`adapters/store-sqlite/src/index.ts:130`). A local DB written by uncommitted step 2 with non-hash `inputArtifacts` would fail to open. Add a Deviations note.
- 🔵 **Standards**: "Tool events carry name and result only", but the schema has `ok`, not a result. Also bound `name` length.
- 🔵 **Documentation**: "Available on Node 24, the pinned minimum. Verified by the Phase 4 tests." `engines.node` is `>=24`, a floor, and no test asserts the APIs directly. Say "exercised indirectly by scenarios 6–8".
- 🔵 **Simplicity**: Phase 4 hand-builds `gate.raised`, but `decideGateRaise` (`payo/packages/kernel/src/run.ts:47`) already builds it. Use it.

### Strengths
- ✅ Ports live in kernel, and dependency direction is enforced by `payo/biome.json` and `payo/test/boundaries.test.ts` (line 82 blocks `modules/*` from `@payo/runner-fake`, as claimed).
- ✅ Usage is cumulative, last-wins, and `"unknown"` is never defaulted to `0`.
- ✅ A throwing fan-out child is reported `unchecked`, never clean. The RunLog concurrency test would fail without serialisation.
- ✅ Each phase ends with a `pnpm check` gate and an explicit "not doing" list.
- ✅ Source claims check out: `runner-fake` is `export {};`, `inputArtifacts` is `z.array(Id)`, the reducer rules match, and Zod 4.6.7 is pinned.

### Rejected Candidates
- **Move `renderInstructions` to step 4 (Simplicity).** Rejected. The roadmap names role spec rendering for step 3, and the function is one line.
- **Drop `cwd` and the `"write"` mode now (Simplicity).** Rejected. Step 6 reads both. The advisory note in the Security finding covers the risk.
- **Drop the new boundary row (Simplicity).** Rejected. It is cheap, and it names the rule.
- **Narrow the primitives move (Simplicity).** Rejected. The move is mechanical, and the existing tests pin it.
- **Generic `OutputValidator<T>` (Security).** Rejected as preference. `unknown` at the boundary is acceptable until step 4 consumes it.
- **Record input names and `cwd`/`tools` on `attempt.started` (Security).** Rejected as optional. Input hashes identify the inputs, and the `attemptIds[1]` pairing shows a retry.
- **Make `Id` private to `primitives.ts` (Code Quality).** Rejected. Low confidence, and no concrete clash was shown.
- **`RunLog` duplicates `commit` (Simplicity).** Rejected. Phase 2 already calls `commit` inside `openRunLog`.

### Recommended Changes
1. Record the terminal reason inside the stream loop and classify from it. Add the result-then-deadline and result-then-abort scenarios. (addresses: outcome race; race tests)
2. Make recovery gate a running step with no running attempt. State whether the escalation batch is atomic, after reading `store-sqlite` `append`. Add a recovery test. (addresses: crash window)
3. Decide that cancel raises no gate. Assert it in scenario 8. (addresses: cancel gate) *Needs your decision.*
4. Catch in `runAgentStep` after `step.started`, make a best-effort `step.finished{failed}`, and reword the "never left running" guarantee. Scenario 9 asserts step status. (addresses: stranded step)
5. Move the scenario suite to `payo/packages/kernel/src/agent-step.test.ts` with an inline runner. Keep one or two `runner-fake` tests. (addresses: test placement)
6. Launch scenario 10 concurrently and assert `maxInFlight === 2`. (addresses: vacuous concurrency test)
7. Check abort after acquiring the permit and before `attempt.started`. Wrap `fanOut` tasks as async. Use one abort promise per attempt. (addresses: queued cancel, sync throw, listener growth)
8. Add the usage default and partial-usage scenarios. (addresses: usage tests)
9. Declare `zod` for `runner-fake`, or change the test import. Update the "package.json unchanged" line. (addresses: undeclared zod)
10. Cap `message.text`, `result.text` and `error.message` with `.max(N)`. Bound tool `name`. Document that `tools` is advisory until step 6. (addresses: unbounded text, advisory tools)
11. Store the second rejected output as an artifact and reference it. (addresses: asymmetric artifacts)
12. Fix the wording and anchors: contracts rule, `run.ts:87` and `:135`, `state.ts:108-110`, step 2 DB note, Node engines wording, and `decideGateRaise` in the escalation batch. (addresses: minor)

### Questions for you
- **Cancel and the gate:** should a user or parent cancel raise a blocking escalation gate (plan as written), or finish the step as `failed` with no gate (recommended)?
- **Text cap:** what `N` for `message.text`, `result.text` and `error.message`? The plan's 1 MB upgrade trigger is one option.

Re-review after edits: re-run Correctness, Test Coverage and Security/Safety on the changed phases, plus Architecture if the test move changes the kernel boundary.
