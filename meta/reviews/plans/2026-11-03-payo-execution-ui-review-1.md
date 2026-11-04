## Plan Review: Payo execution UI
**Verdict:** REVISE

The launch design follows the engine's approved snapshot and keeps the server authoritative. Two correctness gaps in the execution display would make evidence appear more specific than the existing read model permits; both need correction before implementing that display. This review records the original plan, before the targeted edits made alongside it.

### Coverage

- **Checked:** architecture, code quality, correctness, compatibility, security, simplicity, test coverage, accessibility and usability across execution navigation, launch, resume, and result presentation. Checked the relevant contracts, projections, engine transitions, and existing client patterns.
- **Checked:** documentation and operational safety at plan level; the plan covers the browser workflow and retained worktree without adding destructive operations.
- **Not applicable:** database migration and portability changes: the proposed design changes no persisted schema or deployment dependencies. Performance is covered by the existing debounced refresh and burst test; no separate performance change is proposed.
- **Unverified:** manual browser and restart scenarios and full test execution; this is a plan review, not implementation validation.

### Cross-Cutting Themes

Correctness, usability, and test coverage all depend on distinguishing current checkpoint state from the latest available evidence. Clear labels and transition tests avoid implying that older reports prove a current or final result.

### Findings

#### Major

- 🟡 **Correctness / Usability / Test Coverage — F1: Check-report absence is not represented** — **Location**: Design decisions and Phase 1, ExecutionView. The plan requires an explicit missing-report state, but `readExecutionSummary` initializes `checks` to an empty array whether the report is absent or contains no results, and the contract exposes only that array. The UI cannot distinguish those cases. Some damaged reports add an artifact warning, but this does not resolve absence versus a valid empty report. **Confidence:** high. **Consequence:** the promised state cannot be implemented reliably. **Smallest correction:** use an honest “No check results available” message for an empty array and retain warnings, or extend the projection with compatible availability metadata; test empty and damaged cases.

- 🟡 **Correctness / Compatibility / Test Coverage — F2: Current scope and round can mislabel older evidence** — **Location**: Design decisions and Phase 1, ExecutionView. The projection selects the latest check and review artifacts globally, while scope, round and unresolved counts come from the current checkpoint. After the last phase, the engine switches to final scope and clears current evidence before final checks exist (`execution.ts`, receipt transition); the latest reports can still be phase reports. “Latest” labels help but cannot establish provenance, and grouping those reports under final verification or associating their findings with the current round would be misleading. **Confidence:** high. **Consequence:** operators may mistake previous phase evidence for final verification. **Smallest correction:** display current scope and checkpoint values separately from latest reports, explicitly acknowledge unknown report scope, and test the transition; alternatively add reliable report provenance to the read model.

### Strengths

- ✅ Launch reads the same validated structured snapshot as the engine and leaves eligibility and duplicate acceptance to the server.
- ✅ The plan accounts for partial artifacts, reconnects, rejected resume, keyboard navigation, and retained results.

### Recommended Changes

1. Use an honest empty-checks state and test it with artifact warnings (F1).
2. Separate current checkpoint progress from latest reports, avoid assigning report scope without provenance, and test the phase-to-final transition (F2).
