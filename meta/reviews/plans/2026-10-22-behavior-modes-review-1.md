## Plan Review: Exclusive persistent behavior modes

**Verdict:** APPROVE

Reviewed on 2026-10-22. The plan extends the existing persistence engine with explicit mode identity while retaining its file-preservation and partial-failure contracts. The controller, frontend, profile, and acceptance requirements agree; no confirmed P0, P1, or P2 findings remain within the reviewed scope.

### Coverage

| Lenses / plan areas | Result |
|---|---|
| Architecture, Code Quality — controller ownership, normalized block, fixed profile registry, caller migration, phase boundaries | Checked against the full plan, `coach.py`, `agents.py`, CLI/TUI callers, fixtures, package configuration, and historical Coach/TUI plans. One controller owns persistence; frontends consume observed state. No confirmed findings. |
| Correctness, Safety, Security — parsing, mode identity, provenance, malformed input, private bytes, aliases, concurrent edits, partial failure | Checked against `coach.py` and the complete controller safety suite. The plan preserves effective-target reconciliation, deferred shadowed cleanup, independent writes, ordinary permission bits, and source-independent Off. It adds rejection of conflicting formats and unknown identifiers without exposing personal instruction text. |
| Compatibility, Portability — Coach framing and commands, installed defaults, existing host resolution, rollback | Checked against current code, README, existing tests, and historical design/review evidence. Legacy framing stays current and idempotent; CLI syntax is preserved with the output change disclosed. Downgrade instructions require cleanup with the mode-aware controller. No new host discovery rules are proposed; upstream loader behavior was not independently revalidated. |
| Correctness, Usability, Standards — CLI results, pending selection, menu keys, focus, workers, narrow terminals | Checked against `cli.py`, `tui.py`, frontend tests, README, and installed Textual Select source. The proposed native widget supports empty selection, change events, expanded state, compact presentation, and menu handling. The plan distinguishes selection from installation and specifies the relevant keyboard, focus, busy-state, and 40×16 acceptance checks. |
| Test Coverage — controller matrix, frontend boundaries, isolation, package resources | Checked against `test_coach.py`, `test_cli.py`, `test_tui.py`, `conftest.py`, and the planned scenarios. Existing preservation tests are adapted, mode-specific regressions are added at the responsible layer, and the wheel must contain all four authored profiles. Frontend tests do not repeat the controller's filesystem matrix. |
| Documentation, profile correctness — role boundaries, exceptions, exits, persistence, operating instructions, acceptance | Checked against the full concept document, packaged Coach profile, README, and all three implementation phases. Coach restrictions are preserved. Each new role has a distinct tool contract, and runtime probes cover routine follow-ups, conflicting requests, bounded exceptions, explicit exits, and unauthorized writes. |
| Implemented parser/frontends, built wheel, rendered geometry, live model compliance | Unverified: implementation has not occurred as part of this review. These are explicit future acceptance requirements, including recorded unavailable harnesses. No test, packaging, visual, or live-harness pass is claimed here. |
| Database | Not applicable: no database, schema, or query changes. |
| Performance as a separate lens | Not applicable: four local instruction targets and four fixed profiles introduce no meaningful load path. Inspection remains excluded from selection previews and ordinary Skills navigation. |
| Authentication / network integration | Not applicable: no new authentication flow or network service. Review of security is bounded to file integrity, input handling, and diagnostic privacy. |

No prior review exists for this behavior-modes plan. Two bounded reviewers independently covered controller safety and frontend interactions; the parent checked their conclusions against the plan and relevant source, and reviewed profile/documentation fidelity. The historical Coach review's shared-target finding is addressed by the current implementation and explicitly preserved here.

### Cross-Cutting Themes

Observed identity is the common contract across persistence, status aggregation, CLI exit rules, and the TUI indicator. The plan requires both the requested mode and current freshness for success, retains observed modes with operation errors, and prevents a pending selector value from becoming evidence of installation.

File preservation and recovery reinforce each other: switching replaces one owned span, malformed or competing blocks remain untouched, successful independent writes survive failures, and retry/Off operate on inspected state. The effective physical-target union continues to protect a block required by another host.

There is an explicit compatibility tradeoff: Coach command syntax remains, while its output becomes mode-aware and `coach off` clears any primary role. The plan documents these effects. Conversational flexibility also remains distinct from persisted defaults: a chat-local exception or exit changes the conversation without changing host files. No unresolved conflict between the reviewed lenses requires a product decision.

### Findings

#### Critical

None confirmed.

#### Major

None confirmed.

#### Minor

None confirmed.

### Strengths

- ✅ A normalized owned span and fixed registry extend the existing controller without adding a second state store, profile loader, or host-specific mode fields.
- ✅ Legacy Coach framing, created-file provenance, missing-source removal, shared targets, and detectable concurrent-edit checks remain explicit acceptance contracts.
- ✅ The selector separates preview from installation, retains pending choices, and distinguishes Off from empty selection; worker completion respects page and focus state.
- ✅ Each phase leaves existing Coach entry points functional and reports non-Coach installations accurately before the selector is available.
- ✅ Planned tests target mode identity, parser conflicts, source failures, frontend event boundaries, and short-terminal access at the appropriate layers.
- ✅ Runtime probes assess the authored roles separately from filesystem tests and require honest reporting of unavailable harnesses.

### Recommended Changes

No plan corrections are required before implementation. Execute the three phases and their existing acceptance checks, including wheel-resource inspection, rendered selector checks, and recorded per-harness behavior probes.

The plan and feature code are unchanged. A later plan revision can be re-reviewed by appending a dated pass here, covering the affected lenses and interfaces.
