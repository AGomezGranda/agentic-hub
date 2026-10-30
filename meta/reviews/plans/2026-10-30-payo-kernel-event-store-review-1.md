## Plan Review: Payo step 2 — kernel core and event store
**Verdict:** REVISE

The plan is well-scoped and mostly sound: optimistic `expectedSeq` concurrency, derived gate ids for idempotent recovery, `unknown` usage, and a shared store contract suite. Two confirmed P1s: `commit` validates only through the reducer, so a schema-invalid event can reach the log and make the run unreadable; and the planned Biome contingency for `@payo/kernel/testing` points the wrong way, so the modules boundary would not be enforced. The remaining findings are P2 hardening and test gaps.

### Coverage
- **Correctness:** checked. Read the plan fully and the referenced design, roadmap, biome config and boundary test.
- **Architecture:** checked. Package layering, subpath export, `vitest` leakage, roadmap alignment.
- **Test coverage:** checked. Phase 1–3 test lists against the stated invariants.
- **Security:** checked, scoped to the store port and artifact paths. Step 5 HTTP surface is not in this plan, so only its input contract is judged here.
- **Code quality:** checked, light pass on interface and error-type naming.
- **Not applicable:** performance (no hot path in this step), UX (no UI), docs (only as roadmap alignment).
- **Method:** one direct review pass by the reviewing agent. No independent child reviewers were run, so the second-view check on the two P1s rests on my own probes (below), not a separate reviewer.
- **Verified by probe:** ran `payo/node_modules/.bin/biome lint` against a temp copy of the plan's `biome.json` (see F2).
- **Unverified:** runtime behaviour of `node:sqlite` edge cases (crash mid-schema-create, power loss). Reasoned from SQLite semantics, not executed.

### Cross-Cutting Themes
- **Validation at the boundary** (F1, F6): the plan validates shape on read and hash on read, but not on write, and not at the `readArtifact` port. Same fix shape: parse at the boundary you control.
- **Durability ordering** (F4): an event that references an artifact can be committed before the artifact is durable, and nothing enforces that the artifact exists.

### Tradeoffs
- None requiring a referee. The `dataDir`-not-on-Run decision (F9) is a deliberate deviation from the roadmap; the plan's rationale is reasonable, but the roadmap still says otherwise.

### Findings

#### Critical
- 🔴 **F1 · Correctness**: Unvalidated events can be committed — **Location**: Phase 2 `commit`; Design Decisions "Commands decide, `commit` validates" — **Summary**: `commit` folds bodies through `reduce`, which checks invariants (ids, order, status), not schemas. Nothing calls `RunEventBody.parse` before `store.append`. Phase 3 `read` does parse each row, so one bad body (e.g. `gate.raised` with `allowedCommands: []`, or a bad `usage` value from a caller) makes every later `read`/`openRun` throw. The run cannot be rebuilt. The plan's claim "an invalid event never reaches the log" is not true as written. **Fix:** parse each body with `RunEventBody` in `commit` (or inside `append` in every store) before folding; add a test that a schema-invalid body writes nothing.

- 🔴 **F2 · Architecture**: Biome contingency for `@payo/kernel/testing` is inverted — **Location**: Risks (first bullet); Phase 2 "Spike" and `biome.json` change; `payo/test/boundaries.test.ts` row for `modules/factory` — **Summary**: The plan assumes `@payo/*` matches `@payo/kernel/testing` and that the fix is an exclusion (`!@payo/kernel/testing`). Probe result: `@payo/*` does **not** match the subpath. A control import of `@payo/runner-fake` from `modules/` fires `noRestrictedImports`, but `import "@payo/kernel/testing"` from `modules/` produces no diagnostic. Adding an exclusion would not block anything. Adding a positive literal `"@payo/kernel/testing"` to the modules group does produce the MODULES error (verified on a temp copy). Consequence: the planned boundary row (`modules/factory` importing `@payo/kernel/testing` is blocked) fails, and vitest-as-runtime-surface in modules is unguarded. **Fix:** in the spike, add the positive literal `"@payo/kernel/testing"` to the modules and cli groups (and contracts, if it should be blocked there), not an exclusion. Adapters need no change: they already allow `@payo/kernel` only via the `!` form, and the subpath falls outside `@payo/*`, so it is allowed. Keep the spike, but reverse the contingency text.

#### Major
- 🟡 **F3 · Correctness**: Reducer may mutate caller state before a failed append — **Location**: Phase 2 `reduce`, `commit` ("folds `bodies` onto `state` first") — **Summary**: The plan does not say `reduce` is pure. If it mutates the `Map`s or `lastSeq` in place, a `StaleSeqError` from `store.append` leaves the caller's `state` already advanced. `openRun` and any "reload and retry" path then operate on a corrupted state. **Fix:** require `reduce` to return a new state (copy-on-write or cloned Maps), and add a test that the input state is unchanged after a `StaleSeqError`.

- 🟡 **F4 · Correctness**: Committed artifact reference can outlive its file — **Location**: Phase 3 `putArtifact` ("write temp, then `renameSync`"); Phase 2 `artifact.recorded` — **Summary**: The plan does not fsync the temp file or the directory before rename, and `commit` does not check that the artifact exists. After a crash, the `artifact.recorded` event (synced by SQLite) can survive while the artifact file is lost. Later `readArtifact` then throws for a referenced input. Single-host, so impact is limited to crash/power-loss windows, but the design claims durable records. **Fix:** `fsync` the temp file before rename and fsync `artifacts/` after; state the ordering invariant (put before commit) in `commit`'s doc, and add a test that `artifact.recorded` for an unknown hash is rejected or documented as caller-owned.

- 🟡 **F5 · Architecture**: `openRun` can interrupt a live run — **Location**: Phase 2 `openRun` ("Idempotent"); Risks "Two processes recovering the same run" — **Summary**: `openRun` treats every running attempt as interrupted. Called while the same process is still executing that attempt (e.g. a second `openRun` from an API handler or a test), it writes `interrupted` over a live attempt. The mitigation covers a second process only. **Fix:** state that `openRun` is for startup only, before any executor starts; and either enforce that in step 5 with a per-run in-process lock or a one-time startup call, or name it in "What we're NOT doing".

#### Minor
- 🔵 **F6 · Security**: `readArtifact` takes an unvalidated string used as a path — **Location**: Phase 2 `RunStore.readArtifact(sha256: string)`; Phase 3 `readArtifact` — **Summary**: `artifacts/<sha256>` is built from a raw string. The hash check limits what a traversal can leak, but `..` still reads arbitrary paths before throwing. Step 5 will pass URL params here. **Fix:** validate against the `ArtifactRef` sha regex before building the path, in the port contract and in the SQLite adapter; add a contract case that `readArtifact("../x")` rejects.

- 🔵 **F7 · Test coverage**: Contract suite misses batch atomicity and concurrent writers — **Location**: Phase 2 "Contract cases" — **Summary**: No case that a multi-event `append` where a later row fails leaves zero rows. "Two writers" is described sequentially; the race that matters for `BEGIN IMMEDIATE` needs two stores from two `open()` calls running concurrently. No case for `append([])` as a no-op or `read` of an unknown run returning `[]`. **Fix:** add those four cases to `testing.ts`.

- 🔵 **F8 · Correctness**: Schema creation not atomic with `user_version` — **Location**: Phase 3 open sequence — **Summary**: A crash after `CREATE TABLE` but before `PRAGMA user_version = 1` leaves version 0 with tables present, so the next open fails with "table already exists". **Fix:** run the schema and the version pragma in one transaction, or use `CREATE TABLE IF NOT EXISTS`.

- 🔵 **F9 · Architecture**: Roadmap deviation not recorded — **Location**: Design Decisions "`dataDir` is not recorded on the Run"; roadmap step 2 bullet 1 — **Summary**: The roadmap says the effective config, "per-role model and limits, concurrency, data dir", is resolved once and recorded on the Run. The plan drops `dataDir` and defers concurrency, with a reasonable rationale, but the roadmap still says otherwise. Also, the roadmap lists a Run schema under contracts; the plan has no `RunRecord` schema (`RunState` lives in kernel with `Map`s). **Fix:** either update the roadmap line or add the deviation to the plan's Deviations log; state that `RunState` is kernel-internal and not a contracts record.

- 🔵 **F10 · Code quality**: Underspecified names and types — **Location**: Phase 1/2 — **Summary**: `StaleSeqError.expected`/`actual` do not say which side is the caller's `expectedSeq` and which is stored `MAX(seq)`. `gate.raised.kind` has no type (string? enum?). `attempt.started.inputArtifacts` and `artifact.recorded` are not checked against known artifacts, so the reducer accepts dangling references. **Fix:** define the error fields in one line each; state the `kind` type; decide whether the reducer checks artifact references (it cannot see the store, so probably not; then say so).

### Strengths
- ✅ Layering is explicit and enforced by Biome and a boundary test table; the plan names its own spike before relying on the glob.
- ✅ Optimistic `expectedSeq` plus `BEGIN IMMEDIATE` gives one-writer-per-run without locks.
- ✅ Recovery is an ordinary commit with a derived gate id (`interrupted:<attemptId>`), so a second recovery is a no-op; tests pin that.
- ✅ Usage is `number | "unknown"` throughout, matching the design rule (never default to 0).
- ✅ Store tests use `mkdtemp`; the data-location test guards the "never touch `~/.payo`" rule.
- ✅ Test lists are written before the code, with edge cases named (zero usage, `fromSeq` boundary, tampered artifact).

### Recommended Changes
1. Parse every event body with `RunEventBody` in `commit` before folding; add a schema-invalid-body test that writes nothing. (addresses: F1)
2. Replace the Biome contingency with a positive literal `"@payo/kernel/testing"` in the modules and cli groups; keep the spike and the boundary row. (addresses: F2)
3. Specify `reduce` as pure (new state), and add an unchanged-state-after-`StaleSeqError` test. (addresses: F3)
4. Add fsync before rename and on the artifacts dir; state the put-before-commit ordering; decide and test the unknown-hash case. (addresses: F4)
5. Document `openRun` as startup-only, and name the same-process case in "NOT doing" or enforce it. (addresses: F5)
6. Validate the sha256 format in `readArtifact` and add a traversal contract case. (addresses: F6)
7. Add four contract cases: batch atomicity, concurrent writers across two stores, `append([])`, unknown-run read. (addresses: F7)
8. Make the schema-create plus `user_version` step atomic. (addresses: F8)
9. Update the roadmap or the plan's Deviations log for `dataDir` and the missing Run record. (addresses: F9)
10. Define `StaleSeqError` fields and `gate.raised.kind` type; state the artifact-reference check decision. (addresses: F10)
