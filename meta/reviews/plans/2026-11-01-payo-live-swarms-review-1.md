## Plan Review: Payo live swarms dashboard
**Verdict:** REVISE

The dashboard can reuse the existing event and navigation contracts, but polling does not guarantee timely agent activity: the producer buffers activity before it reaches the store. The plan also needs to distinguish freshness of run summaries from event freshness and account for the cost and partial-result behavior of the run-list endpoint.

### Coverage

- **Checked:** Architecture, code quality, simplicity and compatibility (feature boundaries, event API, cursor and existing callers); correctness and safety (event lifecycle, polling and ending); performance (run-list and event reads); security, standards, usability, test coverage and documentation (authentication, text rendering, accessibility and planned verification).
- **Not applicable:** Database migration and portability: the proposal changes neither persisted schema nor deployment platform. Existing database read behavior was checked for performance.
- **Unverified:** Runtime load and actual activity latency; conclusions below follow from the current code and require measurement where stated. This review does not execute the plan or assess an implementation that does not yet exist.

### Cross-Cutting Themes

- Freshness spans event production, event retrieval and the independently refreshed run list. A successful event poll alone cannot establish that activity, gates, stages or the run roster are current.
- Reusing existing endpoints keeps the change small, but their current behavior sets limits on responsiveness and recurring server work. A producer or summary change would expand scope; documenting a weaker freshness guarantee preserves the web-only scope.

### Findings

#### Major

- 🟡 **Correctness / Usability — F1: Activity can remain buffered for an entire attempt** — **Location:** Design Decisions: Live transport; Phase 1 success criteria. **Confidence:** high. The one-second requests read persisted events, but [`streamAttempt`](../../../payo/packages/kernel/src/agent-step.ts) buffers agent events until 32 rows, a terminal event, or iterator completion. A long-running attempt with fewer events can therefore show no new activity while it works. Attempt start is persisted immediately and full batches do appear, but neither guarantees timely activity. Decide whether delayed persisted activity meets the dashboard's goal. If it does, state the limitation and exercise a partial batch in verification; if timely activity is required, plan a bounded producer flush and integration test, acknowledging the expanded scope. **Effort:** small for clarified expectations; larger for a producer change.

#### Minor

- 🔵 **Correctness / Usability — F2: Summary freshness is separate from event freshness** — **Location:** Design Decisions: Honest freshness; Phase 1 polling and tests. **Confidence:** high. Stage, open gates, run discovery and ended status come from the run-list response, while activity comes from separate event requests. If the list refresh fails but event requests succeed, a card may appear live with an outdated stage or gate and missing runs. The existing [`App.tsx`](../../../payo/apps/web/src/app/App.tsx) shows a generic list error, but the plan does not connect it to the freshness of summary-derived information. Show list freshness separately or mark affected summary data stale, and test a failed list refresh and recovery while event requests succeed. **Effort:** small.

- 🔵 **Correctness — F3: A successful run list can omit a known run** — **Location:** Phase 1 polling lifecycle. **Confidence:** high. [`listRuns`](../../../payo/apps/server/src/composition.ts) catches individual summary failures and omits those runs from an otherwise successful response. Treating every absent run as removed can discard its live view or stop tracking it without a stale indication; a later successful refresh may restore it. The existing failure/retry requirement covers failed requests, but not this successful partial response. Define how a previously observed active run is retained and marked uncertain when absent, and test omission followed by recovery. **Effort:** small to moderate.

- 🔵 **Performance — F4: List polling rereads every run's history** — **Location:** Design Decisions: Live transport; Risks & Mitigations; Phase 3 verification. **Confidence:** high. Each list request calls `summaryOf` for every loaded run, and [`summaryOf`](../../../payo/apps/server/src/composition.ts) reads its entire history; the [SQLite store](../../../payo/adapters/store-sqlite/src/index.ts) parses the returned rows. Consequently the five-second list refresh repeatedly processes ended histories too, even with no active runs. Incremental per-run requests and the six-active-run check do not cover this accumulating cost. Add a representative long-history/many-ended-run measurement and define a response if the cost is unacceptable, such as adjusting cadence or separately planning a summary optimization. No throughput failure has been measured. **Effort:** small to measure; remediation depends on results.

### Strengths

- ✅ The existing `EventLog` advances a contiguous cursor and the server reads `fromSeq` inclusively, matching the proposed incremental approach.
- ✅ The planned feature location follows the existing web dependency boundaries, and started steps are distinguished from attempts that actually acquired a permit.
- ✅ Explicit details selection, literal text rendering, keyboard access, textual status and lifecycle tests address important disclosure and accessibility concerns.

### Recommended Changes

1. Decide and document the acceptable activity delay; add a partial-batch check or extend the implementation to flush activity within a defined interval (addresses: F1).
2. Specify separate summary freshness and behavior for a run missing from a successful list response, with recovery tests (addresses: F2, F3).
3. Measure recurring list refresh cost with representative retained histories and document the response to unacceptable results (addresses: F4).
