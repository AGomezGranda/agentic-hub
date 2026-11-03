## Plan Review: Prompt-driven plan revisions and version history
**Verdict:** REVISE

Immutable history and a checkpointed prompt are a sound basis, but the recovery and file-write boundaries do not yet preserve the working copy or reliably complete an accepted operation. Restores also affect rollback and displayed answers in ways the plan needs to address.

### Coverage

- **Checked:** Architecture, correctness, safety and test coverage across factory state, artifacts, file writes and recovery; compatibility and security across contracts, HTTP and CLI; usability, accessibility conventions, documentation, code quality and simplicity across clients. Performance was considered for history and comparison; no material issue was established.
- **Not applicable:** Database migration and deployment portability: the plan adds no schema or deployment change.
- **Unverified:** Runtime behavior and browser builds were not executed; this is a plan and source review.

### Cross-Cutting Themes

- **Durability and data safety:** Preserving history alone does not preserve the working copy or ensure an accepted operation finishes after a crash (F1, F2).
- **Version identity:** A restore changes persisted schema and answer state, affecting rollback and the web's representation of approval (F4, F5).

### Findings

#### Major

- 🟡 **Correctness / Safety: F1 — Protect every working-copy write** — **Location**: Phase 1, conflict handling — **P1; confidence: high.** The proposed hash check before replacement does not cover existing writes in `pause()` or when `PlanReview` raises approval (`payo/modules/factory/src/commands.ts:132` and `:306`). Agent failure can overwrite edits made during generation, and edits during the subsequent review can be overwritten on approval. The plan calls for failure coverage and a pre-replacement check, but does not specify protection for these writers. Extend conflict handling through failure, escalation and review; test edits during failed generation and during review. The acknowledged narrow external-editor race remains separate.

- 🟡 **Correctness / Safety: F2 — Make installation and recovery durable** — **Location**: Phase 1, pending operation and resume — **P1; confidence: high.** The plan clears pending state after saving the new version while checkpoint and working-file replacement are separate operations. If the process stops after checkpointing the new version but before installing its file, `openFactory()` escalates and ordinary `resume()` snapshots the old working file as a human version (`commands.ts:465`, `:535`). The requested result remains in history but ceases to be active. Persist enough progress to distinguish an uninstalled result from an external edit and recover both operation kinds through installation and review. Test interruption at each checkpoint/file boundary. Persisting the prompt covers generation retry, not this later window.

- 🟡 **Correctness: F3 — Start a new review cycle** — **Location**: Phase 1, prompt and restore transitions — **P1; confidence: high.** The concrete transitions do not reset the review round. `decideReview()` escalates a blocking finding at round 3 (`payo/modules/factory/src/state.ts:29`), while manual request-changes starts a new cycle at round 1 (`commands.ts:680`). A revision or restore from a high-round approval gate can escalate on its first blocking review instead of receiving normal revision attempts. Specify cycle increment and round reset for both operations and test from a high-round gate. “Fresh review” does not define this state transition.

- 🟡 **Compatibility / Safety: F4 — Correct the rollback contract** — **Location**: PR Strategy and Phase 1, `PlanVersion.source` — **P1; confidence: high.** The existing schema accepts only `agent`, `human` and `answer` (`payo/packages/contracts/src/factory.ts:141`); older engine code parses the current version with that schema. After a restore completes, rolling back the engine can make the current plan unreadable even with no pending operation. The new reader accepting old records protects upgrades, not rollback. Define a compatible representation or a specific rollback restriction and recovery procedure once restore versions exist, and verify it; amend the independent-revertibility claim.

- 🟡 **Usability / Correctness: F5 — Reconcile answer drafts after restore** — **Location**: Phase 3, history and restore — **P1; confidence: high.** The current screen retains local answer drafts and displays them ahead of server answers, while the saved indicator depends on the server answer (`payo/apps/web/src/features/plan-review/PlanReview.tsx:77`, `:406`). Restoring a version with a different answer for the same question can show an old draft as saved even though approval uses the restored answer. Reconcile drafts when the version or saved answers change, distinguish preserved unsaved text, and test save A → restore B → inspect and approve. Refreshing queries alone does not reset local state.

#### Minor

- 🔵 **Architecture / Compatibility: F6 — Provide browser-safe comparison reuse** — **Location**: Design Decisions and Phases 2–3, comparison — **P2; confidence: high.** `approvalDiff` is not exported from the factory package and imports hashing from `@payo/kernel`, whose store uses `node:crypto` (`payo/modules/factory/src/metrics.ts:1`, `payo/packages/kernel/src/store.ts:1`). The web app has no factory dependency, so direct browser reuse is not a viable specified integration. Extract the pure line comparison to a browser-safe shared export, or compute it on the server, and specify dependencies. The planned web build detects an invalid import but does not resolve the design choice.

### Strengths

- ✅ Immutable artifacts and a restore that appends a version preserve historical records.
- ✅ The plan identifies stale commands, external-editor races and backward-compatible checkpoint parsing, with focused integration scenarios.
- ✅ The coarse diff's limitations are disclosed, and the existing manual workflow remains available.

### Recommended Changes

1. Protect writes throughout generation, escalation and review; test edits during failure and review (F1).
2. Persist and recover the operation through installation and review; test interruptions around durable boundaries (F2).
3. Increment the cycle and reset the round for update and restore (F3).
4. Define and test rollback after restore versions exist (F4).
5. Reconcile answer drafts with restored answers and test approval after restore (F5).
6. Choose a browser-safe shared comparison or server-side comparison and wire its dependencies (F6).
