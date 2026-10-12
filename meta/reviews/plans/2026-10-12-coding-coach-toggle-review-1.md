## Plan Review: Persistent coding coach toggle in the CLI and TUI

**Verdict:** REVISE

Reviewed on 2026-10-12. The plan fits the existing CLI/TUI structure and specifies careful instruction-file preservation, truthful status, and focused regression coverage. One confirmed P1 needs correction: a block required by one host can be classified as shadowed by another, so the enable cleanup and status rules need an explicit shared-target exception.

### Coverage

| Lenses / plan areas | Result |
|---|---|
| Architecture, Code Quality — controller boundary, package resource, CLI/TUI callers | Checked against the full plan, `agents.py`, `catalog.py`, `cli.py`, `tui.py`, `__init__.py`, and `pyproject.toml`. No confirmed findings. |
| Correctness, Safety, Security — owned spans, UTF-8, malformed markers, symlink/hardlink handling, atomic writes, detectable edits, shared targets, recovery | Checked. One shared-target contract finding below. Review covers personal-file integrity and input validation; no authentication or network feature is introduced. |
| Test Coverage — controller cases, frontend regressions, fixtures, wheel contents | Checked against the full referenced tests. Existing fake-host fixtures and home isolation are explicitly addressed; shared effective/shadowed roles need an additional regression. |
| Compatibility, Portability — default host discovery, documented roots, precedence, supported-layout boundaries | Checked against the cited primary documentation/source. Codex's global nonempty-file precedence matches [official OpenAI documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md). Pi's candidate ordering matches its [resource loader](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts#L172). |
| Standards, Usability — CLI exit behavior, focus/filter bindings, empty states, narrow terminals | Checked. The plan specifies relevant automated and manual checks; no confirmed frontend defect. |
| Documentation — state meanings, restart requirement, scope, recovery, instruction-only behavior, acceptance exercise | Checked against the plan and README. Runtime compliance is appropriately distinguished from installed state. |
| Exact environment-value parsing | Unverified for a literal `~` inside Claude's `CLAUDE_CONFIG_DIR` and OpenCode's `true` flag value. Claude's [directory documentation](https://code.claude.com/docs/en/claude-directory) establishes relocation without specifying that parser; OpenCode's [rules documentation](https://opencode.ai/docs/rules/) documents `1`, and source retrieval did not establish `true`. Next probe: check these values against the installed versions using disposable roots. These evidence gaps are not confirmed defects. |
| Harness execution, actual wheel contents, implemented TUI behavior | Unverified: this is a plan review, and the feature has not been implemented. The plan already requires build, frontend, and per-harness acceptance checks, including OpenCode on a machine where it is installed. |
| Database | Not applicable: no database or schema change. |
| Performance | Not applicable as a separate lens: a bounded local-file toggle has no meaningful load path; the plan explicitly keeps inspection out of skill navigation/filtering. |
| Authentication / secrets integration | Not applicable: no new authentication flow. The acceptance exercise explicitly keeps credentials out of the repository and reports. |

There was no prior review for this plan. Three bounded reviewers covered file safety, frontends/tests, and non-Codex host compatibility; the parent verified the merged finding against the plan, official discovery documentation, and a temporary-file alias check. No implementation, personal instruction files, or existing untracked work was changed.

### Cross-Cutting Themes

Correctness, Safety, and Compatibility identify the same concern: physical-path deduplication prevents repeated writes but does not reconcile a file that is effective for one host and shadowed for another. This is one finding, with Test Coverage identifying the missing regression for it.

Shadowed-block cleanup prevents old coaching from returning after an override disappears; preserving shared effective blocks keeps another host coached now. Preserve cleanup for paths no host needs, and retain blocks required by any host's effective file. This resolves both goals without per-host markers or an additional state store.

### Findings

#### Critical

None confirmed.

#### Major

- 🟡 **Correctness / Safety / Compatibility — COACH-1: Preserve blocks required by another host's effective file.** **Severity:** P1. **Confidence:** high. **Location:** “Persist through the instruction files themselves” ([line 79](/Users/alvarogomez/code/python/agentic-hub/meta/plans/2026-10-12-coding-coach-toggle.md:79)); “Own a marked section,” steps 6–7 ([line 159](/Users/alvarogomez/code/python/agentic-hub/meta/plans/2026-10-12-coding-coach-toggle.md:159)); Phase 2 requested postconditions ([line 276](/Users/alvarogomez/code/python/agentic-hub/meta/plans/2026-10-12-coding-coach-toggle.md:276)).

  **Violated contract:** Enabling all hosts must keep the current profile in each effective file and allow all four hosts to report `on`. The current rules also require removing shadowed owned blocks and treating their presence as stale, without exempting a block still required by another host.

  **Concrete consequence and rationale:** With existing native OpenCode `~/.config/opencode/AGENTS.md` and Claude `~/.claude/CLAUDE.md`, Claude needs its block in the latter while OpenCode regards it as its shadowed fallback. These roles follow [Claude's user-instruction scope](https://code.claude.com/docs/en/memory) and [OpenCode's documented global precedence](https://opencode.ai/docs/rules/). Applying the cleanup rule literally can turn Claude off; retaining the block under the strict status rule can leave OpenCode stale and make `coach on` fail its all-host postcondition. The same concern applies to supported symlinks: a temporary-file check confirmed that Pi's effective `AGENTS.md` can resolve to Codex's shadowed `AGENTS.md` while Codex selects its nonempty override. The plan needs a reconciliation rule rather than leaving the implementer to infer an exception.

  **Counterevidence considered:** The plan resolves all targets first, recognizes shared fallbacks, deduplicates physical paths, rereads actual state, and reports unmet postconditions. Those safeguards prevent repeated writes and false success, but do not choose between opposing install/remove intents. “Leftover” could implicitly mean only an unneeded block; that interpretation needs to be explicit in both mutation and status rules.

  **Smallest sufficient correction:** Compute the union of effective physical targets across the supported hosts before mutation. Enable/refresh those targets once; remove shadowed blocks only from paths outside that union. A block shadowed for one host but required by another must not make the first host stale. Disable still removes every valid owned block once. Specify conservative handling when a host's resolution fails so cleanup does not assume its shared candidates are unused.

  **Effort:** Small plan edits to the state definitions, cleanup rules, and controller tests; implementation can reuse the already-required resolution/deduplication pass.

#### Minor

None confirmed.

### Strengths

- ✅ One packaged profile and one controller keep both frontends consistent while leaving skill discovery and installation semantics intact.
- ✅ Byte-preserving owned spans, created-file metadata, invalid-input rejection, atomic replacement, and identity/byte rechecks form a coherent preservation contract within the stated concurrency limits.
- ✅ Disable works without the source resource; per-host errors, postcondition checks, and reread state support partial-failure recovery without a second saved boolean.
- ✅ Tests cover home isolation, malformed files, idempotence, missing resources, frontend persistence, filter typing, empty skill grids, and package-resource delivery.
- ✅ Restarted-chat acceptance distinguishes observed model behavior from installed instructions and explicitly requires an OpenCode runtime check.

### Recommended Changes

1. Amend the `on`/`stale` definitions and enable cleanup rule to preserve any physical path required by another host's effective instructions. Keep disable's all-candidate removal behavior, and define conservative cleanup around unresolved hosts. (Addresses: COACH-1.)
2. Add a controller regression with both native OpenCode instructions and Claude instructions: repeated enable must keep both blocks and report both hosts `on`; disable must remove both while preserving user bytes. Include the equivalent cross-host symlink role conflict in the existing alias cases. (Addresses: COACH-1.)

The plan remains unchanged pending the user's choice of revisions. A re-review should cover shared-target mutation/status, resolver aliases, failure handling, and CLI/TUI postcondition reporting, then append a dated pass to this review.

## Re-Review (Pass 2)

**Date:** 2026-10-12
**Verdict:** APPROVE

The user requested fixes, and targeted edits have been applied to the plan. COACH-1 is resolved: the same union of effective physical targets now governs enable writes, cleanup eligibility, and status classification. The affected plan contracts have adequate completed review coverage; implementation and runtime verification remain future acceptance work.

### Changes Applied

- A block shadowed for one host but effective for another survives enable cleanup and does not make the first host stale. Profile drift is attributed to hosts actively selecting that file; reading and marker errors still reach every affected host.
- Enable cleanup removes only blocks outside the union of effective targets. If any candidate set cannot be fully resolved and validated, all shadowed cleanup is deferred while independently validated effective targets can still update. Errors and potentially leftover blocks remain visible, and retry or explicit disable retains the existing recovery contract.
- The controller test plan now covers native OpenCode alongside Claude, repeated enable, fallback drift, fresh inspection after a failed mutation, cross-host symlink roles, deferred cleanup, retry, and byte-preserving disable. Existing CLI/TUI lifecycle scenarios also verify all-on/all-off outcomes for the native OpenCode/Claude layout.
- README requirements and the risk table now explain shared-block preservation and deferred cleanup. Controller and frontend interfaces are unchanged.

### Coverage

| Affected lenses / interfaces | Result |
|---|---|
| Correctness, Safety, Compatibility — physical identity, effective/shadowed roles, state classification, cleanup, aliases | Checked against the full revised plan and the original finding. Both the default Claude/OpenCode layout and Pi/Codex alias scenario satisfy the new rule. |
| Correctness, Safety — incomplete resolution, validation failures, partial writes, error retention, retry, disable | Checked. Incomplete knowledge cannot authorize shadowed-block deletion; preserved operation errors and stale blocks prevent false all-host success. |
| Architecture, Code Quality — controller ownership and frontend coupling | Checked. Reconciliation remains in the existing planned controller; no new registry, state store, per-host marker format, or frontend ownership logic. |
| Test Coverage — controller regressions, failure cases, CLI exit/status, TUI persistence/display | Checked. The added cases cover the original defect and the newly affected failure/status boundaries without a new test layer. |
| Documentation, Usability — status explanations, partial success, recovery | Checked. The operating instructions now explain why a needed shared block is retained and why cleanup may be deferred. |
| Unchanged harness precedence and source evidence | Reused from pass 1; no loader or root-selection rule changed. |
| Exact environment parsing, implemented behavior, wheel contents, live harness acceptance | Still unverified as recorded in pass 1. No implementation or harness-runtime pass is claimed. |

Two bounded reviewers rechecked safety/state/compatibility and frontend/test/documentation contracts. The parent verified their conclusions against the amended plan, including the distinction between fresh inspection and retained mutation errors.

### Finding Comparison

| Finding / previous title | Result | Evidence |
|---|---|---|
| COACH-1 — Preserve blocks required by another host's effective file | Resolved | Shared-target state definitions, enable cleanup steps 6–8, native OpenCode/Claude and alias tests, failure recovery cases, and CLI/TUI lifecycle expectations now agree. |

### Findings

No new confirmed P0, P1, or P2 findings within the affected scope.

### Remaining Verification

Run the plan's controller, CLI/TUI, packaging, and per-harness acceptance checks during implementation. The earlier environment-parser evidence gaps remain explicit rather than being treated as passed.

Only the implementation plan and this review were edited. Feature code, live personal instructions, and the separate clear-document companion were left untouched.
