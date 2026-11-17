# Payo code-quality audit — 2026-11-13

**Fix follow-up:** All five findings below have been addressed in the working tree. Ordinary review persists its working-copy basis and preserves divergent edits on approval or escalation; planning reviewers repair invalid lens prefixes; invalid/overflowing Pi usage becomes unknown; publication errors retain bounded, redacted diagnostics; initialization failures close the store without masking the original error. Regression checks cover these paths. Full validation passed: Biome, both TypeScript configurations, and 1,113 tests (one live test skipped). Live Pi/GitHub operations were not exercised. The existing narrow race between the final file check and replacement by an unrelated editor remains; atomic conflict detection would require coordinating writers. The original audit evidence follows unchanged.

Audited the current working tree under `payo`, including its uncommitted factory reorganization, against SOLID, dependency injection, DRY, KISS, typing and error handling. Baseline HEAD: `288cc920cd54ad10c81b0b87864c84a3e5d34adc`; this is a working-tree audit, not a review limited to that commit's diff. No production code or tests were changed.

The model is a planning run followed by linked execution and publication runs. Kernel ports describe storage, agents, scheduling and repository operations; factory functions orchestrate their lifecycles; adapters implement effects; the server composes them and exposes validated HTTP/SSE contracts to CLI and React clients. Both TypeScript configurations enable strict checking and `noUncheckedIndexedAccess`. The installed skill has consolidated `references/checks.md` and `references/review.md`; these supplied the rubrics because its six individually named reference files are absent.

**Five confirmed findings: one P1 and four P2.** Prioritize preserving working-plan edits. Severity reflects consequence; effort is listed separately. Each recommendation was checked against original source and downstream contracts, not accepted from a child summary alone.

## Confirmed findings

### CQ-01 — P1 · high confidence · error handling: review can erase external plan edits

Location: `payo/modules/factory/src/application/planning/checkpoint.ts:144`; related successful-review replacement at `application/planning/run.ts:300`.

```ts
if (handle.checkpoint.plan && !handle.checkpoint.pendingPlanUpdate)
    await handle.deps.writePlan(
        handle.log.current().runId,
        (await version(handle)).plan.markdown,
    );
```

**Contract and consequence:** Failure recovery must preserve operator work. Ordinary `requestChanges` and resumed reviews snapshot the working plan, then await agents with `pendingPlanUpdate` null. If an editor saves another change during that work, `pause()` replaces it with the earlier snapshot on escalation. Successful review likewise checks for a stale working file only when `pendingPlanUpdate` exists, then writes the snapshot. External edits can disappear without a conflict.

**Counterevidence:** Prompt update/restore paths already compare working-copy hashes and preserve the file on escalation. Approval and answer commands also check concurrent edits. Those protections do not cover ordinary request-change/resume review. The editable-file workflow is documented in `docs/payo/usage.md:298`.

**Smallest correction:** Retain the working-file basis for ordinary reviews and check it before replacement; preserve the file and raise a recoverable conflict on divergence. Keep initialization when no working file exists. Effort: medium, including lifecycle regression checks.

**Verification tier:** Load-bearing, full planning checkpoint/run/lifecycle files plus approval and request-change contracts. An in-memory assertion using actual `beginFactory`, `savePlan`, `checkpoint` and `pause` confirmed that `# External edit while review runs` becomes `# Reviewed snapshot`; no disk writes were needed.

### CQ-02 — P2 · high confidence · typing/error handling: invalid reviewer IDs are rejected at the wrong stage

Location: `payo/modules/factory/src/application/review.ts:46`.

```ts
validate: jsonEnvelope(ReviewOutput),
```

**Contract and consequence:** `application/roles.ts:134` requires lens-prefixed finding IDs unique across lenses. `ReviewOutput` only enforces uniqueness inside each report. Two independent reviewers returning `F1` therefore succeed, and their findings are concatenated at `review.ts:61`. `domain/planning.ts:20` then rejects the aggregate before processing verifier verdicts. Both verifier attempts receive the same invalid inputs, so neither can repair the collision; review unnecessarily escalates.

**Counterevidence:** Aggregate duplicate detection is correct and should remain. Implementation review already validates the expected prefix in `application/execution-review.ts:498`. Instructions alone do not enforce the producer's contract.

**Smallest correction:** Validate the expected lens prefix inside each planning reviewer's existing validator so its repair attempt receives the error. Effort: small.

**Verification tier:** Load-bearing, full planning review and decision files, role instruction and implementation-validator comparison. An executable assertion accepted two individual `F1` reports and confirmed `decideReview` throws `duplicate finding id` before verifier verdict processing.

### CQ-03 — P2 · high confidence · typing/error handling: Pi usage normalization emits invalid events

Location: `payo/adapters/runner-pi/src/index.ts:678`, related `:686`.

```ts
if (typeof value !== "number" || !Number.isFinite(value)) return null;
// ...
return current + value;
```

**Contract and consequence:** The adapter returns normalized `AgentEvent`s. `Usage` permits finite nonnegative numbers or `"unknown"` (`packages/contracts/src/primitives.ts:26`). Negative counters pass these helpers; finite values can also overflow during addition. The resulting usage event fails `AgentEvent.parse` in `packages/kernel/src/application/agent-step.ts:293`, interrupting the attempt before a later valid result can be consumed.

**Counterevidence:** Missing readings already become `"unknown"`, and native cost handling separately rejects negative/nonfinite amounts. Kernel validation correctly prevents invalid usage from entering the log; the normalization defect is upstream.

**Smallest correction:** Reject negative readings and nonfinite totals in summation and accumulation, mapping those readings to `"unknown"`. Effort: small.

**Verification tier:** Targeted source/caller verification of normalization, event emission, Usage schema and kernel consumption. A Node assertion with native input `-1`, zero cache counters, output `1` and cost `0` produced `tokensIn: -1`; `AgentEvent.safeParse` rejected it. No live Pi process was used.

### CQ-04 — P2 · high confidence · error handling: publication drops command diagnostics

Locations: `payo/adapters/gh/src/index.ts:97` and `payo/adapters/git/src/publication.ts:65`.

```ts
`GitHub ${args[0]} failed (exit ${result.exitCode}); outcome may be unknown`
`publication git ${args[0]} failed (exit ${result.exitCode})`
```

**Contract and consequence:** A failed side effect should retain useful diagnostic context. The executors return stderr, but both wrappers discard it. Authentication, hook, permission and network failures become generic exit-code messages. Publication recovery persists only `error.message` (`modules/factory/src/application/publication/run.ts:168`), leaving the operator without the explanation needed to recover.

**Counterevidence:** Nonzero exits do reject, cancellation propagates, and uncertain publication outcomes remain explicit. Execution Git's wrapper already retains stderr. This is diagnostic loss, not false success.

**Smallest correction:** Retain a bounded, appropriately sanitized stderr excerpt in the recorded error or a diagnostic artifact; preserve outcome-uncertainty wording. Effort: small.

**Verification tier:** Load-bearing, full GitHub/publication Git adapters and publication execution failure boundary. No live push or GitHub mutation.

### CQ-05 — P2 · high confidence · error handling/lifecycle: failed composition can leave the store open

Location: `payo/apps/server/src/composition.ts:102`.

```ts
const ids = await store.listRunIds();
```

**Contract and consequence:** Composition owns store cleanup, closing it on adapter construction failure and normal shutdown. `listRunIds()` runs after the only initialization cleanup catch. If enumeration rejects, `createComposition` rejects without returning a shutdown handle or closing the store. In `main.ts`, assignment to `services` never completes, so its startup catch cannot release that store either. Embedded callers/retries can retain an open database resource.

**Counterevidence:** Adapter construction failures close the store at lines 87–89, and per-run read failures deliberately log and continue. Neither handles enumeration failure. Process exit can eventually release OS resources, which bounds severity.

**Smallest correction:** Cover the remaining initialization with failure cleanup that closes the store before rethrowing the original error. Effort: small.

**Verification tier:** Load-bearing, full composition and server startup files. An executed assertion injected a store whose `listRunIds()` throws; composition rejected and its `close()` flag remained false.

## Explicitly fine within inspected paths

| Dimension | Bounded evidence |
| --- | --- |
| SOLID | No additional defect established in inspected factory orchestration, adapter factories, server application methods and web coordination; size alone was not treated as a responsibility violation. |
| DI | Factory explicitly receives scheduler, IDs, store, runner, workspace and plan persistence (`application/types.ts:33`). Adapter factories expose execution/spawn seams. Infrastructure construction in server composition is legitimate. |
| DRY | HTTP mechanics use shared clients; similar planning and implementation review shapes protect different acceptance policies. No additional duplicated business rule with an established divergence consequence was confirmed. |
| KISS | No material defect established in the inspected seams and coordinators; a single implementation was not grounds for deleting a useful port. |
| Typing | Web JSON remains `unknown` until contract parsing (`apps/web/src/shared/api/client.ts:68`); server requests and CLI responses use runtime schemas. CQ-02/CQ-03 bound this positive claim. |
| Errors | Kernel run-log state advances after commit and returns the original rejecting promise (`packages/kernel/src/application/run-log.ts:24`). SQLite validates before beginning a transaction (`adapters/store-sqlite/src/index.ts:98`). Malformed SSE and 401 stop web reconnect loops (`useRunActivity.ts:158`). |

## Coverage, validation and limits

All six lenses were considered in every area below; “checked” is bounded to the described paths and does not certify every statement in the package.

| Area | Status and boundary |
| --- | --- |
| Factory planning/review/update/approval/recovery | Checked in depth; CQ-01/CQ-02. |
| Factory execution/publication lifecycle, review, reconciliation, artifacts, roles, metrics/cost read models | Checked; supporting tests sampled. |
| Kernel run commit/log, agent attempts, fan-out/limiter/recovery, costs/instructions | Checked; full state reducer and every port implementation not deeply audited. |
| Factory naming/phase parsing and filesystem plan adapter | Not deeply audited; next pass should trace parser edge cases and persistence contracts with their tests. |
| Adapters and config read/resolve/write | Production files reviewed; supporting tests sampled; CQ-03/CQ-04. |
| Contracts | Definitions and consumers sampled, especially run/agent/review/usage/publication. Exhaustive schema-variant audit remains unverified. |
| Server and CLI | Composition, application, HTTP/SSE, settings, role loading, startup, client, argument parsing and editor/launch flows inspected; CQ-05. Authentication helper read for context, not a security audit. |
| Web | Shared transport, streaming/activity, settings, plan and publication actions checked in depth. Workspace, swarm and display consumers read; presentation-only code sampled. No confirmed finding in inspected paths. |

Validation: both backend and web TypeScript checks passed using installed local binaries. Four focused suites passed: `composition.test.ts`, `http.test.ts`, CLI `client.test.ts` and `args.test.ts` — **81 tests**. The sandboxed run had 34 HTTP-related failures/timeouts with `EPERM` on loopback `listen`; rerunning with loopback networking available passed all 81 tests. Initial `pnpm exec` attempts failed fetching its pinned package manager; direct installed binaries avoided that bootstrap dependency. Focused in-memory assertions established the failure paths described above; they were not added as repository tests.

No unresolved candidate is asserted as a defect. Coverage gaps above remain unverified. Architecture, security, performance, dependency health and testing strategy were excluded; use their respective audits for those questions. No separate out-of-scope defect was established during this pass.

Skipped the full suite, exhaustive schema/parser review and live external integrations. The main confirmed risk is loss of external working-plan edits during ordinary review; no fixes were applied.
