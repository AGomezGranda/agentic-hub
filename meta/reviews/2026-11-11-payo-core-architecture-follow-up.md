# Payo core audit: extended research

11 November 2026. Read-only continuation of the [first audit](/Users/alvarogomez/code/python/agentic-hub/meta/reviews/2026-11-11-payo-core-architecture-audit.md). Existing findings are not repeated. This pass expands into Git/Pi adapters, config, server lifecycle/read models, and CLI/browser streaming. Source files were not modified.

## Implementation progress

- [ ] A6: acceptance and preparation are tracked through registration, scheduling stops during shutdown, and execution base resolution receives cancellation; add the held preparation regression.
- [x] C5: capture the net tracked Git diff against the selected base.
- [x] A7 and C6: share the SSE parser and cancel CLI readers on exceptional exits.
- [ ] C7, C8 and C9.

The shutdown regression covers held run acceptance; a separate held execution-preparation regression remains to be added.

The additional value comes from consolidating rules that have already drifted and making resource ownership explicit. Large files are not all equivalent: the Pi adapter has independently consumed operations worth separating; Git commit safety needs repeated validation even after its implementation is shared.

## Additional confirmed findings

### A6 — P1: Shutdown does not own run acceptance and preparation

**Responsibilities · D2 · high confidence · medium effort.** [run-application.ts:239](/Users/alvarogomez/code/python/agentic-hub/payo/apps/server/src/run-application.ts:239) checks `isStopping()` then awaits `beginFactory(...)` outside `track()`. The implementation command similarly awaits existing-execution discovery and preparation outside tracking at lines 211–232. [composition.ts:246](/Users/alvarogomez/code/python/agentic-hub/payo/apps/server/src/composition.ts:246) sets stopping, aborts registered controllers, waits for tracked tasks, and closes the store.

Acceptance can still be writing artifacts while shutdown concludes there is no work and closes persistence. After the await, acceptance can register a handle and schedule a new controller after the shutdown abort sweep. An injected-store reproduction held the first artifact write, completed composition shutdown, then released acceptance and observed another write after store closure. The HTTP shutdown sequence closes the listener but does not wait for existing requests before shutting down services, so request lifetime does not close this gap.

**Counterevidence:** scheduled execution and several commands are tracked; execution resume already checks stopping before scheduling. Initial stopping checks reject new work but cannot protect work already inside an await. No production incident is established.

**Smallest correction:** track acceptance through preparation and handle registration; prevent scheduling after stopping starts. Give preparation side effects the process-owned cancellation lifetime, and close the store only after accepted operations settle. Keep the existing scheduler and task set; a new queue framework is unnecessary.

**Verification:** full application, composition, and HTTP bootstrap/shutdown source, command call chains, and an injected-store reproduction. Add a regression that shuts down during held acceptance/preparation.

### C5 — P2: Git review evidence concatenates intermediate states instead of the net change

**Code quality · correctness/KISS · high confidence · small-to-medium effort.** [execution.ts:337](/Users/alvarogomez/code/python/agentic-hub/payo/adapters/git/src/execution.ts:337) captures `base...HEAD`, then separately captures worktree-versus-index and index-versus-HEAD diffs. These patches are concatenated as the current engine diff.

A scratch Git reproduction committed `A`, staged `B`, and restored the worktree to `A`. The current recipe emitted two opposing patches, `B → A` followed by `A → B`; a direct base-to-worktree tracked diff was empty. Review receives these intermediate patches as one current snapshot. A path can appear changed when its final contents are unchanged, and intermediate edits consume the evidence byte budget unnecessarily.

**Counterevidence:** combining committed and uncommitted work is necessary, and explicit untracked-file capture remains necessary. Current tracked-plus-untracked tests do not establish correctness for cancelling staged/unstaged edits. Snapshot stability checks still protect against concurrent changes; they do not fix the represented diff.

**Smallest correction:** capture one tracked diff against the selected base, preserving binary output and byte limits, then append the existing untracked-file evidence. Keep fingerprint/stability checks. Verify staged-only, unstaged-only, cancelling edits, prior phase commits, and untracked files.

**Verification:** full Git adapter, review consumer, existing Git tests, and a temporary-repository reproduction. This is a behavioral fix, not merely a file move.

### A7 — P2: CLI and browser own divergent copies of the same SSE parser

**Boundaries/contract ownership · S4 · high confidence · small effort.** [CLI client.ts:310](/Users/alvarogomez/code/python/agentic-hub/payo/apps/cli/src/client.ts:310) and [browser stream.ts:17](/Users/alvarogomez/code/python/agentic-hub/payo/apps/web/src/features/run-workspace/stream.ts:17) independently implement `SseParser` for the same Payo event stream. The CLI normalizes CRLF separately in each chunk: `this.buffer += chunk.replace(/\r\n/g, "\n");`; the browser recognizes line endings across chunk boundaries.

An in-memory reproduction split a valid frame across `"id: 1\r"`, `"\ndata: {}\r"`, `"\n\r"`, and `"\n"`. The CLI dispatched nothing. Its parser also requires a space after `data:` whereas the browser handles the optional space. The copies have already drifted in transport knowledge, not merely naming.

**Counterevidence:** the current server emits LF with spaces, so this does not establish loss of current native server frames. The clients have legitimately different presentation, configuration, and error messages; those need not be unified.

**Smallest correction:** give the pure parser one shared, browser-compatible home, exported through an existing public package surface, with chunk-boundary fixtures used by both clients. The contracts package already exposes pure protocol helpers. Keep fetching, reconnect behavior, and presentation in their clients. Do not import browser feature internals from CLI or add a package just for this parser.

**Verification:** full client and browser stream implementations, both parser/stream test suites, server event framing, and an in-memory parser reproduction. This correction crosses client modules, so it is recorded as shared protocol ownership rather than a second local DRY finding.

### C6 — P2: CLI stream failures leave the response reader open

**Code quality · resource/error handling · high confidence · small effort.** [client.ts:256](/Users/alvarogomez/code/python/agentic-hub/payo/apps/cli/src/client.ts:256) catches and rethrows stream failures without a cleanup `finally`. Reader cancellation occurs only when a parsed `run.ended` arrives. The `follow()` caller removes its SIGINT listener but does not abort its controller on exit.

Malformed JSON, schema rejection, or a throwing event callback can terminate consumption while leaving the response body active. A fake `ReadableStream` with a cancellation observer confirmed that invalid JSON rejects `CliClient.stream()` without cancellation. The browser implementation already cancels its reader in `finally`.

**Counterevidence:** normal terminal events cancel successfully; natural EOF is already closed. This concerns exceptional exits, not every CLI stream.

**Smallest correction:** cancel the reader in `finally`, preserving the original failure when cancellation itself fails. Keep abort behavior and terminal handling. Test malformed input and a throwing callback using an in-memory response; no localhost listener is required.

**Verification:** full CLI stream and follow caller, corresponding browser cleanup, tests, and a fake-response reproduction.

### C7 — P2: The Pi adapter mixes protocol normalization, process execution, and readiness probing

**Code quality · SOLID/SRP · high confidence · medium effort, mostly moves.** [runner-pi/index.ts:60](/Users/alvarogomez/code/python/agentic-hub/payo/adapters/runner-pi/src/index.ts:60) implements process/session/stream cleanup; [line 348](/Users/alvarogomez/code/python/agentic-hub/payo/adapters/runner-pi/src/index.ts:348) exports `mapPiRecord`; [line 458](/Users/alvarogomez/code/python/agentic-hub/payo/adapters/runner-pi/src/index.ts:458) exports `checkPi` for authentication readiness.

Native event/usage schema changes, process-group cleanup changes, and doctor command changes currently edit the same 694-line implementation. Doctor and runner have separate production consumers, and tests already group mapper, accounting, runner, and readiness behavior separately. There are existing seams rather than a need for invented ones.

**Counterevidence:** all operations belong in the Pi adapter package. One implementation of the runner is not an abstraction defect, and its cleanup must remain explicit.

**Smallest correction:** move native event mapping/state and usage helpers to `mapping.ts`, and readiness probing to `doctor.ts`; keep process/session ownership together in the runner. Preserve package-root exports. Retain current tests and public contracts; add no strategies or interfaces just for the split.

**Verification:** complete adapter and tests, production composition/doctor callers. Process behavior was inspected, not certified with live Pi.

### C8 — P2: Git staging rules are implemented twice

**Code quality · DRY · high confidence · small effort.** [execution.ts:489](/Users/alvarogomez/code/python/agentic-hub/payo/adapters/git/src/execution.ts:489) implements `prepareCommit`; [line 577](/Users/alvarogomez/code/python/agentic-hub/payo/adapters/git/src/execution.ts:577) repeats its staging/validation sequence inside `commit`: add all, reject unstaged changes, interpret cached-diff exit codes, and read parent/tree.

Both sequences enforce the same staging invariant. Changing staging behavior or accepted Git exit codes requires editing both versions, among different surrounding intent and ownership checks.

**Counterevidence:** calling the validation twice is essential: the second call revalidates durable intent after a possible delay or crash. It must not be removed as “duplicate work.” Before/after snapshots and intent comparisons belong at their existing call sites.

**Smallest correction:** extract one private helper for the shared staging/read-tree sequence, returning parent/tree/changed; call it from both operations. Preserve contextual errors and every caller-specific check. No new public port is needed.

**Verification:** full adapter, commit-intent consumers, and existing execution tests. This recommendation consolidates implementation while retaining repeated validation.

### C9 — P2: Status projections combine different state revisions

**Code quality · snapshot consistency · high confidence · small-to-medium effort.** [execution-read-model.ts:29](/Users/alvarogomez/code/python/agentic-hub/payo/modules/factory/src/execution-read-model.ts:29) captures `const run = state.log.current();`, awaits artifact reads, and subsequently reads stage, receipts, phase index, and other fields from the replaceable `state.checkpoint`. [run-summary.ts:18](/Users/alvarogomez/code/python/agentic-hub/payo/apps/server/src/run-summary.ts:18) similarly captures run state before awaits but reads handle checkpoints and a nested summary later.

Execution can advance while artifact I/O is pending. A held-artifact-read reproduction advanced the handle to ended/reviewed and `Completed`, then released the summary read. It returned `status: "active", outcome: null, stage: "Completed"`: the old run and new checkpoint combined. Immutable artifacts protect individual bytes, not consistency of the assembled view.

**Counterevidence:** this is a status/read-model problem, not proof of an invalid execution transition. Planning's `readRunReview` already snapshots its checkpoint before awaiting, providing an existing convention to reuse.

**Smallest correction:** capture the run and checkpoint together before the first await, then project exclusively from that view. Supply the same view to outer and nested summaries instead of recapturing between awaits. Preserve optional-artifact degradation and diagnostics.

**Verification:** full read-model, log/handle implementation and outer summary/callers, plus an injected asynchronous-read reproduction. Add a regression that advances execution during the held read and asserts a coherent result.

## Config: a useful optional separation, not another correctness finding

[config/index.ts](/Users/alvarogomez/code/python/agentic-hub/payo/packages/config/src/index.ts:148) combines precedence/model resolution with TOML document persistence, revision checks, write serialization, and atomic replacement. Server startup and CLI consume resolved values; the settings service separately consumes document reads/writes and candidate resolution.

If touching this package, keep `index.ts` as its API and separate resolution from file persistence (`resolve.ts` and `document.ts` are sufficient). This is a lower-priority navigation improvement. The inspected code already shares startup/save precedence and preserves atomic writes, so its 516 lines alone are not a demonstrated defect. Preserve strict parsing, missing-file semantics, revision checks, symlink rejection, and restrictive file modes. Do not turn this into a generic configuration framework.

## Coverage and checks

Expanded deep coverage: complete Git execution and Pi adapters; config implementation and relevant tests; CLI client/command streaming and browser streaming; server composition/application/bootstrap; factory read models. Other frontend components, Jira/SQLite/check-process internals, performance, security, and the test pyramid remain outside this extension.

The inherited architecture classification, domain vocabulary, package graph, and seven-commit history remain as recorded in the first audit. No new package edge or cycle was introduced: this pass changes documentation only. A6 adds a lifecycle ownership finding that import checks cannot detect. A7 adds protocol ownership drift across two clients; it does not justify merging the clients.

- Scoped existing tests: **48 passed; three CLI localhost tests could not run successfully because the sandbox denied `listen 127.0.0.1` with EPERM**. Their five-second timeouts are not being reported as code defects.
- Parent in-memory checks reproduced the CLI parser chunk-boundary loss and missing reader cancellation.
- Independent injected-store, held-artifact-read, and temporary-Git checks reproduced shutdown ownership, mixed-revision summaries, and contradictory diff evidence; source/call contracts were verified before reporting.
- Existing tests do not cover the identified shutdown race, cancelling staged/unstaged diff, or CLI exceptional cleanup. These are specific regression opportunities, not a broader test-strategy verdict.

Extend existing checks with behavior tests for A6/C5/C6, shared protocol fixtures for A7, and stable public-export assertions when splitting C7. Do not enforce file-size limits. Prioritize A6 and C5 before cosmetic file moves, then close the CLI cleanup/parser drift; the Pi and staging extractions are safe-sized follow-on refactors when their behavior checks pass.
