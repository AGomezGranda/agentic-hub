## Plan Review: Payo step 4 — factory slice 1 on fakes
**Verdict:** REVISE

The plan now addresses the prior review’s three findings: it snapshots the role instructions, records an in-flight marker across completed-step/checkpoint gaps, and tests recovery of multiple interrupted lenses. Fresh verification found two other P1 recovery windows: a run can be created before its first checkpoint, and a committed stage transition can leave the next operation without a marker or a way to resume. The factory flow otherwise follows the documented boundaries and has a strong layered test plan.

### Coverage
- **Checked:** Architecture, compatibility, correctness, security, safety, test coverage, code quality, and simplicity. Reviewed ownership, persistence/recovery, stage transitions, command behavior, path handling, contracts, and the planned unit/component/SQLite tests against the referenced engine/kernel contracts and current implementation.
- **Not applicable:** Database migration and UI usability/accessibility; no schema migration or UI is in scope. Performance is not a primary concern for this fake-backed slice.
- **Unverified:** Live adapter composition and exact-revision role-source resolution, live model behavior, and role quality on real tickets; the plan explicitly defers these to later roadmap steps.

### Cross-Cutting Themes
Durability currently covers interrupted operations only after a checkpoint marker exists. The event log must also leave every persisted nonterminal state with an explicit recovery path, including initialization and the interval between committing one stage and marking the next. No material tradeoff conflict between the reviewed lenses emerged.

### Findings
#### Major
- 🟡 **Correctness / Safety (P1, high) — DUR-001: Initial run can be stranded before its first factory checkpoint** — **Location:** Ownership and persistence; Phase 3 persistence tests. `start` persists `run.created` before appending the initial `factory-checkpoint-v1` event, while `openFactory` requires that checkpoint and fails if it is absent. A crash or failed append in that interval leaves a run that cannot be reopened through the factory API. The completed-planner crash test is useful counterevidence but starts after initialization and does not cover this gap. Make initial run state and checkpoint atomic, or make initialization safely reconstructable on open; add a fault-injection test after `run.created` but before the first checkpoint.
- 🟡 **Correctness / Safety (P1, high) — DUR-002: Stage transitions can persist without a resumable operation marker** — **Location:** Ownership and persistence; Phase 2 Changes and Phase 3 persistence tests. The plan clears the marker in the result/next-checkpoint batch, but does not specify how the next pending stage is made recoverable before its own marker is written. In the implementation, transitions such as FetchTicket → Plan persist `inFlight: null`, then the loop writes the Plan marker; `openFactory` only creates a recovery gate when `inFlight` exists, and `resume` accepts only Escalated runs. A crash between those commits leaves a nonterminal run with no gate and no supported command to continue it, contrary to the no-automatic-replay and explicit-resume contract. Preserve a pending-operation marker across the transition or have open/recovery gate markerless nonterminal stages for explicit resume; test a crash after a transition commit and before the next marker, then reopen and resume without launching agents during open.

#### Minor
- 🔵 **Test Coverage (P2, high) — TC-001: Acquisition-failure behavior is not tested at the factory boundary** — **Location:** Phase 2 Changes and Tests first. The plan requires ticket/workspace acquisition failures to persist Escalated with a resumable stage, but the listed component tests cover planner/agent failure and cancellation, not rejection from `TicketSource.get` or `Workspace.create`. The implementation catches these errors, but without seam-specific tests a regression could lose the resumable stage or mishandle idempotent workspace creation. Add focused tests for both rejecting fakes, checking the recorded stage/reason and explicit resume behavior.
- 🔵 **Correctness (P2, high) — DOC-001: Validation disclaimer conflicts with recorded implementation progress** — **Location:** Plan validation. The plan says Phase 1–3 checks passed and all phases are complete, but the final sentence says this change does not claim the tests have been implemented or run. That leaves readers unsure which verification status applies. Remove or qualify the disclaimer so it clearly distinguishes the plan’s validation from the implementation progress recorded above.

### Strengths
- ✅ Keeps kernel ports, factory policy, and server composition in the documented dependency direction, while reusing the existing run log, agent-step, limiter, and artifact seams.
- ✅ Uses structured review findings/verdict coverage and treats failed lenses as unchecked rather than clean.
- ✅ The prior recovery, provenance, and multi-lens concerns are concretely reflected in the plan and corresponding tests; SQLite is reserved for persistence and filesystem boundaries rather than duplicating all policy tests.
- ✅ Path validation, immutable plan/role artifacts, explicit approval behavior, and cleanup retry rules make important trust and data-preservation assumptions visible.

### Recommended Changes
1. Make the initial factory checkpoint atomic with run creation or safely reconstructable on reopen, and test the pre-checkpoint crash window (DUR-001).
2. Specify recovery for persisted nonterminal stage transitions with no in-flight marker, and test explicit resume after that transition boundary (DUR-002).
3. Add component tests for ticket-fetch and workspace-create failures, including resumability (TC-001).
4. Reconcile the Plan validation disclaimer with the completed implementation progress (DOC-001).
