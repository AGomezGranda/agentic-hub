---
date: 2026-11-10
title: Harness-neutral Payo run cost accounting
status: Complete
---

## Scope

Monitor the reported model cost of a Payo work flow, including its planning run, every linked execution run, and all their steps and attempts. Support reads while work is active and after restart. Count failed work and retries as well as successful work.

The agreed first version uses amounts reported by the harness or provider, including harness-provided estimates. It does not calculate prices from model rates. The tree is **work → runs → steps → attempts**; phases, review rounds, and harness-internal subagents are not separate tree nodes. Expose core query functions only, with no HTTP, CLI, or web changes.

## Current State

- `UsageRecord` contains `tokensIn`, `tokensOut`, and `cost`, each a nonnegative finite number or `"unknown"`. It has no currency, pricing basis, or completeness (`payo/packages/contracts/src/primitives.ts:26`, `payo/packages/contracts/src/primitives.ts:32`).
- `AgentRunner.run` already streams normalized events across the adapter boundary (`payo/packages/kernel/src/agent.ts:4`). Pi adds native assistant-message usage to an attempt accumulator and emits cumulative snapshots (`payo/adapters/runner-pi/src/index.ts:343`, `payo/adapters/runner-pi/src/index.ts:364`). The kernel keeps the last snapshot, not their sum (`payo/packages/kernel/src/agent-step.ts:279`).
- Pi currently handles assistant messages, tools, and settlement; it ignores compaction and separately appended usage entries (`payo/adapters/runner-pi/src/index.ts:396`). Its input-token total includes cache reads/writes, and a missing component makes the cumulative scalar unknown (`payo/adapters/runner-pi/src/index.ts:571`).
- Streamed events are durable only when the pending batch flushes. The flush threshold is 32 rows or a terminal event (`payo/packages/kernel/src/agent-step.ts:29`, `payo/packages/kernel/src/agent-step.ts:286`). A low-volume live usage snapshot can remain buffered.
- The reducer ignores usage inside `attempt.event`; only `attempt.finished` fills `AttemptRecord.usage` (`payo/packages/kernel/src/state.ts:56`, `payo/packages/kernel/src/state.ts:128`). Recovery closes interrupted attempts with all-unknown usage (`payo/packages/kernel/src/run.ts:50`).
- Execution runs already point to planning through `ExecutionRunConfig.sourceRunId` (`payo/packages/contracts/src/execution.ts:154`). Execution identity is derived from source run, approved-plan artifact, and PR; duplicate acceptance reopens that same execution (`payo/modules/factory/src/execution/lifecycle.ts:82`, `payo/modules/factory/src/execution/lifecycle.ts:194`).
- Ended runs reject further events (`payo/packages/kernel/src/state.ts:52`). Planning may have ended before its execution children start, so growing work totals cannot be written to the planning log.
- `RunStore` supplies reads and deterministic run discovery (`payo/packages/kernel/src/store.ts:18`). SQLite stores validated event bodies as JSON; additive optional fields need no table migration (`payo/adapters/store-sqlite/src/index.ts:37`, `payo/adapters/store-sqlite/src/index.ts:144`).

Native Pi evidence was checked against the locally installed **1.5.0** distribution, rather than assuming every cost is an estimate:

- `pi-ai/dist/types.d.ts:308` documents `cost.total` as provider-reported billed cost when available, otherwise a catalog estimate; `totalFromProvider` distinguishes the two. The package README's telemetry table identifies its cost unit as USD (`pi-ai/README.md:1143`).
- `pi-coding-agent/dist/core/agent-session.js:196` emits cache-warming usage as `entry_appended`; `core/session-manager.d.ts:36` defines the usage entry. `core/agent-session.js:2627` emits `compaction_end` with optional summary usage.
- `pi-coding-agent/dist/modes/print-mode.js:96` serializes session events to JSON stdout; `modes/json-event.js:17` passes non-message-update events through.

These native paths are relative to `/Users/alvarogomez/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/`. Implementation tests must use committed fixtures, not require that local installation.

## Design Decisions

### Ownership and persistence

Keep the existing `AgentRunner` and `RunStore` ports. Runner adapters interpret native usage. Contracts define its portable meaning. The kernel accounts for an individual run; the factory composes its existing planning/execution relationships. No new module registry, telemetry service, price catalog, database table, or cost adapter is needed.

Persist observations, derive totals. Do not persist parent totals, reopen ended planning runs, or add a second parent relationship alongside `sourceRunId`. The logical work root is identified by the planning run ID; it is not another durable lifecycle.

```text
Work: planning run ID                         total = planning + executions
├── Planning run                             own cost
│   └── Step                                 sum of its attempts
│       ├── Attempt 1                         counted even if output rejected
│       └── Attempt 2                         counted independently
├── Execution run: PR 1                       own cost
│   └── Steps → attempts
└── Execution run: PR 2                       own cost
    └── Steps → attempts
```

### Portable measurements, with additive compatibility

In `payo/packages/contracts/src/primitives.ts`, retain the three existing scalar fields and add these schemas/types:

```ts
type CostBasis = "provider-reported" | "estimated";
type CostAmount = { currency: string; basis: CostBasis; amount: number };
type CostDetails = { amounts: CostAmount[]; complete: boolean };
// UsageRecord gains: costDetails?: CostDetails
```

- Currency is a validated uppercase three-letter code. Amounts are finite, nonnegative numbers in that currency's major unit, following the existing numeric representation. Do not round during accumulation or introduce a decimal dependency.
- `amounts` contains cumulative known subtotals, grouped uniquely by `(currency, basis)`, in deterministic `(currency, basis)` order. Separate currencies and pricing bases remain separate. No currency conversion or cross-currency scalar total is produced. There is no `"unknown"` basis: a cost with unknown provenance or currency contributes no amount entry and forces `complete: false`.
- `complete: false` means the amount is a subtotal: work is still running, an observed charge lacks usable cost/currency, or termination prevented a complete report. A final snapshot may set `complete: true` only on clean native settlement with usable amounts for all observed billable operations. A reported zero is an explicit amount entry with `amount: 0`; an empty array cannot establish completeness.
- All usage events are **replacement snapshots for the whole attempt**, never deltas. Adapters emitting native per-call deltas accumulate them first. Emit the final usage snapshot **before** the terminal `result` or `error`, because the kernel stops consuming at the terminal event.
- A missing cost does not discard earlier known amounts. The compatibility `cost` scalar becomes `"unknown"` when any cost is missing or currencies cannot be combined; when bases mix within one currency it sums them and remains non-authoritative. `costDetails.amounts` still retains the known subtotal and is authoritative for the new monetary query.
- Legacy records without `costDetails` remain valid and retain their raw scalar values. Their currency, pricing basis, and completeness are unknown. Do not assign USD based only on a historical runner ID; exclude unqualified legacy scalars from currency totals and mark that attempt incomplete.
- Token scalar semantics remain unchanged. Cache reads/writes remain included in `tokensIn`; do not add token pricing, token-category schemas, or model-by-model attribution in this slice. The existing `AttemptRecord.model` remains the requested model, not a claim about the actual billing model.

“Complete” means complete relative to the supported native reports through settlement. It does not mean an independently reconciled invoice. Provider-side activity the harness never reports remains unobservable.

### Core query contracts

Add `payo/packages/contracts/src/cost.ts` with Zod schemas and inferred types:

```ts
type CostSummary = {
  amounts: CostAmount[];
  coverage: "complete" | "partial" | "unknown";
  incompleteAttempts: number;
  attempts: number;
};
// Reuse AttemptRecord and StepRecord with Zod .extend(), rather than copy fields.
type AttemptCost = AttemptRecord & { cost: CostSummary };
type StepCost = StepRecord & { cost: CostSummary; attempts: AttemptCost[] };
type RunCostTree = {
  runId: string;
  status: "active" | "ended";
  outcome: string | null;
  asOfSeq: number;
  cost: CostSummary;
  steps: StepCost[];
};
```

Add the factory-owned result schema/type to `payo/packages/contracts/src/factory.ts`:

```ts
type WorkCostTree = {
  sourceRunId: string;
  planning: RunCostTree;
  executions: Array<{ prId: string; run: RunCostTree }>;
  total: CostSummary;
};
```

`planning.cost` is the planning run's own cost; `total` includes it once plus every execution's own cost. Aggregators consume either leaves or their disjoint parent summaries, never both. `attempts` counts included attempts, and `incompleteAttempts <= attempts`. Coverage is enforced by the schema: with no attempts, `{ amounts: [], coverage: "complete", incompleteAttempts: 0, attempts: 0 }`; otherwise, `incompleteAttempts === 0` means `complete` and requires a nonempty `amounts` (a complete attempt always reported at least one usable amount); `amounts.length > 0` with incomplete attempts means `partial`; an empty `amounts` with attempts means `unknown`. A step or run with no attempts incurred no Payo agent attempts. An explicit zero amount counts as a qualified observation. `sumCosts([])` returns the empty, complete summary.

Each attempt contributes at most one to `incompleteAttempts`, regardless of the number of missing native reports. Running, cancelled, timed-out, and interrupted attempts are incomplete. A failed output-validation attempt can have complete cost when its native session settled and reported it. Run lifecycle status and measurement coverage are separate: an active run may have complete accounting for finished attempts so far, while still doing more work later.

Export these schemas through `payo/packages/contracts/src/index.ts`. Existing consumers need no changes because fields are additive and no new agent event variant is introduced.

## Phase 1 — Normalize cost contracts and runner capture

### Overview

Make native cost reports portable and preserve known subtotals. Extend the Pi adapter through the existing runner contract, leaving orchestration unchanged.

### Tests — write first

- **Contract unit tests**, `payo/packages/contracts/src/agent.test.ts` and `run.test.ts`: accept legacy usage unchanged and enriched snapshots in both agent and persisted events; preserve zero; reject negative/non-finite amounts, malformed currencies, duplicate currency/basis buckets, an `"unknown"` basis, and empty amounts marked complete.
- **Cost contract tests**, new `payo/packages/contracts/src/cost.test.ts`: accept each new schema; reject coverage inconsistency (`complete` with incomplete attempts, `complete` with attempts but empty amounts, `partial` with no amounts, `unknown` with no attempts or with amounts, `incompleteAttempts > attempts`); reject unsorted `amounts`; reject a run tree whose step/attempt counts disagree with its summary.
- **Pi mapper unit tests**, `payo/adapters/runner-pi/src/index.test.ts`: two assistant calls yield cumulative replacement snapshots; missing cost preserves earlier known amounts; later known cost remains usable after a gap; `totalFromProvider: true` maps to provider-reported, while false/absent maps to estimated; native zero remains an explicit USD zero; an assistant message with no native usage produces no amount entry and `complete: false`, distinct from a native zero; the adapter's seeded initial `cost: 0` never becomes an amount.
- In the same mapper suite, cover assistant + compaction + cache-warming usage, missing summary usage, aborted settlement, final usage before terminal, and immutable snapshots. Count canonical native reports once: ignore `message_update`, `turn_end`, `agent_end`, and persisted compaction-entry copies; repeated usage-entry IDs do not add the same cache-warming charge twice. Assert the exact normalized event sequence for the aborted case: no complete snapshot after abort, and the last emitted usage precedes the terminal event.
- Reuse the existing spawn stub for one adapter-level JSONL replay assertion covering additional native usage forms and final event ordering. Do not start a billable model session.

### Changes

1. Implement `CostBasis`, `CostAmount`, `CostDetails`, and the optional `UsageRecord.costDetails` in `primitives.ts`. Add `CostSummary`, `AttemptCost`, `StepCost`, and `RunCostTree` in `cost.ts`, including the coverage/count refinements and sorted-`amounts` check; add `WorkCostTree` to `factory.ts`; export `cost.ts` from the contracts barrel.
2. Document cumulative replacement semantics and final-before-terminal ordering beside the usage variant in `contracts/src/agent.ts` and on `AgentRunner` in `kernel/src/agent.ts`. Keep `AgentSpec` and `AgentRunner.run` signatures unchanged.
3. In `runner-pi/src/index.ts`, extend `PiMapState` with `costDetails`, a missing-native-report flag, and seen standalone usage-entry IDs. Extend `addUsage` to retain monetary subtotals even after the compatibility scalar becomes unknown. Initialize `costDetails.amounts` empty: the seeded initial `cost: 0` is a placeholder, not a native report, and must never become a qualified zero. Add an amount only when a native report is parsed. Keep snapshots independent of later state mutation.
4. Extend `mapPiRecord` to account for assistant `message_end`, `compaction_end` usage, and `entry_appended` entries whose type is `usage`. Use these canonical sources only. Deduplicate standalone usage by native entry ID; do not deduplicate distinct calls by matching token or cost values.
5. Pi maps its documented cost unit to USD, and `totalFromProvider` to the portable basis. Emit incomplete cumulative snapshots as reports arrive, sorted by `(currency, basis)`. Immediately before `agent_settled` becomes a terminal event, emit the final snapshot; mark it complete only when settlement was not aborted, at least one usable amount exists, and no observed billable report is missing cost. On an aborted settlement, emit the final snapshot with `complete: false` when any report was observed, and otherwise rely on the last emitted snapshot; never emit a complete snapshot after abort. Process/parse failures leave previously emitted subtotals incomplete.
6. Keep existing token totals and tool/terminal behavior. Missing or malformed optional native cost becomes missing coverage; it must not erase successful model output. Invalid normalized cost from any runner still fails contract validation at the kernel boundary.
7. Add `runner-pi/src/fixtures/usage-accounting.jsonl` with representative Pi 1.5.0 assistant, compaction, and standalone usage reports, including canonical/copy forms. Update existing Pi assertions and `baseState` for the new metadata/final snapshot. Keep old JSONL fixtures as compatibility cases. `runner-fake` already replays `AgentEvent` and needs no implementation change.

### Success criteria

**Automated**, from the repository root:

```sh
rtk pnpm -C payo exec vitest run packages/contracts/src/agent.test.ts packages/contracts/src/run.test.ts packages/contracts/src/cost.test.ts adapters/runner-pi/src/index.test.ts adapters/runner-fake/src/index.test.ts
rtk pnpm -C payo exec tsc -p tsconfig.json
rtk pnpm -C payo exec biome check packages/contracts/src adapters/runner-pi/src packages/kernel/src/agent.ts
```

**Manual:** inspect the committed replay's expected normalized events: USD estimated and provider-reported buckets stay distinguishable; a missing report preserves the subtotal; the last usage precedes the terminal event. No live run is required.

### What we're NOT doing

No price lookup, inferred token-to-money conversion, provider billing integration, new runner, per-response tree, cache/reasoning token breakdown, or model/provider cost comparison.

## Phase 2 — Durable live accounting and restart-safe run rollups

### Overview

Retain the latest reported usage in folded state, persist usage promptly, and expose a pure run-cost projection. Recovery keeps known spend without claiming that an interrupted attempt was fully observed.

### Tests — write first

- **Reducer unit tests**, `payo/packages/kernel/src/state.test.ts`: a usage event updates only the relevant attempt through a fresh map; previous state is unchanged; other event types keep the existing sharing behavior; later cumulative snapshots replace earlier ones.
- **Recovery unit tests**, `kernel/src/run.test.ts`: observed usage survives recovery, enriched metadata becomes incomplete, a second recovery appends nothing, and a legacy all-unknown interrupted finish does not hide the prior recorded snapshot. No observation still produces existing unknown usage.
- **Agent-step unit tests**, `kernel/src/agent-step.test.ts`: one low-volume usage event reaches the store while the runner hangs, without waiting for 32 rows; timeout/cancel/throw preserves amounts but makes cost incomplete; invalid-output retry retains both attempts' costs; a valid native final snapshot stays complete even when output validation rejects its result. Preserve the existing terminal-versus-deadline race guarantees.
- **Projection unit tests**, new `kernel/src/cost.test.ts`: replacement snapshots plus final usage count once; terminal-only legacy histories remain readable; duplicate identical sequence rows and out-of-order delivery do not inflate totals; conflicting duplicate sequence rows and missing sequence numbers (gaps such as 1, 2, 4) fail; invalid lifecycle history fails through the reducer. Cover multiple steps, failed/retried attempts, unknowns, qualified zero, no attempts, `sumCosts([])`, multiple currencies/bases, deterministic ordering, attempt counts, coverage consistency, and no input mutation. Assert arithmetic with floating-point tolerance and reject non-finite accumulated sums.
- **SQLite integration test**, `adapters/store-sqlite/src/index.test.ts`: write a mixed legacy/enriched log with a running enriched attempt, close/reopen the real store, recover, and verify the known amount survives once with partial coverage. Reopening/recovering again changes no totals. This is the durable-storage check; do not repeat every aggregation edge case here.

### Changes

1. Change `reduce` in `kernel/src/state.ts` to retain usage from normalized usage events in `AttemptRecord.usage`, copying the attempts map only for that event. Terminal snapshots remain authoritative. For interrupted finishes, preserve prior observed values when the terminal recovery record supplies unknowns; retain prior cost details as incomplete. This fallback also makes already-written historical recovery records readable without rewriting them.
2. Change `recover` in `kernel/src/run.ts` to write the retained usage, with `costDetails.complete: false` when present, instead of replacing it with all unknowns. Preserve the current gate behavior and recovery idempotence.
3. In `streamAttempt` in `kernel/src/agent-step.ts`, flush after every usage event as well as terminal events and existing message batch thresholds. This makes completed usage observations durable promptly; it does not persist every token delta.
4. In `executeAttempt`, preserve the last snapshot for every outcome. Force its metadata incomplete only on the catch, cancellation, deadline, thrown validation, or end-of-stream-without-terminal paths. When `classify` returns a `result` (accepted or rejected) or a settled native `error`, retain the adapter's explicit `complete` flag; a settled native error with a complete final report may stay complete. Never promote an adapter's incomplete or absent metadata to complete, and never let a rejected structured output alone force incompleteness.
5. Add `kernel/src/cost.ts` with public functions `projectRunCosts(events: readonly RunEvent[]): RunCostTree` and `sumCosts(summaries: readonly CostSummary[]): CostSummary`. The projection sorts/deduplicates per-run sequence rows, rejects conflicting duplicates, then asserts `seq` is contiguous from 1..n and throws on any gap before folding. It uses `fold` for lifecycle validation and retained usage. It creates attempt summaries, step sums, then the run sum. `asOfSeq` is the last included sequence; step/attempt order follows their start events; amounts are sorted by `(currency, basis)`. `sumCosts([])` returns the empty, complete summary defined above.
6. Sum only same-currency/same-basis amounts, preserving separate buckets, sorting by `(currency, basis)`, and adding `attempts` and `incompleteAttempts`. Derive coverage by the stated rules and let the `CostSummary` schema refinement enforce them. Legacy scalar cost remains available on `AttemptCost.usage` but contributes no qualified currency amount. A native complete flag on a still-running/interrupted attempt cannot make its summary complete.
7. Export only `projectRunCosts` and `sumCosts` from `kernel/src/index.ts`. Keep any shared helper for marking usage incomplete internal to the kernel. Use existing `body`, `seqd`, and memory-store helpers in tests; add enriched usage locally to the relevant tests rather than changing every shared legacy fixture.
8. Add the single SQLite round-trip case to `store-sqlite/src/index.test.ts`; leave `SCHEMA_VERSION`, table definitions, and `RunStore` signatures unchanged.

### Success criteria

**Automated**, from the repository root:

```sh
rtk pnpm -C payo exec vitest run packages/kernel/src/state.test.ts packages/kernel/src/run.test.ts packages/kernel/src/agent-step.test.ts packages/kernel/src/cost.test.ts adapters/store-sqlite/src/index.test.ts
rtk pnpm -C payo exec tsc -p tsconfig.json
rtk pnpm -C payo exec biome check packages/kernel/src adapters/store-sqlite/src/index.test.ts
```

**Manual:** inspect the SQLite round-trip test's before/after snapshots: the interrupted attempt retains the same reported subtotal and changes only the expected lifecycle/coverage fields. No operator UI or paid invocation is required.

### What we're NOT doing

No new persistence engine, snapshots/cache tables, backfill of missing telemetry, import of old raw logs, background collector, OpenTelemetry, per-token writes, or change to retries/cancellation policy.

## Phase 3 — Factory work-cost tree and core query exports

### Overview

Compose the planning run and all stored execution children through the existing factory relationship. Expose the result as an ordinary core read operation that does not recover or schedule work.

### Tests — write first

- **Factory query unit tests**, new `payo/modules/factory/src/cost-read-model.test.ts`, using `createMemoryRunStore` and small valid factory run configs: planning-only work; ended planning plus two executions; duplicate run discovery; distinct executions with the same PR ID; unrelated runs excluded; mixed currency/provenance; partial/unknown child coverage; and deterministic execution ordering.
- Include retry/failed/interrupted attempts in fixtures to assert the factory joins each run exactly once; leave detailed attempt arithmetic to kernel tests. Distinct executions must remain separate by run ID, including differing approved-plan identities.
- Assert the query appends no events, creates no gates, reads no artifacts, invokes no runner, and handles a live child without recovery. Missing root gives `CommandError("not_found", ...)`; an execution or invalid factory config used as the root gives `CommandError("invalid_request", ...)`; a malformed run ID gives `CommandError("invalid_request", ...)` rather than the plain `Error` thrown by `validateRunId`. Corrupt discovered logs must fail the query rather than silently omit possible spend.
- Verify per-run `asOfSeq` is exposed. The work result is a read-time view, not a cross-run transactional snapshot; newly created children appear on the next query. No new full HTTP/CLI end-to-end test is needed for an unexposed core export.

### Changes

1. Add `modules/factory/src/cost-read-model.ts` exporting `readWorkCosts(store: RunStore, sourceRunId: string): Promise<WorkCostTree>`. Wrap the existing `validateRunId` in `CommandError("invalid_request", ...)` so a malformed ID has the same error type as other invalid roots. Require an existing planning config through `FactoryRunConfig`. Do not require the plan to be approved just to monitor its cost.
2. Discover run IDs once through `store.listRunIds()`, deduplicate them, read each log at most once, and reuse the root's already-read log. Identify execution candidates by their creation config's `kind: "factory-execution"` and matching `sourceRunId`, then validate matching candidates using `ExecutionRunConfig`. Include every matching stored execution, regardless of its outcome, PR duplication, or relationship to the latest plan artifact. Do not guess parentage from names, repository paths, or attempt IDs.
3. Project the planning and execution logs with `projectRunCosts`. Sort executions by run ID. Build `total` with `sumCosts([planning.cost, ...executions.map(child => child.run.cost)])`; no aggregate is added back to its own descendants. Parse the result with `WorkCostTree` before returning it.
4. Keep this query read-only: use `store.read`, not `openRun`, `openFactory`, or `openExecution`, because those can recover interrupted work. Surface storage/schema corruption; never label an omitted unreadable possible child as complete. Discovery scans logs through the existing port; record scanned log count and elapsed time in the factory query test, and add a one-line `shortcut:` comment naming the upgrade trigger: replace the scan with indexed lineage reads once history exceeds roughly 1,000 stored runs or a representative query exceeds roughly 250 ms.
5. Export `readWorkCosts` from `modules/factory/src/index.ts`. No server composition binding is needed: the query consumes the existing `RunStore` port directly. Do not alter planning/execution checkpoint shapes, scheduling callers, `sourceRunId`, or execution identity.
6. Update `docs/payo/engine-design.md` under Records/Durability with the cost hierarchy, cumulative/final snapshot contract, qualified subtotals and coverage, legacy behavior, read-time consistency, and the two core entry points: kernel `projectRunCosts` for one log and factory `readWorkCosts` for the whole flow. State that the current model field is requested-model provenance and that reported cost is not an invoice guarantee.

### Success criteria

**Automated**, from the repository root:

```sh
rtk pnpm -C payo exec vitest run modules/factory/src/cost-read-model.test.ts test/boundaries.test.ts test/factory-boundaries.test.ts
rtk pnpm -C payo exec tsc -p tsconfig.json
rtk pnpm -C payo exec biome check modules/factory/src/cost-read-model.ts modules/factory/src/cost-read-model.test.ts modules/factory/src/index.ts
rtk pnpm -C payo check
```

The final existing workspace gate also checks unchanged web/server consumers for additive-contract regressions. It does not expand implementation scope into the webapp.

**Manual:** inspect a fixture tree containing planning and two execution runs. Confirm planning cost is visible separately, the work total includes each execution once, failed attempts remain visible, each currency/basis is labelled, and unknown legacy cost remains available only as an unqualified leaf reading. No live paid run is an acceptance requirement.

### What we're NOT doing

No web screens, HTTP endpoint, CLI command, subscription transport, phase/review-round grouping, arbitrary recursive run framework, cross-planning-run work-item grouping, harness-owned subagent tree, spend limits, alerts, exports, or billing reconciliation.

## PR Strategy

1. **PR 1: Normalized reported cost** — Phase 1. Additive contracts and Pi extraction ship together; existing history and callers remain valid.
2. **PR 2: Durable per-run accounting** — Phase 2, after PR 1. Supplies the generic run projection and restart guarantees without depending on the factory query.
3. **PR 3: Factory flow query** — Phase 3, after PR 2. Adds the factory composition and documents its limits. It can be reverted independently without stopping capture.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Cumulative snapshots, terminal totals, or child totals are counted twice | Replace attempt snapshots; sum disjoint attempt/run summaries; deduplicate by run ID and per-run sequence. |
| A retry fails but still incurs cost | Include every started attempt regardless of outcome; do not calculate from accepted artifacts alone. |
| Crash loses the current call or in-memory observations | Flush completed usage reports immediately; preserve persisted subtotals; interruption is incomplete. A killed, unreported in-flight call remains unknown. |
| Pi reports internal work through different events | Commit representative assistant/compaction/usage-entry fixtures and designate canonical native reports. Do not parse raw logs in the query. |
| Native Pi changes event formats or omits provider-side work | Mark missing observed usage incomplete, retain raw capture for diagnosis, and document stream/version coverage. No invoice-level completeness claim. |
| Currency or pricing basis is lost or mixed | Qualified amount buckets, separate currencies/bases, no currency inference for old records. |
| Legacy clients see extra fields | Optional metadata and unchanged event variants preserve parsing; run the complete existing workspace gate. |
| Read consistency is overstated | Return each run's `asOfSeq`; document that discovery and reads are not atomic across runs. Repeat the query to see new work. |
| Discovering children becomes expensive | Scan through existing ports initially; record scanned-run count and query time in the factory test; introduce indexed discovery once history exceeds roughly 1,000 runs or a representative query exceeds roughly 250 ms. |
| Corrupt history causes an understated total | Fail discovery/projection rather than silently omit unreadable possible children; reject conflicting duplicates and non-contiguous sequence rows. This can temporarily block the query even for unrelated corrupt history. |

## Compatibility and Rollback

No SQL migration or historical event rewrite is required. New metadata is optional, and old enriched/unenriched rows can coexist. Keep the existing scalar fields for old consumers; new queries rely on qualified details and expose legacy readings without inventing their meaning.

Rollback removes query/capture behavior, not stored events. Existing schema readers ignore unknown optional fields while reading the original scalar fields; rollback does not preserve the new live/recovery accounting guarantees. Reapplying the feature rebuilds views from retained logs. Do not delete or rewrite captured metadata to roll back.

## Assumptions and Validation

- **Cost means model usage, not total infrastructure cost.** The query explicitly accounts for Payo agent attempts; local checks, Git, wall time, and external services have no monetary measurement in the current ports. Validate the documentation and empty-attempt tests against that wording.
- **Only the planning root and its stored execution children form one work flow.** A newly created planning run used to correct an old plan is a separate root, since no persisted relationship joins them. Validate discovery tests exclude unrelated planning roots rather than correlating by work-item text.
- **Pi 1.5.0 shapes are the initial adapter evidence.** Before implementation, recheck the active installation's `Usage`, settlement, compaction, and usage-entry shapes against committed fixtures. Adapt extraction locally if they changed; do not change the portable contract to encode Pi events.
- **A clean native final report can establish observation completeness, not invoice truth.** Validate the docs and tests distinguish complete stream coverage from provider billing reconciliation.
- **Current workspace changes may continue independently.** This plan references the inspected worktree. Recheck touched schemas and kernel/factory tests before implementation, preserve unrelated changes, and update line references if files moved.

## Implementation Progress

- [x] Phase 1 — normalized cost contracts and Pi capture; phase tests, tsc and biome passed.
- [x] Phase 2 — durable live accounting, restart-safe recovery and run-cost projection; phase tests, tsc and SQLite round-trip passed.
- [x] Phase 3 — factory work-cost query, core exports and engine docs; phase tests, tsc, biome and the full `pnpm -C payo check` passed.

## Planning Verification

Repository and installed-native-source inspection only. No production code changed, no test suite executed, and no billable run started while writing this plan. During implementation, write the named tests before code and run each phase's commands, then the final workspace gate.
