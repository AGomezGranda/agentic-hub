# Payo code-quality audit — 2026-11-14

**Fix follow-up:** CQ-06, CQ-07 and CQ-08, plus the publication navigation issue, are fixed in the working tree. Fatal untracked diff statuses now reject even with partial output; scout completeness and verifier semantics participate in output repair; doctor receives its full collaborator set from adapter wiring; publication links use existing in-app navigation. Regression checks cover fatal diff output, five malformed review-output cases, injected executor identity, and both source-link clicks. Biome, both TypeScript configurations, and the full suite passed: **1,119 tests passed, one live test skipped**. The sandboxed initial suite encountered loopback restrictions; the successful full run had local test networking available. Live external integrations were not exercised. Original audit evidence follows unchanged.

Audited the current working tree under `payo`, including the uncommitted factory reorganization. HEAD was `288cc920cd54ad10c81b0b87864c84a3e5d34adc`; this is a working-tree audit, not a diff-only review. Production code and tests were unchanged.

Payo models planning, execution and publication as linked event-sourced runs. Strict TypeScript with `noUncheckedIndexedAccess`, Zod contracts, and injected kernel ports establish its conventions. All six lenses applied: SOLID, DI, DRY, KISS, typing and error handling. The installed skill's consolidated `references/checks.md` and `references/review.md` supplied the rubrics; the separately named dimension files do not exist.

Three confirmed P2 findings remain. All are previously missed issues, rather than regressions introduced by the previous audit's fixes. Findings are ordered by consequence; effort is separate.

## CQ-06 — P2 · high confidence · errors: fatal untracked diff output is accepted

Location: `payo/adapters/git/src/execution.ts:834`.

```ts
if (result.exitCode !== 1 && result.stdout.length === 0)
```

**Violated contract:** `ExecutionWorkspace.diff` must reject failed capture rather than return incomplete evidence as a successful diff.

**Consequence:** A fatal exit such as 2 accompanied by partial stdout passes this condition. The adapter discards stderr and returns the partial diff. Factory diff capture and implementation review can then consume incomplete evidence without knowing capture failed.

**Counterevidence:** Tracked diff capture rejects nonzero exits; spawn, timeout and output-limit exceptions propagate. Those protections do not cover a completed untracked `--no-index` command returning a fatal exit alongside output. Existing capture/limit tests do not exercise this combination.

**Smallest correction:** Check exit status independently of output presence; accept the expected `--no-index` statuses 0/1 and reject other statuses with stderr context. Preserve any separate intended empty-output check. Effort: small.

**Verification tier:** Load-bearing: full adapter file, workspace port, and downstream factory capture/review context inspected by parent. Child additionally exercised the public factory in a temporary filesystem fixture with `{exitCode:2, stdout:"partial diff", stderr:"fatal: corrupt input"}` and observed successful return of `partial diff`. That reproduction was not independently rerun by the parent.

## CQ-07 — P2 · high confidence · typing/errors: semantic output failures bypass agent repair

Locations: `payo/modules/factory/src/application/execution-review.ts:243`, `:260`, and `:379`.

```ts
validate: jsonEnvelope(ExecutionScopeMap),
// after runAgentStep has already returned success:
validateScopeMap(scopeMap, diffPaths(diff), instructions);

validate: jsonEnvelope(ImplementationVerificationOutput),
```

**Violated contract:** Agent output must satisfy its complete acceptance contract inside the validator that controls the output-repair attempt. `runAgentStep` retries rejected output once, attaching the prior output and validation error; successful output finishes the step immediately.

**Consequence:** A scout can omit a changed path or applicable instruction while passing the schema. Only after the step succeeds does `validateScopeMap` throw, causing execution escalation without the repair attempt. Likewise, a verifier can omit finding verdicts, reference unknown IDs, or return INVALID without counter-evidence: its schema accepts these outputs, and the later `decideImplementationReview` escalates them. Recoverable output mistakes require operator intervention and rerunning review instead of receiving targeted repair feedback.

**Counterevidence:** The later checks correctly prevent accepting incomplete review evidence; this is not an acceptance bypass. Lens outputs already validate ID prefixes inside their step validator. Planning review also performs its semantic verdict validation inside the validator. Legitimate plan conflicts, unchecked lenses and exhausted repair budgets should continue to escalate, rather than be treated as malformed output.

**Smallest correction:** Run scope-map completeness/instruction checks in the scout validator and return a rejected validation result on failure. Validate verifier ID coverage and counter-evidence in its validator, distinguishing malformed output from legitimate review decisions. Reuse the existing domain checks where possible. Effort: small to medium.

**Verification tier:** Load-bearing: full implementation-review file, domain decision contract, agent-step retry/classification flow, role instructions and schemas inspected. An executed assertion confirmed that an empty scope map passes the schema and an empty verifier verdict list passes its schema but escalates with `missing verifier verdict` when findings exist. No complete simulated invalid-scout lifecycle was executed.

## CQ-08 — P2 · high confidence · DI: doctor orchestration selects process collaborators

Location: `payo/apps/server/src/doctor.ts:25`.

```ts
const pi = probes.pi ?? checkPi;
const acli = probes.acli ?? checkAcli;
const git = probes.git ?? checkGit;
const roleSources = probes.roleSources ?? checkRoleSources;
const gitExec = createGitExec({ bin: config.gitBin });
```

**Violated contract:** The audit's explicit strict DI rule prohibits application orchestration from internally selecting or constructing side-effecting collaborators. Entry-point composition remains legitimate.

**Consequence:** `runDoctor` combines readiness aggregation with production process wiring. Its probe seam cannot independently substitute the shared Git executor; callers wanting real Git and role-source probes with a controlled executor must wrap both probes. This is a bounded compliance/testability issue, not an observed resource leak.

**Counterevidence:** All four probes can already be replaced, and tests use that seam. Creating the executor defers process execution until invocation. These facts reduce the practical impact, but do not satisfy the strict construction rule governing this audit.

**Smallest correction:** Build default probes and their shared executor in composition/startup callers, then require the resulting probe set in `runDoctor`. Keep aggregation and `safeCheck` behavior. Effort: small.

**Verification tier:** Load-bearing: full doctor implementation and composition inspected by parent; child also inspected startup callers, executor factory and supporting tests.

## Previous findings

The five findings in `meta/reviews/2026-11-13-payo-code-quality-audit.md` remain fixed in inspected source:

- CQ-01: `planning/checkpoint.ts:120` checks the current working file against its retained hash before replacement; approval and pause use it. Lifecycle records the basis for ordinary reviews.
- CQ-02: `application/review.ts:46` checks reviewer lens prefixes inside the output validator.
- CQ-03: Pi usage normalization rejects negative readings and nonfinite accumulated totals.
- CQ-04: GitHub and publication Git errors retain bounded command diagnostics.
- CQ-05: composition initialization is enclosed in cleanup that closes the store while retaining the original error.

This was a source and focused-regression recheck, not a complete repeat of every original reproduction.

## Explicitly fine within inspected paths

| Dimension | Bounded evidence |
| --- | --- |
| SOLID | No concrete substitutability or interface-responsibility defect established in the inspected ports, adapter factories and workflow coordinators. Size alone was not treated as a violation. |
| DI | Factory receives scheduler, IDs, store, runner, limiter, workspace and plan persistence through `application/types.ts:33`; server composition explicitly wires them. CQ-08 bounds this positive claim. |
| DRY | Shared HTTP/SSE transport and contract parsing centralize protocol knowledge. Similar planning/execution policies protect different invariants; no additional synchronized business-rule copies were confirmed. |
| KISS | No material defect established in inspected seams. One implementation was not grounds for removing a lifecycle/test seam. |
| Typing | Runtime schemas guard JSON/event boundaries. `kernel/src/application/agent.ts:54` validates unknown JSON before accepting output; CQ-07 concerns semantic checks after shape validation. |
| Errors | `kernel/src/application/run-log.ts:25` advances state only after successful commit and returns the rejecting promise; fan-out retains child failures. CQ-06/CQ-07 bound this claim. |

## Out of scope, flagged separately

Confirmed UI correctness issue: `apps/web/src/features/run-workspace/PublicationView.tsx:44` and `:47` use ordinary internal links. Clicking Planning or Execution reloads the application; `apps/web/src/app/App.tsx:44` initializes the memory-only token to null, requiring reconnection. `ExecutionView` already uses modifier-aware click interception with `onSelectRun`, and `RunWorkspace` receives that callback but does not pass it to PublicationView. Reuse that existing navigation path. This is a functional UI bug, not forced into a design dimension; it fits a general change/repository correctness review such as ponytail-review or ponytail-audit.

No separate architecture, security or performance defect was established. Those disciplines and testing strategy were excluded.

## Coverage and validation

Every row considered all six dimensions; “checked” is bounded by the stated depth and does not certify every input permutation.

| Area | Status and boundary |
| --- | --- |
| Kernel, contracts, config | Production files reviewed by child; parent checked relevant agent/run/log contracts. Tests sampled; exhaustive schema permutations unverified. |
| All seven adapters | Production TypeScript reviewed by child; parent verified the load-bearing Git finding and factory consumers. Supporting tests sampled. |
| Factory planning/review | Checked ordinary review/run/checkpoint logic and prior fixes; update/approval/lifecycle contracts sampled. Not a line-by-line re-audit of all planning commands. |
| Factory execution/review/publication | Review coordinator and decision/agent contracts checked in depth; execution/resume/checkpoint and publication runner read. Preparation, repair internals, metrics/cost paths sampled; exhaustive recovery-state combinations unverified. |
| Factory naming/phase parsing and plan persistence | Production naming, phase-outline, answer rendering and filesystem plan persistence read; focused domain/infrastructure tests passed. No confirmed design finding. |
| Server/CLI | Composition, application, HTTP/SSE, startup, settings, doctor, role sources, workspace opening and CLI client/editor/dispatch inspected; argument branches sampled. |
| Web | App, workspace/activity/stream, transport, settings/actions and navigation inspected; display-only components sampled. Exhaustive browser interaction review unverified. |

Both backend and web TypeScript checks passed. Focused Vitest suites passed: 11 domain/infrastructure/role/read-model suites (88 tests), four execution/naming/publication/role suites (59 tests), and four Git/GitHub/Pi adapter suites (89 tests): **236 tests total**. The adapter suites were executed by the child; the other checks by the parent. Read-only schema/domain assertions also passed.

No unresolved candidate is asserted as a defect. Remaining work is the explicitly unverified coverage above: deeper planning update/approval paths, preparation/repair recovery combinations, exhaustive schema permutations and browser interactions. This is a bounded audit, not complete exhaustive coverage of every statement under `payo`.

Skipped the full suite, live external integrations and the excluded audit disciplines. The main confirmed risk is review consuming an incomplete diff after Git reports a fatal error; no fixes were applied.
