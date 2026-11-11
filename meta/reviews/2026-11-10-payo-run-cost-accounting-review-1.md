# Plan Review: Harness-neutral Payo run cost accounting

**Date:** 2026-11-10
**Target:** meta/plans/2026-11-10-payo-run-cost-accounting.md
**Review:** 1
**Verdict:** REVISE

## Assessment

This is a strong, unusually well-verified plan. The current-state claims match the worktree, the cited files and symbols exist, the native Pi 1.5.0 evidence is accurate, and the proposed shape (persist observations, derive totals, keep existing ports) fits Payo's architecture. The remaining problems are contract ambiguities and one integrity gap in the projection, not a wrong design.

## Cross-Cutting Themes

1. **"Qualified amount" is not defined precisely enough.** `CostBasis` allows `"unknown"`, while the rest of the plan treats `amounts` as known subtotals. Coverage, `sumCosts`, and the tests all depend on this distinction.
2. **Projection integrity under partial/corrupt logs.** The plan rejects conflicting duplicates but not missing sequence rows, so it can silently understate cost while claiming complete coverage.
3. **Pi's initial zero versus a reported zero.** The adapter starts at `cost: 0`; the plan needs to say explicitly that this is not a native observation.
4. **Additive compatibility is handled well.** Optional `costDetails`, no new event variant, no SQL migration, and a clear legacy/rollback story.

## Findings

### Critical

None.

### Major

- **[Correctness / API & Compatibility] Design Decisions, Portable measurements (`:57-64`, `:79-82`) and Phase 2 change #6 (`:173`): `CostBasis` includes `"unknown"`, but the plan never defines when an amount would use it or whether it is a "qualified amount".** The plan describes `amounts` as "cumulative known subtotals" and coverage as "partial when qualified amounts exist alongside incomplete attempts". Pi only produces `provider-reported` or `estimated`; legacy records have no `costDetails`. An implementer could emit a `basis: "unknown"` amount and count it as qualified (false complete coverage) or exclude it (contradicting "known subtotals"). The Phase 1 contract tests do not cover this value.
  - **Fix:** Remove `"unknown"` from `CostBasis`; represent an unknown cost as no amount entry plus `complete: false`. If preserving an amount with unknown provenance is required, add an explicit `unqualified` flag/field and define its coverage rule. Add a contract test.

- **[Correctness / Data] Phase 2 change #5 (`:172`), projection test bullet (`:163`), and Risk table (`:253`): `projectRunCosts` rejects conflicting duplicate sequence rows but does not reject missing sequence numbers.** A log with `seq` 1, 2, 4 (or 1, 3) can still fold successfully if the missing row is not required for lifecycle validation, silently omitting a usage snapshot or an attempt. `fold` does not validate seq contiguity (`packages/kernel/src/state.ts` only reduces in array order), so coverage can report `complete` while cost is understated. This contradicts the stated mitigation "Fail discovery/projection rather than silently omit unreadable possible children".
  - **Fix:** After sorting and deduplicating, assert `seq` is contiguous from 1..n (or at least strictly increasing with no gaps) before folding, and throw on a gap. Add a projection test with a missing sequence row.

### Minor

- **[Correctness / Test Coverage] Phase 1 change #3 (`:130`) and test bullet (`:122`): Pi's initial `cost: 0` must not become a native zero amount.** `PiMapState.usage` starts at `{ tokensIn: 0, tokensOut: 0, cost: 0 }` (`adapters/runner-pi/src/index.ts:110`). The plan says a reported zero is an explicit amount entry, but does not say the initial scalar zero is not a report. If `addUsage` seeds `costDetails.amounts` from the initial scalar, a run with no native usage could look like a qualified USD zero and a complete attempt.
  - **Fix:** Initialize the new accounting state with `amounts: []` (or absent) and only add an amount when a native report is parsed. Add a test that an assistant message with no usage produces no amount entry and `complete: false`, distinct from a native zero.

- **[API & Compatibility / Test Coverage] Design Decisions (`:64`, `:107`): deterministic order of `amounts` is required but not enforced by the Zod schemas.** The schemas can enforce unique `(currency, basis)` buckets but not ordering. Since `costDetails.amounts` is authoritative and is copied into `CostSummary.amounts`, a non-deterministic adapter order leaks into query results.
  - **Fix:** Sort by `(currency, basis)` in `addUsage`/`sumCosts` and optionally refine the schema to require sorted order; add a test.

- **[Correctness / Test Coverage] Design Decisions (`:78-82`, `:107`) and Phase 2 change #6 (`:173`): `CostSummary` coverage consistency is not enforced and relies on an implicit invariant.** `CostSummary` has `amounts`, `coverage`, and `incompleteAttempts` but no attempt count. `sumCosts` must infer "no attempts" from "complete with empty amounts" and "attempts but no qualified amounts" from `coverage: "unknown"`. The plan states the invariant ("an empty array cannot establish completeness"; "a step or run with no attempts has an empty, complete summary") but the schema does not enforce it.
  - **Fix:** Add `attempts: number` (or `hasAttempts: boolean`) to `CostSummary`, and refine the schema: `complete => incompleteAttempts === 0`; `partial => amounts.length > 0 && incompleteAttempts > 0`; `unknown => amounts.length === 0 && attempts > 0`. Add a contract test. This also makes `sumCosts` simpler and less fragile.

- **[API & Compatibility] Phase 3 change #1 (`:208`) and test bullet (`:203`): invalid run ID error type is unspecified.** The plan says to validate with `validateRunId`, but that helper throws a plain `Error("invalid runId")` (`modules/factory/src/plans.ts:36`), not `CommandError`. The plan specifies `CommandError("not_found")` for a missing root and `CommandError("invalid_request")` for an execution/invalid config root, but not for a malformed ID.
  - **Fix:** Wrap `validateRunId` in `CommandError("invalid_request", ...)` or state that invalid IDs propagate as plain errors. Add a test if wrapping.

- **[Plan Mechanics / Test Coverage] Phase 2 change #5-6 (`:172-173`): `sumCosts([])` is unspecified.** The plan says a step or run with no attempts has an empty, complete summary, but does not define the empty input case. The factory always passes at least the planning summary, but tests may call it empty.
  - **Fix:** Define `sumCosts([])` as `{ amounts: [], coverage: "complete", incompleteAttempts: 0 }` (consistent with "no attempts") and test it.

- **[Test Coverage] Phase 1 test bullet (`:121`) and change #1 (`:128`): the new `packages/contracts/src/cost.ts` schemas are not directly tested in Phase 1.** The named contract tests are `agent.test.ts` and `run.test.ts`; `CostSummary`, `AttemptCost`, `StepCost`, and `RunCostTree` are only exercised later by Phase 2 projection tests. A schema mistake (wrong `.extend()` base, missing refinement) would surface late.
  - **Fix:** Add a small `packages/contracts/src/cost.test.ts` (or extend `run.test.ts`) covering the new schemas and their refinements.

- **[Correctness / Test Coverage] Phase 2 change #4 (`:171`) and test bullet (`:162`): "thrown validation error" versus "rejected output" is under-specified.** The current `classify` returns `{ rejected }` for `{ ok: false }` and lets a throwing validator propagate. The plan says force incomplete on "thrown execution/validation errors" but allow complete on rejected structured output. An implementer could collapse both into one failure path.
  - **Fix:** State the rule explicitly: force incomplete only on the catch/abort/deadline paths and on `classify`'s default; preserve `costDetails.complete` when `classify` returns a `result` (accepted or rejected) or a settled `error`. Add both tests (already listed) with the expected flag.

- **[Correctness / Test Coverage] Phase 1 change #5 (`:132`) and test bullet (`:123`): aborted Pi settlement final-snapshot behavior is unspecified.** `agent_settled` with `aborted: true` may not become a terminal event when the parent signal is already aborted. The plan says emit the final snapshot "immediately before `agent_settled` becomes a terminal event", but does not say whether an aborted settlement emits an incomplete final snapshot or relies on the last emitted snapshot.
  - **Fix:** State the behavior: on abort, do not emit a complete final snapshot; either emit an incomplete final snapshot or rely on the last emitted snapshot. Add the aborted-settlement test with the expected event sequence.

- **[Plan Mechanics] Current State (`:26-28`) and `primitives.ts:25`: minor citation drift.** `pi-coding-agent/dist/core/agent-session.js:2626` is actually line 2627; `primitives.ts:25` is the comment above `Usage` (the schema starts at 26). The claims are correct; only the line numbers drift.
  - **Fix:** Update the line numbers or drop the exact line for the compaction emit.

- **[Performance] Phase 3 change #4 (`:211`) and Risk table (`:252`): the full-history scan is acknowledged but unmeasured.** `readWorkCosts` calls `listRunIds()` and reads every log on each query. The `shortcut:` comment and "after measured history/query latency" are the right shape, but there is no measurement step or trigger.
  - **Fix:** Add a simple timing observation in the factory query test or document the expected history size and the upgrade trigger. Not blocking for the first slice.

### Suggestions

- **Document the compatibility scalar's mixed-basis behavior.** The plan says `cost` becomes `"unknown"` when cost is missing or currencies cannot combine, but not when pricing bases mix. One sentence saying the scalar is a same-currency sum across bases and is not authoritative (use `costDetails`) would prevent consumer confusion.
- **Consider `WorkCostTree`/`RunCostTree` consistency refinements.** The schemas do not enforce `planning.sourceRunId === sourceRunId` or `total === sum(planning, executions)`. A projection test may be enough, but a refinement would catch a future producer mistake.
- **Consider naming the new accounting fields in `PiMapState`.** The plan says "the accounting state needed" but leaves the shape to the implementer. A short list (`costDetails`, `missingReport`, `seenUsageEntryIds`) would make the Phase 1 change smaller and reviewable.

## Strengths

- **Accurate current-state analysis.** Every cited file and symbol exists; the claims about `reduce`, `recover`, `streamAttempt`, the 32-row batch, `sourceRunId`, execution identity, and SQLite JSON storage match the code.
- **Verified native evidence.** The Pi 1.5.0 claims (`cost.total`, `totalFromProvider`, `entry_appended` usage, `compaction_end` usage, print-mode JSON) are accurate, and the plan correctly insists on committed fixtures rather than the local install.
- **Right architecture.** Existing `AgentRunner` and `RunStore` ports, no new service/table/price catalog, kernel owns per-run projection, factory composes its existing relationship, no web/HTTP/CLI scope.
- **Good accounting semantics.** Replacement snapshots, terminal authority, retries/failed work counted, explicit zero, legacy records unqualified, separate currency/basis buckets, coverage separate from lifecycle status.
- **Good compatibility and rollback story.** Optional fields, no migration, old readers ignore unknown keys, rollback removes behavior not data.
- **Good test plan.** Test-first, per-phase automated and manual criteria, targeted edge cases (missing cost, zero, duplicate rows, restart, live reads, corrupt logs, same PR ID, distinct plan identities).
- **Clear non-goals and risks.** The plan is honest about observation completeness versus invoice truth and about the scan cost.

## Recommended Changes

1. **Remove or define `CostBasis: "unknown"`** and add a contract test for the chosen rule. (Major 1)
2. **Reject sequence gaps in `projectRunCosts`** before folding; add a gap test. (Major 2)
3. **Add `attempts`/`hasAttempts` to `CostSummary`** and refine coverage consistency; add a contract test. (Minor)
4. **Clarify Pi's initial zero** and add a no-native-usage test distinct from a native zero. (Minor)
5. **Sort `amounts` deterministically** and test it. (Minor)
6. **Wrap `validateRunId` in `CommandError`** or document the error contract. (Minor)
7. **Define `sumCosts([])`** and test it. (Minor)
8. **Add `packages/contracts/src/cost.test.ts`** for the new schemas. (Minor)
9. **State the thrown-vs-rejected and aborted-settlement rules** in Phase 1/2. (Minor)
10. **Add a measurement/trigger for the full-history scan.** (Minor)
11. **Fix the off-by-one citations.** (Minor)

After these are resolved, the plan should be ready for approval. Do not change the plan `status` in this review; that transition belongs to the user / create-plan.
