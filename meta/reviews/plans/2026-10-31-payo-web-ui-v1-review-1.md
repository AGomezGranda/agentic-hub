## Plan Review: Payo web UI v1 implementation

**Verdict:** COMMENT

The plan establishes useful server and factory boundaries and covers the main local workflows. Four nonblocking gaps affect how accurately the UI presents review context, its promised forward compatibility, and the cost and configuration of the implementation.

### Coverage

- **Checked:** Architecture, code quality, simplicity, security, correctness, safety, test coverage, compatibility, standards, usability, performance and documentation across all four phases and their server, factory, contract and client interfaces.
- **Not applicable:** Database migration and remote deployment: the plan adds no schema migration and excludes hosted access. Portability beyond the stated local environment is outside scope.
- **Unverified:** No implementation exists to run or assess visually; this review assesses the plan and current source, not dependency-specific build behavior.

### Cross-Cutting Themes

The UI needs to distinguish the plan currently displayed from the plan actually reviewed. This affects both decision accuracy and the tests needed for external edits and revisions. Separately, forward-compatible presentation depends on the API validation contract as well as the display component.

### Findings

#### Minor

- 🔵 **COR-1 — Correctness / usability: Identify which plan the findings review** — **Location:** Phase 3, Changes and Tests. **P2, high confidence; effort: medium.** The proposed view presents current markdown and the checkpoint's review together without requiring a version or staleness indication. A revision can replace `checkpoint.plan` while retaining the previous review until the next review finishes ([commands.ts](../../../payo/modules/factory/src/commands.ts#L280)); a user can also edit the working file after review. The findings may therefore appear to validate text they never assessed, including at an escalation. The plan acknowledges file races and displays unavailable artifacts, but neither identifies a stable version mismatch. Associate findings with the reviewed plan where evidence exists, and otherwise label their provenance as unknown or potentially stale; test revision and external-edit cases.

- 🔵 **COMP-1 — Compatibility / tests: Unknown stages are rejected before rendering** — **Location:** Design Decisions and Phase 2, Changes and Tests. **P2, high confidence; effort: small.** The plan promises to show unknown server-provided stage names, but the public `RunSummary.stage` uses the closed `FactoryStage` enum ([api.ts](../../../payo/packages/contracts/src/api.ts#L74), [factory.ts](../../../payo/packages/contracts/src/factory.ts#L94)), and the server validates that schema before responding. A future stage rejected by the schema never reaches the fallback; a component-only display test would miss this. Current stages work and future workflows are out of scope, so the consequence is forward compatibility rather than an immediate failure. Keep internal checkpoint validation strict, make the public display field accept unknown stage strings, and test response decoding and display.

- 🔵 **PERF-1 — Performance / tests: Coalesce event-driven refreshes** — **Location:** Design Decisions, event cursor and refresh; Phase 2. **P2, high confidence; effort: small to medium.** Refreshing summary and review after every event can repeatedly read the full event history and artifacts during active agent output: individual `attempt.event` rows are recorded ([agent-step.ts](../../../payo/packages/kernel/src/agent-step.ts#L259)), while each summary reads the run history ([composition.ts](../../../payo/apps/server/src/composition.ts#L184)). Query deduplication may reduce simultaneous requests but does not guarantee bounded refreshes over a burst. Coalesce invalidations or refresh on relevant state-changing events, retain reconnect/focus/command refreshes, and test that a burst converges to the latest gate without a request per event.

- 🔵 **BUILD-1 — Code quality / compatibility: Separate web and root TypeScript projects** — **Location:** Phase 1, Changes. **P2, medium confidence; effort: small.** The root configuration includes `**/*.ts` with NodeNext and Node types ([tsconfig.json](../../../payo/tsconfig.json)), so adding a separate browser configuration leaves web `.ts` files and Vite configuration in both projects. Depending on their imports and APIs, the root check can reject valid browser code or check it under different settings. Some files may compile under both configurations, so the precise failure depends on implementation. Exclude the web project from the root check or use equivalent project references, while retaining both checks in `check`.

### Strengths

- ✅ The read model stays inside the factory boundary, uses existing checked artifacts and avoids recovery as a side effect of reads.
- ✅ The plan preserves run-scoped authentication, validates CORS origins, treats rendered content as untrusted, and keeps the bearer token out of persistent storage.
- ✅ The plan explicitly handles unavailable artifacts, conflicts, reconnects, accessibility and the current terminal effect of approval.

### Recommended Changes

1. Add review-to-plan provenance or an explicit uncertainty label, with revision and external-edit coverage (addresses: COR-1).
2. Align the public stage schema and an end-to-end decoding test with the unknown-stage requirement (addresses: COMP-1).
3. Specify bounded event-driven refresh and a burst test (addresses: PERF-1).
4. Define non-overlapping TypeScript project coverage in the workspace check (addresses: BUILD-1).
