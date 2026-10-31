## Plan Review: Payo step 4 — factory slice 1 on fakes
**Verdict:** REVISE

The proposed boundaries and persistence tests fit the existing kernel, but the plan leaves a crash window without the promised recovery gate and does not bind recorded role provenance to the instructions actually used. Both need resolution before implementation; concurrent review recovery also deserves a targeted test.

### Coverage

- Checked: architecture, compatibility, code quality, correctness, security, safety, test coverage and simplicity across contracts, commands, roles, persistence and recovery.
- Not applicable: UI accessibility and database migration (no UI or schema migration in scope); performance is not a primary concern for this fake-backed slice.
- Unverified: live adapter behavior and real role quality, explicitly deferred to later roadmap steps.

### Cross-Cutting Themes

Durability and provenance both depend on binding recorded state to the work actually performed. The proposed checkpoints and recorded SHAs provide useful history, but need explicit rules for the gaps identified below.

### Findings

#### Major

- 🟡 **Correctness / Safety — C1: Recovery misses the completed-step checkpoint gap** — **Location**: Ownership and persistence; Phase 2 commands and recovery. **P1, high confidence.** `runAgentStep` commits a successful step finish before returning its output; the factory then saves the plan and next checkpoint. A crash between those writes leaves the prior checkpoint but no running kernel step for `recover` to gate. The promised blocked state and explicit resume are therefore not ensured, and the result may be lost without an actionable recovery path. The pre-work checkpoint identifies the stage but the plan does not say how reopening detects this window. Record an in-flight operation durably and have `openFactory` detect and gate it independently of running kernel steps; test a crash after step completion and before the result checkpoint.

- 🟡 **Architecture / Compatibility — A1: Recorded role SHA does not pin executed instructions** — **Location**: Human edits and commands; Phase 2 roles. **P1, high confidence.** The configuration freezes a path and SHA, but `renderInstructions` only instructs the agent to follow the path. If the file changes before a later attempt or resume, the old SHA can be recorded while different instructions run. A nonempty SHA and frozen configuration alone do not bind content. Snapshot and use the skill content, or verify its actual version before each attempt and gate mismatches. Specify how the skill is accessible from a target workspace in another repository, and test a skill change before resume.

#### Minor

- 🔵 **Test Coverage — T1: Concurrent fan-out recovery is untested** — **Location**: Phase 2 and Phase 3 tests. **P2, high confidence.** Kernel recovery can create several gates for interrupted lens attempts, while factory resume must reconcile owned gates and reject unrelated ones. The planned interrupted-planner test and generic kernel tests do not exercise this combined factory policy. Add a persistence test interrupting multiple review lenses, reopening, and checking owned gates and running steps are cleared while an unrelated gate blocks advancement.

### Strengths

- ✅ Kernel ports and server-level composition tests follow the documented dependency boundaries.
- ✅ SQLite reopen, failed-lens and reconstructable-diff tests target important persistence and correctness boundaries.

### Recommended Changes

1. Specify a durable operation marker and reopening behavior for the completed-step crash window, with a fault-injection test. (C1)
2. Bind each attempt to the recorded skill content and define access from target workspaces; test changed content on resume. (A1)
3. Add a multi-lens interrupted-recovery test covering owned and unrelated gates. (T1)
