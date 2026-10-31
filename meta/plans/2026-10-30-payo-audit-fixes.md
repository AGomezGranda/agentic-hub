# Payo audit fixes: contract guards, gate enforcement, and write batching

**Date:** 2026-10-30
**Work Item:** n/a
**Status:** Draft

## Overview
Fix the nine findings from the payo audit: reject non-finite numbers at the contract boundary, close the config prototype hole, make the reducer the single gate rule, batch agent-event writes, remove the duplicate state clone and the redundant artifact-directory fsync, and clean up the boundary test and server dependencies. Finding 2 (recovered runs cannot be followed through) is verified in the factory flow rather than changed in the kernel, because the in-flight factory slice 1 plan already owns that behavior.

## Current State

- The kernel and SQLite store are implemented and tested; the server, CLI, git, Jira, and Pi adapters are stubs. The factory slice 1 plan is mid-implementation in the working tree (`meta/plans/2026-10-30-payo-factory-slice-1.md`). Implement this plan only after that plan is complete and committed.
- Baseline verified on 2026-10-30: `cd payo && ./node_modules/.bin/tsc` exits 0, and `./node_modules/.bin/vitest run` reports 228 passing tests. `npm run check` currently stops in Biome because of formatting and export-order errors in the uncommitted factory files (`packages/contracts/src/index.ts`, `packages/kernel/src/workspace.ts`, `modules/factory/src/*`). Those are factory-work issues, not audit issues; the tree must be green before Phase 1.
- `packages/contracts/src/primitives.ts:11-20` defines `Json` with `z.number()`; `:26` defines `Usage` with `z.number().nonnegative()`. Zod accepts `Infinity` for both. `adapters/store-sqlite/src/index.ts:105-113` stores events with `JSON.stringify`, which turns a non-finite number into `null`; `:127-137` then rejects that row as corrupt on read. The memory store also turns it into `null` through its JSON round-trip at `packages/kernel/src/store.ts:68-74`.
- `packages/kernel/src/run.ts:8-13` merges config overrides and re-parses. `:36-44` has `rejectProtoKey`, which walks arrays, but it is only called from `commit` for `run.created` (`:131-133`). Arrays bypass the object-key check in `mergeObjects`.
- `packages/kernel/src/run.ts:46-78` has `decideGateRaise` and `decideGateResolve`. Only `run.test.ts:55-114` calls them. `packages/kernel/src/state.ts:140-169` already enforces gate existence and allowed commands, but `:142` only requires the step to exist, not to be running. So `commit` accepts a gate on a finished step while `decideGateRaise` rejects it.
- `packages/kernel/src/state.ts:56-63` clones the three maps and the artifact array for every event; `:123-125` handles `attempt.event`, which changes only `lastSeq`.
- `packages/kernel/src/agent-step.ts:196-213` writes one `attempt.event` row per streamed event and awaits each write. `packages/kernel/src/run-log.ts:20-29` serializes those writes per run, and `adapters/store-sqlite/src/index.ts:91-113` opens a transaction and commits per call. The existing `shortcut:` at `agent-step.ts:195` covers an unbounded row count; this plan reduces the commit count, it does not add a row cap.
- `adapters/store-sqlite/src/index.ts:140-173` fsyncs the artifacts directory at `:166-171` even when `existsSync(final)` was true and no file was written.
- `test/boundaries.test.ts:29-52` creates a temp dir and starts Biome once per case; `:54-161` has 33 cases, so `pnpm check` starts 33 Biome processes.
- `apps/server/package.json:6-16` declares seven workspace packages. `apps/server/src/main.ts:1-2` imports only kernel and contracts. `apps/server/src/factory-fixtures.ts:1-3` imports contracts, kernel, and runner-fake. The factory plan's Phase 2 adds `apps/server/src/factory-flow.test.ts` and its Phase 3 uses the real SQLite store, so `@payo/factory` and `@payo/store-sqlite` are expected to be used after that plan lands. `@payo/cli`, `@payo/runner-pi`, `@payo/jira-acli`, and `@payo/git` are expected to remain unused.
- The factory plan owns finding 2: its Phase 2 says resume resolves owned retry/abandon gates, finishes remaining interrupted steps, and starts replacements (`meta/plans/2026-10-30-payo-factory-slice-1.md`, "Human edits and commands"). This plan verifies that behavior with a test instead of changing `recover()` or the retry semantics.
- Tooling: `pnpm` is not usable in this shell (the mise shim has no version), but `npm run check` and the direct binaries in `payo/node_modules/.bin` work. The repository CI and the factory plan use pnpm; the plan lists both forms where the distinction matters.
- The Biome JSON report contains `diagnostics[].location.path` (verified with a probe), which is what makes the single-run boundary test possible.

## Design Decisions

| Decision | Options Considered | Rationale |
|----------|--------------------|-----------|
| Implement after factory slice 1 | Now / after factory | The factory work touches `run.ts`, `state.ts`, `contracts/index.ts`, and the server tests. Waiting avoids merge conflicts and keeps the audit fixes independently reviewable. |
| Cover finding 2 in the factory flow | Kernel change / factory verification | The factory plan already defines resume and interrupted-step cleanup. Changing `recover()` here would duplicate and contradict it. |
| Delete the gate deciders | Keep / delete / route `commit` through them | Neither decider has a production caller, and the reducer is the only write path. One rule in one place. |
| Batch `attempt.event` writes at 32 | Batch / `synchronous=NORMAL` / defer | Batching keeps durability and removes most commit fsyncs without a configuration knob. A fixed constant is enough; no new option. |
| One Biome run for the boundary fixtures | Per-case spawn / one run | 33 process starts become one while every case keeps its own assertion. The JSON report exposes the path needed to group diagnostics. |
| Prune server deps to actual imports | Remove all unused now / prune after factory | The factory tests will legitimately use `factory`, `store-sqlite`, and `runner-fake`. A grep after the factory plan lands is the only reliable source. |
| Plan saved in `meta/plans/` | `docs/plans/` per skill / `meta/plans/` | The repository already keeps plans and plan reviews under `meta/`; the user chose the existing convention. |

## Implementation Phases

### Phase 1: Contract and config guards

Reject values that JSON cannot represent, and apply the existing prototype guard to array contents in the config merge.

**Changes:**
- `payo/packages/contracts/src/primitives.ts` — in `Json`, change the number branch at line 14 from `z.number()` to `z.number().finite()`. In `Usage` at line 26, change `z.number().nonnegative()` to `z.number().finite().nonnegative()`.
- `payo/packages/contracts/src/run.test.ts` — add `Infinity` and `-Infinity` to the `Usage` rejection table at `:10`. In the `Json and RunConfig` describe at `:99`, add a test that `Json.safeParse({ a: Infinity })` and `RunConfig.safeParse({ a: Infinity })` are both false. In the `RunEventBody` describe at `:15`, add a case that an `attempt.finished` body with `usage.tokensIn: Infinity` is rejected.
- `payo/packages/kernel/src/run.ts` — in `resolveRunConfig` at `:8-13`, replace the single return with:
  ```ts
  const merged = mergeObjects(defaults, overrides);
  rejectProtoKey(merged);
  return RunConfig.parse(merged);
  ```
  `rejectProtoKey` is declared at `:36` and is hoisted, so no import or move is needed.
- `payo/packages/kernel/src/run.test.ts` — in the `resolveRunConfig` describe at `:24-53`, add a test that a `__proto__` key inside an array throws for both an override and a default:
  ```ts
  it("throws on a __proto__ key inside an array in defaults or overrides", () => {
    const nested = [JSON.parse('{"__proto__": {"x": 1}}')];
    expect(() => resolveRunConfig({}, { list: nested })).toThrow(/__proto__/);
    expect(() => resolveRunConfig({ list: nested }, {})).toThrow(/__proto__/);
  });
  ```

**Success Criteria:**

#### Automated Verification:
- [ ] Contract tests pass: `cd payo && ./node_modules/.bin/vitest run packages/contracts/src/run.test.ts packages/kernel/src/run.test.ts`
- [ ] Types pass: `cd payo && ./node_modules/.bin/tsc`
- [ ] `Usage.safeParse(Infinity)` and `Json.safeParse({ a: Infinity })` are covered by failing-before/passing-after tests in the commands above.

#### Manual Verification:
- [ ] Confirm the test file has a non-finite case in both `Usage` and `Json`, and that the config test covers defaults and overrides.
- [ ] Confirm no adapter code (none exists yet) is responsible for sending `Infinity`; the contract is the boundary.

### Phase 2: Gate enforcement and decider cleanup

Make the reducer enforce that a gate is raised only on a running step, delete the duplicate deciders, and verify that the factory flow already handles recovered gates.

**Changes:**
- `payo/packages/kernel/src/state.ts` — in `case "gate.raised"` at `:140-169`, change `requireKnown(state.steps, event.stepId, "step");` at `:142` to `requireRunning(state.steps, event.stepId, "step");`.
- `payo/packages/kernel/src/state.test.ts` — add a test near the existing gate tests: fold `run.created`, `step.started s1`, `step.finished s1`, then `gate.raised g1 s1`, and expect it to throw `/s1 is not running/`. Keep the existing unknown-step test.
- `payo/packages/kernel/src/run.ts` — delete the `GateRaise` type at line 5, `decideGateRaise` at `:47-55`, and `decideGateResolve` at `:57-78`. `RunEventBody`, `RunState`, and `fold` remain used by `commit`, `recover`, and `openRun`.
- `payo/packages/kernel/src/run.test.ts` — remove the `decideGateRaise` and `decideGateResolve` imports at `:5-6` and the two describe blocks at `:55-114`. Keep the `resolveRunConfig` tests.
- Verify and replace factory callers after the factory plan lands:
  ```bash
  cd /Users/alvarogomez/code/python/agentic-hub
  rg -n "decideGateRaise|decideGateResolve" payo --glob '*.ts'
  ```
  If `payo/modules/factory/src/commands.ts` (the file the factory plan's Phase 2 adds) or another file calls them, replace:
  - `decideGateResolve(state, { gateId, command, note })` with a write of `[{ type: "gate.resolved", gateId, command, note }]` through the existing `RunLog`.
  - `decideGateRaise(state, gate)` with a write of `[{ type: "gate.raised", ...gate }]` through the existing `RunLog`.
  The reducer already rejects unknown, closed, unauthorized, duplicate, and non-running cases at commit. Do not keep a second copy of the checks.
- Finding 2 verification (test-only, no kernel change): after the factory plan lands, locate its recovery test:
  ```bash
  cd /Users/alvarogomez/code/python/agentic-hub
  rg -n "interrupted|resume|gate" payo/apps/server/src/factory-flow.test.ts
  ```
  The factory plan names `apps/server/src/factory-flow.test.ts`; if the file or command name differs, use the actual factory resume API from `meta/plans/2026-10-30-payo-factory-slice-1.md` Phase 2. If no test covers the full path, add one with this shape:
  1. Start a factory run with the fake ticket/workspace, run an agent step that leaves a running attempt, then close the store.
  2. Reopen the run with `openRun` and `openFactory`. Assert the attempt is `interrupted`, the `interrupted:<attemptId>` gate is open, and the step is still `running`.
  3. Call `resume(handle, { signal })`. Assert the gate is resolved, the interrupted step is finished, and a fresh step/attempt starts.
  4. Assert the run can reach its next checkpoint or `run.ended`; no open gate or running step remains.
  Use the factory fixture helpers from the factory plan, not a new harness.

**Success Criteria:**

#### Automated Verification:
- [ ] Kernel tests pass: `cd payo && ./node_modules/.bin/vitest run packages/kernel/src/state.test.ts packages/kernel/src/run.test.ts`
- [ ] Types pass: `cd payo && ./node_modules/.bin/tsc`
- [ ] No decider references remain: `cd /Users/alvarogomez/code/python/agentic-hub && ! rg -n "decideGateRaise|decideGateResolve" payo --glob '*.ts'`
- [ ] Factory recovery test passes: `cd payo && ./node_modules/.bin/vitest run apps/server/src/factory-flow.test.ts` (use the actual path created by the factory plan).

#### Manual Verification:
- [ ] A recovered interrupted run can be resumed and either advanced or ended without custom database edits.
- [ ] The reducer still accepts `gate.raised` from `closeWithGate` and from `recover`, because both raise it while the step is running.

### Phase 3: Batch attempt events

Write streamed agent events in bounded batches so a real harness does not pay one transaction and fsync per event.

**Changes:**
- `payo/packages/kernel/src/agent-step.ts` — add `type RunEventBody` to the existing `@payo/contracts` import. Add a module constant near `UNKNOWN_USAGE`:
  ```ts
  // One commit per 32 streamed rows instead of one per row.
  const ATTEMPT_EVENT_BATCH = 32;
  ```
- In `streamAttempt` at `:182-234`, add the buffer and flush before the `try`:
  ```ts
  const pending: RunEventBody[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    await deps.log.write(batch);
  };
  ```
- Replace the per-event write at `:210` (`await deps.log.write([{ type: "attempt.event", attemptId, event }]);`) with:
  ```ts
  pending.push({ type: "attempt.event", attemptId, event });
  if (watch.terminal !== undefined || pending.length >= ATTEMPT_EVENT_BATCH)
    await flush();
  ```
  Keep the `setImmediate` yield at `:212`; the deadline test depends on it.
- After the inner `if (watch.terminal === undefined) { ... }` block and before `return classify(...)` at `:219`, add `await flush();`. This writes events buffered when the runner ended or aborted without a terminal event.
- In the `catch` block at `:220-233`, add `await flush().catch(() => {});` before the existing `attempt.finished` write, so a runner error or schema rejection keeps the events that already arrived.
- Event order remains `attempt.started`, one or more `attempt.event` batches, `attempt.finished`; `executeAttempt` still writes `attempt.finished` after `streamAttempt` returns. The terminal event is always in the final batch, and `watch.terminal` is set before the flush, so a deadline during the write cannot overturn a received result.
- `payo/packages/kernel/src/agent-step.test.ts` — add three tests:
  1. Batching and order: wrap `createMemoryRunStore` to count `append` calls whose bodies contain `attempt.event`; run a scripted session that emits 70 `message` events then the valid result. Read the log, collect `attempt.event` message texts with `flatMap`, and assert they equal `m0`..`m69` in order; assert the counted event writes are at most 4.
  2. Timeout flush: a session emits 5 message events then hangs; with `timeoutMs: 20`, assert the log contains those 5 messages in order and the attempt status is `timed_out`.
  3. Error flush: a session emits 3 messages then throws; assert the 3 messages are stored, the attempt is `failed`, and the step is `failed`. Use the existing `setup`, `scripted`, `emits`, `specFor`, and `stateOf` helpers at `:110-122`.

**Success Criteria:**

#### Automated Verification:
- [ ] Agent-step tests pass: `cd payo && ./node_modules/.bin/vitest run packages/kernel/src/agent-step.test.ts`
- [ ] Types pass: `cd payo && ./node_modules/.bin/tsc`
- [ ] The 70-message test asserts at most 4 `attempt.event` append calls and exact message order.
- [ ] Existing tests still pass, including "keeps a valid result that arrives before the deadline" and "records the last usage reported before a timeout".

#### Manual Verification:
- [ ] Read the new assertions and confirm the terminal batch is written before `attempt.finished`.
- [ ] Confirm the batch size is a constant, not a new configuration option.

### Phase 4: State and artifact micro-fixes

Stop copying all state for `attempt.event`, and fsync the artifacts directory only when a new file was created.

**Changes:**
- `payo/packages/kernel/src/state.ts` — after the `state.status === "ended"` check at `:52-54` and before the `const next` clone at `:56`, add:
  ```ts
  if (event.type === "attempt.event") {
    requireRunning(state.attempts, event.attemptId, "attempt");
    return { ...state, lastSeq: event.seq };
  }
  ```
  Remove `case "attempt.event":` from the switch at `:123-125`. The maps are never mutated by the reducer (the existing "does not mutate the state it is given" test at `state.test.ts:384-394` covers this), so sharing them is safe. The early return stays after the ended-run check, so an event on an ended run still throws.
- `payo/packages/kernel/src/state.test.ts` — no new test is required; the existing `reduce attempt.event` block at `:346-382` covers lastSeq, unchanged maps, terminated attempts, unknown attempts, and non-mutation. Run it as the regression check.
- `payo/adapters/store-sqlite/src/index.ts` — move the directory fsync block at `:166-171`:
  ```ts
  const dirFd = openSync(artifactsDir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  ```
  inside the `if (!existsSync(final)) { ... }` block, after the inner `try/catch` that calls `renameSync`. Keep the file fsync, the `0o600` mode, and the atomic rename unchanged. A duplicate `putArtifact` now returns the ref without opening or fsyncing the directory.
- `payo/packages/kernel/src/testing.ts:193-205` already covers a duplicate `putArtifact` and read-back in the store contract; no new test is needed for a move-only change.

**Success Criteria:**

#### Automated Verification:
- [ ] Kernel and store tests pass: `cd payo && ./node_modules/.bin/vitest run packages/kernel/src/state.test.ts adapters/store-sqlite/src/index.test.ts`
- [ ] Types pass: `cd payo && ./node_modules/.bin/tsc`
- [ ] The duplicate-put case in the store contract still passes.

#### Manual Verification:
- [ ] Confirm the directory fsync is inside the `if (!existsSync(final))` block and still runs after a successful rename.
- [ ] Confirm `attempt.event` returns a state that shares the maps and only replaces `lastSeq`.

### Phase 5: Test and dependency hygiene

Run the boundary fixtures with one Biome process, and prune the server's workspace dependencies to what its source actually imports.

**Changes:**
- `payo/test/boundaries.test.ts` — extract the 33 entries from the `it.each` at `:54-161` into a module-level array:
  ```ts
  type BoundaryCase = {
    file: string;
    source: string;
    expected: string | undefined;
  };
  const cases: BoundaryCase[] = [
    // the existing 33 file/source/expected entries, unchanged
  ];
  ```
- Add a fixture path helper. Every current `file` contains `/src/`, so one replacement keeps the directory patterns intact:
  ```ts
  const fixturePath = (index: number, file: string): string =>
    file.replace("/src/", `/src/case-${index}/`);
  ```
- Replace `restrictedImportMessages` at `:29-52` with one function that writes every fixture into a single temp tree, starts Biome once, and groups diagnostics by path:
  ```ts
  function lintFixtures(cases: readonly BoundaryCase[]): Map<string, string[]> {
    const dir = mkdtempSync(join(tmpdir(), "payo-boundaries-"));
    try {
      copyFileSync(join(payoRoot, "biome.json"), join(dir, "biome.json"));
      const byPath = new Map<string, string[]>();
      cases.forEach((c, index) => {
        const path = fixturePath(index, c.file);
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), c.source);
        byPath.set(path, []);
      });
      const result = spawnSync(
        biomeBin,
        ["lint", "--reporter=json", "."],
        { cwd: dir, encoding: "utf8" },
      );
      const report = JSON.parse(
        result.stdout.slice(result.stdout.indexOf("{")),
      ) as {
        diagnostics: Array<{
          category: string;
          message: { text?: string } | string;
          location: { path: string };
        }>;
      };
      for (const d of report.diagnostics) {
        if (d.category !== "lint/style/noRestrictedImports") continue;
        byPath
          .get(d.location.path)
          ?.push(typeof d.message === "string" ? d.message : (d.message.text ?? ""));
      }
      return byPath;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  ```
- In the describe, add `let report: Map<string, string[]>;` and `beforeAll(() => { report = lintFixtures(cases); });`. Import `beforeAll` from vitest.
- Replace the `it.each` callback with a lookup:
  ```ts
  it.each(cases.map((c, index) => ({ ...c, index })))(
    "case $index: $file — $source",
    ({ file, index, expected }) => {
      const messages = report.get(fixturePath(index, file)) ?? [];
      if (expected === undefined) {
        expect(messages).toEqual([]);
      } else {
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(expected);
      }
    },
  );
  ```
  Keep the existing top comment about non-literal specifiers, the message constants, and the `payoRoot`/`biomeBin` definitions. If a future path report uses backslashes (not the case on the Ubuntu CI runner), normalize with `path.posix`; do not add that until it is needed.
- `payo/apps/server/package.json` — list actual imports after the factory plan lands:
  ```bash
  cd /Users/alvarogomez/code/python/agentic-hub
  rg -o '@payo/[a-z-]+' payo/apps/server/src --glob '*.ts' | sort -u
  ```
  Keep exactly the packages the command reports. Expected after factory slice 1: `@payo/contracts`, `@payo/kernel`, `@payo/runner-fake`, `@payo/factory`, and `@payo/store-sqlite`. Remove `@payo/cli`, `@payo/runner-pi`, `@payo/jira-acli`, and `@payo/git` unless the grep shows an import. Do not remove `factory` or `store-sqlite` if the factory flow test uses them.
- Update the lockfile importer:
  ```bash
  cd payo && pnpm install --lockfile-only
  ```
  If the working wrapper is required in this environment, use `rtk proxy pnpm -C payo install --lockfile-only`. Do not hand-edit `pnpm-lock.yaml`. Verify the diff touches only the `apps/server` importer.
- The `apps/server/src/main.test.ts` spawn test stays unchanged; it only relies on kernel and contracts.

**Success Criteria:**

#### Automated Verification:
- [ ] Boundary and server tests pass: `cd payo && ./node_modules/.bin/vitest run test/boundaries.test.ts apps/server/src/main.test.ts`
- [ ] Types pass: `cd payo && ./node_modules/.bin/tsc`
- [ ] The boundary suite still has 33 cases and passes with one Biome process.
- [ ] The lockfile diff is limited to the `apps/server` importer: `cd payo && git diff --stat pnpm-lock.yaml` and read the diff.

#### Manual Verification:
- [ ] Run the boundary test and confirm the wall time drops (one Biome start instead of 33).
- [ ] The grep output for `apps/server` exactly matches the `dependencies` set in `apps/server/package.json`.

### Phase 6: Final verification

Run the whole payo gate after all phases.

**Success Criteria:**

#### Automated Verification:
- [ ] Full check passes: `cd payo && npm run check` (this runs Biome, `tsc`, and `vitest run`; the repository's documented equivalent is `pnpm check`, or `rtk proxy pnpm -C payo check` where the wrapper is available).
- [ ] If `npm run check` stops in Biome on files this plan did not touch, stop and fix or commit the factory work separately; do not mix unrelated formatting into these phases.

#### Manual Verification:
- [ ] Re-run the audit's concrete cases: a 70-message step writes at most 4 `attempt.event` append calls; a config with an array `__proto__` throws; a `gate.raised` on a finished step throws; a duplicate `putArtifact` does not fsync the directory; the boundary suite starts Biome once.
- [ ] Confirm no `decideGateRaise`/`decideGateResolve` references remain and the factory recovery test covers the interrupted-gate path.

## Out of Scope

- Finding 2's kernel behavior: changing `recover()`, the retry/abandon semantics, or adding a kernel resume API. The factory slice 1 plan owns this; this plan only verifies it with a factory-level test.
- Capping the number of `attempt.event` rows per attempt. The existing `shortcut:` at `agent-step.ts:195` is a decision; batching changes the commit count, not the row cap.
- `PRAGMA synchronous`, WAL configuration, event-log snapshots, the double Zod parse in `commit` plus `store.append`, and the O(steps × attempts) scans in `recover`.
- Adapter-side sanitizing of non-finite usage values. No real runner adapter exists yet; the contracts now reject the values, and a future Pi adapter should map them to `"unknown"`.
- Adding an automated check that `apps/server/package.json` matches its imports. This plan only prunes the current set.
- HTTP, SSE, CLI, auth, git, Jira, and Pi implementation.
- Changes to the factory plan beyond the one recovery verification test in Phase 2.

## Risks & Mitigations

- **Factory branch conflicts** → Implement after factory slice 1 is complete and committed; start with the baseline commands; re-grep every anchor before editing. The file:line references in this plan are anchors from 2026-10-30 and may shift.
- **Deleting the deciders breaks factory code** → The Phase 2 grep finds every caller; replace each call with the event write the helper produced. The reducer keeps the same validation, so behavior is unchanged.
- **Batching loses or reorders events** → Flush on the terminal event, after the stream ends, and in the `catch`; assert order and call count for 70 messages, a timeout, and a runner error. `attempt.finished` is still written after `streamAttempt` returns.
- **`.finite()` rejects a value an adapter used to send** → This is the point: JSON cannot represent it. A future adapter maps non-finite usage to `"unknown"`; the contract test documents the rule.
- **The single Biome run hides which case failed** → Every case gets a unique fixture path and its own assertion; the report is grouped by `location.path`. If the report shape changes, fall back to one spawn per package rather than per case.
- **The dependency prune removes a package the factory tests need** → The grep after the factory plan is the source of truth; keep `factory`, `store-sqlite`, and `runner-fake` when imported; run the server tests before and after.
- **Lockfile mismatch breaks `--frozen-lockfile`** → Use `pnpm install --lockfile-only`; verify the diff is limited to `apps/server`; do not hand-edit the lockfile. If pnpm is unavailable, stop and report rather than guessing.

## Not Covered / Verify During Implementation

- The exact factory resume API and test path are defined by the factory plan. Verify `apps/server/src/factory-flow.test.ts` exists and uses `resume(handle, { signal })` after that plan lands; adjust the test name and file path to the actual implementation.
- The exact `pnpm` invocation for the lockfile depends on the working wrapper (`pnpm`, `rtk proxy pnpm`, or `corepack`). The direct binary commands in the success criteria are verified in this workspace; the lockfile command must be verified in the implementation environment.
- The Biome JSON `location.path` field is verified on macOS; CI is Ubuntu and uses POSIX paths. No normalization is planned unless the CI run shows otherwise.
