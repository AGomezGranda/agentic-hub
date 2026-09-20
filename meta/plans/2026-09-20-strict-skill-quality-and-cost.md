---
date: 2026-09-20
title: Strict evidence-based skills with adaptive cost and portable workflows
status: draft
---

## Objective and decisions

Improve the quality and reliability of the seven repository-owned skills while reducing duplicated investigation, unnecessary delegation, and user interruptions. Code-quality audits should be strict about coverage and consequences, with equally strict standards for evidence and counterevidence.

The user accepted the preceding review's recommendations and requested an explicit implementation plan. They will remove the external `tdd` skill: this plan must work without that skill on any host. Do not remove or modify that local installation as part of implementation.

Decisions for this draft:

- Keep all four installation targets: Pi, Claude Code, Codex, and OpenCode. Use capabilities actually available in the running host. A missing custom agent or external skill must not prevent core work.
- Keep the existing native Codex skill installation work. The working tree, not older plans' host tables, is the implementation baseline.
- Keep strong judgement on the parent/reviewer; use inexpensive discovery only for bounded inventory and location questions. Do not change model pins or user-level settings in this project.
- Use one investigator for small scopes; delegate independent code areas for larger scopes. Add specialist passes only where risk or unresolved evidence justifies them.
- Include a small, manually executed behavioural evaluation set. This follows the current request for all review proposals and supersedes the earlier plan's no-evaluations decision. No paid CI evaluation service or automated multi-provider runner.
- Keep the current installer design and fan-out marker. Shared workflow contracts stay in the skill; host dispatch and output mechanics stay in the host branch. Avoid a new configuration framework.
- Preserve audit-only behaviour unless the user has also explicitly requested fixes. Respect existing authorisation rather than demanding the same approval twice.

## Verified starting point

Paths below are relative to the repository root; line numbers refer to the working tree reviewed on 2026-09-20.

| Evidence | Current problem |
|---|---|
| `skills/code-quality-audit/SKILL.md:75` | Malformed child output becomes a P1 code finding. The same policy appears in testing and plan review. |
| `skills/code-quality-audit/SKILL.md:146` | Index-only inspection is mixed with verification, and thin evidence can itself become a finding. |
| `skills/code-quality-audit/SKILL.md:158` | Findings across every dimension are declared implausible, biasing the report toward artificial balance. |
| `skills/code-quality-audit/SKILL.md:169` | Repository conventions can become the quality ceiling rather than context for a systemic finding. |
| `skills/code-quality-audit/references/ddd.md:23` | The good example exposes mutable aggregate state and still permits the prohibited operation. |
| `skills/code-quality-audit/references/typing.md:31` | The good example omits what makes exhaustiveness checking enforceable. |
| `skills/review-plan/SKILL.md:27`, `:68` | Four or five lenses are the default; exactly one P1 has no verdict mapping. |
| `skills/research-codebase/SKILL.md:121` | Not locating something is promoted to a claim that it is absent. |
| `skills/testing-strategy/SKILL.md:83` | Testing style alone becomes a defect, independently of behaviour covered. |
| `skills/implement-plan/SKILL.md:21`, `:29` | Phase-wide test-first wording and routine pauses need a precise, self-contained incremental workflow. |
| `skills/_shared/fanning-out/opencode.md` | Assumes context can be closed/evicted, refers to other hosts' mechanics, and drops async coverage first. |
| `src/agentic_hub/agents.py:16` | All four current targets use native directories; marked skills receive spliced host prose and linked siblings. |
| `tests/test_skills.py:235`, `:255`, `:326` | Tests encode the old verification tiers, pointer-only output, and minimum rubric length. They do not establish output quality. |

Existing uncommitted changes when planning: `README.md`, `skills/_shared/fanning-out/codex.md`, `src/agentic_hub/agents.py`, `tests/test_agents.py`, and `tests/test_skills.py`. Preserve these edits and add targeted changes on top; do not reset, stash, or recreate their migration from an older plan.

Historical context: `meta/plans/2026-09-20-pi-first-skill-cost-and-rubrics.md`. Its claims that Codex lacks native skills/subagents and its index-only verification policy are superseded here. Preserve the historical document rather than rewriting its completed history.

## Execution and baseline

Before Phase 1, record the working-tree diff and run `uv run pytest -q`. Record existing failures separately. Capture current outputs for the fixed cases listed in Phase 5 before editing any skills: this is the baseline, even though the reusable case documentation is delivered in Phase 5. Save exact prompts, fixture revisions, generated host skill text, model/reasoning settings, outputs, and available usage metadata. Do not equate a historical git commit with this dirty working-tree baseline.

Implement phases incrementally. For real Python behaviour changes, write one focused failing test, implement it, and run it before moving to the next behaviour. Prose edits need structural checks and human/behavioural review, not tests that merely repeat each sentence. Never claim that a content test proves a model obeys the instruction.

## Phase 1 — Strict evidence, severity, and coverage

### Overview

Make confirmed findings trustworthy and incomplete coverage explicit. Apply the same reporting semantics to parent and child reviewers.

### Changes

Edit `skills/{code-quality-audit,testing-strategy,review-plan,research-codebase}/SKILL.md` and `agents/{cq-dimension,test-level,plan-lens,repo-scout}.md`.

1. Replace malformed-output-to-P1 with: normalise recoverable fields; request one targeted correction if necessary; if still unusable, report an investigation failure and its uncovered scope. Never manufacture a defect or severity from missing formatting. Avoid an unbounded retry loop.
2. Define a confirmed finding as: stable finding ID, severity, confidence, location and evidence, violated contract/constraint, concrete consequence, counterevidence considered, and smallest sufficient correction. Keep it compact; these need not become eight verbose paragraphs. IDs distinguish multiple findings at the same location and survive deduplication.
3. Candidate summaries/indexes are navigation aids only. Before publishing a finding, inspect its full rationale and enough original code, callers, configuration, or tests to establish the claim. Expand reads when the contract is unclear; whole-file rereads are not automatically required. A checked quotation alone is insufficient.
4. Keep an internal candidate disposition: confirmed, rejected, or unresolved. Only confirmed findings enter the prioritised defect list. Unresolved concerns name the missing evidence and next probe. Do not publish a dump of rejected candidates.
5. Coverage ledger: list in-scope areas and applicable dimensions/lenses as checked, not applicable with reason, or unverified with reason. An unverified area is never described as clean. Scope may be bounded, but the report must say what was excluded or sampled.
6. Remove assertions that findings everywhere are implausible. Positive findings require a bounded claim and evidence; there is no quota for strengths or defects.
7. Treat repository conventions as context. Group a systemic problem once with representative instances and affected scope, while keeping independent root causes separate. Consistency does not excuse harmful practices.
8. Define consequence-based severity in judgement skills: P0 = critical failure requiring immediate action; P1 = substantial correctness/design consequence requiring correction before proceeding with the affected change; P2 = material, nonblocking maintainability or reliability improvement. Preference-only suggestions are not defects. Confidence is independent of severity; low-confidence concerns remain unresolved rather than being inflated or disguised as P2.
9. `review-plan` verdict: any confirmed P0/P1 → REVISE; only confirmed P2 → COMMENT; no confirmed findings and adequate completed coverage → APPROVE. Incomplete required coverage → INCOMPLETE unless confirmed findings already justify REVISE. Define and render all four values consistently.
10. `research-codebase`: use verified, inferred, and unknown accurately. State "not found within <searched scope>" unless a bounded exhaustive inventory establishes absence. Preserve its open-question harvest and avoid claiming dynamic/external callers do not exist.
11. Rank findings by severity, then consequence/confidence; dimensions are tags or secondary grouping. State effort separately so a cheap cosmetic fix cannot displace a serious issue.

### Tests

Update `tests/test_skills.py` alongside the changes: replace `test_no_skill_requires_full_reread` and universal `test_child_return_is_pointer_only`; extend schema/agent-contract checks only for essential fields and complete verdict vocabulary. Retain reference resolution and frontmatter checks. Do not implement a prose-parser verdict engine merely to test a markdown decision table.

Manual behavioural cases: malformed child result; exactly one P1; every dimension has a valid issue; a correct-looking quotation contradicted by a caller; incomplete search. Test these before and after the edit using the same inputs.

### Success criteria

- Automated: `uv run pytest -q tests/test_skills.py tests/test_agents.py`.
- Manual: formatting errors never appear as code defects; every published finding has inspected supporting context; all verdict combinations have a defined result; uncovered areas remain visible.
- Revert/rework if: the revised schema produces verbose reports without better evidence, or valid findings disappear because required fields become bureaucratic hurdles. Preserve evidence requirements while simplifying rendering.

### Non-goals

No audit execution against the whole user's codebase, no automatic fixes, and no new universal severity package or installer feature.

## Phase 2 — Correct and calibrate the audit rubrics

### Overview

Make strictness operational with useful checks, counterexamples, and technically sound corrections. Cover real design weaknesses without requiring textbook architecture everywhere.

### Changes

Edit all six `skills/code-quality-audit/references/*.md`, their parent `SKILL.md`, and relevant `skills/testing-strategy/references/*.md` plus its parent skill.

| Dimension | Required improvement |
|---|---|
| SOLID | Add concrete LSP contract checks and OCP applicability; a new branch is not automatically a violation. Judge SRP by independent change responsibilities and coupling, not class/method count. For DIP, require an actual testing, lifecycle, ownership, or substitution problem. Include legitimate direct dependency use as a counterexample. |
| DRY | Trace duplicated business knowledge across callers and identify why it must change together. Keep incidental similarity as a non-finding. Recommend one source of truth only when it does not introduce false coupling. |
| KISS | Own unnecessary indirection and speculative abstraction directly. Remove mandatory routing to `ponytail-*`. Check current consumers and protected invariants before proposing deletion. A useful adapter remains valid even with one implementation. |
| Typing | Separate unsafe type escape from valid boundary narrowing. Check argument identity, variant coverage, optional states, and validation at input boundaries. Fix the example using an explicit union plus `assert_never`, or documented checker exhaustiveness settings. Clarify nominal types do not validate arbitrary runtime input. |
| Errors | Trace failure to the caller-visible outcome, including swallowed errors, context loss, and success reported after failure. Permit broad exception handling at a deliberate process/task boundary when the outcome remains truthful. |
| DDD | Apply where business invariants and ownership justify it, even without a folder called domain. Do not demand rich entities for simple CRUD. Correct the aggregate example with internal storage, immutable external views, and guarded state transitions; callers must not bypass the demonstrated invariant through the public API. |

For each rubric provide a compact check procedure, evidence needed, one defect/correction example where useful, and a legitimate non-finding. Avoid growing every file to an arbitrary minimum length.

For testing strategy, replace style-only findings with the failure mode missed or maintenance cost incurred. Allow state-based plumbing assertions when they verify the boundary. Treat mocks, sociable tests, integration counts, and pyramid proportions as context-sensitive choices. Missing runtime/flakiness history is unknown, not an invented statistic. Review categorical statements in async/contract references: tie expectations to actual delivery and compatibility contracts and existing alternative coverage; keep important duplicate-delivery and dual-write risks explicit. Keep source summaries distinct from this project's audit heuristics.

### Tests

Replace `test_dimension_rubrics_are_substantive`'s minimum-line/emoji proxy with reference-integrity checks plus human review of calibration cases. Keep the size check as an authoring guard, not proof of quality; revise its limit only with a stated need.

For the corrected Python examples, create executable companion fixtures in `tests/fixtures/skill_examples/` and focused `tests/test_skill_examples.py`: aggregate rejects additions after closure and its exposed items cannot mutate internal state. Keep markdown examples aligned with those fixtures. Validate the typing fixture with the repository's configured checker; include an intentionally extended union that must yield the expected exhaustiveness diagnostic. Do not infer success from any nonzero checker exit or rely on a missing checker binary. Use the existing `pyrefly` dependency, checking its actual diagnostics during implementation.

### Success criteria

- Automated: `uv run pytest -q tests/test_skill_examples.py tests/test_skills.py`; `uv run pyrefly check tests/fixtures/skill_examples/typing_valid.py` after that fixture is added.
- Manual: each rubric distinguishes its seeded defect from its legitimate counterexample; suggested corrections actually address the consequence.
- Revert/rework if: stricter wording starts flagging simple scripts, ordinary branching, valid broad boundary catches, or incidental duplication without concrete consequences.

### Non-goals

No required external design/TDD skills, no universal DDD requirement, and no expansion into a full security or performance audit. Clearly observed out-of-scope risks may still be flagged as such.

## Phase 3 — Adaptive delegation and portable execution

### Overview

Reduce duplicated reads and reasoning while preserving the Phase 1 coverage/evidence contract on every host.

### Changes

Edit the five skills with fan-out sections, `skills/_shared/fanning-out/{pi,claude,codex,opencode}.md`, `agents/{cq-dimension,test-level,plan-lens,repo-scout}.md`, `README.md`, and affected installer tests.

1. Small file/diff/plan: parent maps, investigates, and applies all relevant checks. No mandatory agent count. A repository label alone does not justify delegation.
2. Large scope: first produce one compact map. Delegate by independent module/bounded context when that minimises duplicate reads. Each child receives its scope, relevant rubrics, known contracts, output/evidence rules, and read-only restriction. Assign cross-area dependencies to the parent so module splits do not hide coupling.
3. Allow a targeted dimension/test-level/plan-lens child when its question is genuinely independent. For plans sharing the same source set, combine related lenses in one reviewer; retain an independent second view only for high-risk or disputed conclusions.
4. Update the existing `cq-dimension`, `test-level`, and `plan-lens` agents to accept an explicit bounded scope and one or more applicable dimensions/levels/lenses. Keep their names for compatibility. Update descriptions and required task fields so parent and child contracts agree.
5. A cheap scout inventories and locates; it does not interpret architecture or decide whether code is sound. If a missing/ambiguous result affects scope or a conclusion, the parent probes it or delegates to a capable reviewer. Remove automatic multi-scout maps when one inventory pass suffices.
6. Resolve bundled agents only when available; otherwise use an appropriate host-native child or the parent. Do not assert that all children lack skills. Supply required instructions/references explicitly rather than depending on inherited context.
7. Move Pi's `runs.all`, `outputMode`, packaged fallbacks and output persistence instructions into `pi.md`. Other hosts use supported result channels. Index/full finding structure is portable; a particular filesystem output mechanism is not.
8. Codex retains its existing native subagent branch, with capability-conditional serial execution. Claude uses available tools without requiring this repo's Pi frontmatter. OpenCode uses only tools documented in its current environment; a directory's presence is not evidence of a callable subagent API. Never tell it to emulate Pi/Claude calls.
9. Serial execution: order checks by risk and dependency, then reuse nearby evidence. Keep compact notes and revisit source when evidence is stale or insufficient. Remove instructions claiming a model can close files to evict context. Never mandate dropping async, DDD, or another dimension by name. If a real budget prevents completion, mark the remaining coverage unverified and identify the next work.
10. Read referenced sections on demand; expand to whole files for cross-cutting contracts as needed. Avoid exhaustive full-file/caller loading for a trivial change, but trace changed behaviour beyond changed lines when needed. Diff scope means issues introduced or materially affected by the change, including consequences in unchanged callers.
11. Do not change model/reasoning settings as part of this phase. Compare orchestration with fixed models first; report total work and latency separately.

### Tests

In `tests/test_skills.py`, revise mandatory-scout, fixed-dimension, universal-file-only and serial-drop-policy tests. Keep tests for all four host branches and valid referenced files. These are packaging guards; evaluate orchestration through traces.

In `tests/test_agents.py`, add a parameterised native-host installation test using temporary target roots for all four hosts: only that host's dispatch instructions are generated; common evidence rules remain; linked references are readable; a host-branch edit marks output stale; reinstall updates it; unrelated files survive removal. Existing legacy flattened-format tests can remain explicitly labelled legacy; they must not describe current Codex behaviour. No installer production change is expected unless these tests reveal a necessary defect.

### Success criteria

- Automated: `uv run pytest -q tests/test_agents.py tests/test_skills.py`.
- Manual: small cases spawn no unnecessary children; broad cases name ownership of cross-module checks; Pi-only commands do not appear as actionable instructions on other hosts; missing agents still permit completion.
- Compare fixed-case traces and total usage against baseline. Accept cost reductions only if important findings and coverage are preserved. Do not promise a percentage reduction before measurement.
- Revert/rework if: partitioning misses cross-boundary findings, scouts narrow scope incorrectly, or aggregate token use rises without a useful quality/latency gain.

### Non-goals

No new host integrations, paid model selection experiments, concurrency framework, model pins, global settings edits, or installer migration rewrite.

## Phase 4 — Self-contained planning and implementation

### Overview

Remove unnecessary interaction gates and make the testing workflow explicit without relying on the external `tdd` skill.

### Changes

- `skills/create-plan/SKILL.md`: research first; ask only about consequential requirements, tradeoffs, or missing authority that cannot be inferred. Propose phases for new/ambiguous work, but treat already accepted structure and explicit requests to write the plan as authorisation to proceed. Resolve blocking questions; record reasonable nonblocking assumptions and validation steps rather than forcing answers to every unknown. Use the existing plans directory without routine confirmation. Describe behaviours and appropriate test levels without invoking another testing skill.
- `skills/implement-plan/SKILL.md`: include the full loop inline: select one observable behaviour; write one focused test; run it and confirm the intended failure; implement the smallest sufficient change; rerun; refactor while green; repeat. A pre-existing passing test remains useful regression coverage, but does not prove a new test exercised the missing behaviour. Trivial prose/glue changes do not require ceremonial tests.
- Reuse the project's runner and helpers. Test through the appropriate public boundary; use doubles for external effects when needed. Avoid tests coupled to private structure and redundant higher-level assertions, while allowing distinct integration contracts to be tested separately.
- Replace unconditional implementation pauses with progress updates. Pause only for consequential scope changes, missing user choices, or actions requiring fresh authorisation. Handle routine implementation discoveries autonomously and record them in the plan.
- On resume, trust completed plan items unless changed code or failed checks provide reason to revisit them. Do not replay completed phases automatically.
- `skills/review-plan/SKILL.md`: recommend how to resolve competing lenses with evidence and tradeoffs, while asking the user only for genuinely value-dependent decisions. Re-review affected lenses and newly affected interfaces, not just lenses that previously found defects.
- `skills/research-codebase/SKILL.md`: use existing research-directory conventions; use narrow follow-up checks when prior evidence remains current rather than automatically restarting the whole investigation.
- Review all seven skill descriptions for concise, distinct triggers and boundaries. Remove incidental claims that parallelism is always part of the task. Keep flat scalar frontmatter compatible with `catalog.parse_frontmatter`.
- `remove-comment-slop`: preserve its bounded behaviour and legal/directive safeguards. Only streamline validation instructions to use checks relevant to changed prose; keep broader testing conditional on runtime docstring use, scope, or an explicit request. Do not add unrelated cleanup features.

### Tests

Keep catalog/frontmatter and reference-link tests. Remove tests requiring an exact anti-trigger sentence ending if it prevents equally clear shorter descriptions; test essential discoverability metadata instead. Use manual prompt cases to validate trigger selection and interruption behaviour.

Test the implementation workflow in an isolated fixture with no external skills: approved plan, one nontrivial behaviour, one routine implementation adjustment, and one genuinely scope-changing ambiguity. It should follow the test-first loop, continue through the routine adjustment, and surface the consequential ambiguity.

### Success criteria

- Automated: `uv run pytest -q tests/test_catalog.py tests/test_skills.py`.
- Manual: planning/implementation are usable with only repository-owned skills; no `$tdd`, path to a personal TDD skill, or required invocation is introduced. An approved plan does not trigger repeated approval requests.
- Revert/rework if: fewer interruptions hide a consequential requirement decision or weaken meaningful testing. Restore a targeted gate, not universal pauses.

### Non-goals

No changes to external `tdd`, `teach`, `grill-me`, `codebase-design`, `find-skills`, or system/plugin skills. No removal of the user's local TDD installation. No implementation of this plan's code changes during the planning task.

## Phase 5 — Behavioural checks, measurement, and rollout

### Overview

Deliver a small reproducible case set and compare outputs, not just prompt wording. Capture baseline outputs before Phase 1; finalise case documentation and compare the revised version here.

Scope note (2026-09-20): user dropped the evals package (cases/scorecard/runbook); Phase 5 ships as README policy plus rollout guidance only.

### Changes

Add `evals/skills/README.md`, small fixtures under `evals/skills/cases/`, and `evals/skills/scorecard.md`. Keep case inputs separate from expected findings so agents cannot read their answer key during a run. No new runtime dependencies or provider credentials. Store detailed local transcripts outside normal CI and commit only intentionally curated, nonsensitive comparison summaries.

| Case | Expected outcome |
|---|---|
| Mutable aggregate invariant bypass | Find the reachable bypass; suggested correction closes it. |
| Legitimate simple script/direct dependency | No invented DIP/DDD requirement. |
| Duplicated business rule plus incidental lookalike | Flag the shared rule; preserve unrelated repetition. |
| Swallowed persistence failure plus valid boundary catch | Trace false success; do not condemn a truthful boundary handler. |
| Nonexhaustive variant handler | Identify missing static enforcement and give a valid correction. |
| Apparent violation disproved by caller/configuration | Reject the candidate after checking counterevidence. |
| Systemic typing weakness | One root-cause finding with representative evidence, without hiding distinct consequences. |
| Malformed child result and unknown search result | No invented P1; incomplete/unknown scope stays explicit. |
| Plan with exactly one major issue | REVISE; a clean but incompletely reviewed plan is not APPROVE. |
| Approved implementation plan without external TDD skill | Incremental tests and implementation; no redundant permission loop. |
| Larger two-module flow and serial fallback | Preserve cross-module and high-risk async checks; visible coverage under a budget limit. |

Start comparisons on the primary host with the same model, reasoning, inputs, and tool access. Run baseline and revised versions twice per selected case initially; repeat only disputed or unstable cases. Expand to the remaining cases as each affected phase lands. Host smoke checks verify installed instructions and fallbacks; do not claim identical behavioural results on hosts not actually exercised.

Score with human review: expected important defects detected/missed; unsupported findings; evidence accuracy; correction usefulness; coverage honesty; unnecessary interruptions. Record input/output/reasoning/cache tokens when exposed, total child work, tool calls, and wall time. Mark unavailable fields unknown. Convert to money only with the applicable recorded pricing and billing model; subscription usage is not automatically marginal dollar cost.

Acceptance gates: no missed must-find defect in the fixed cases; no fabricated critical/major finding; no unsupported clean verdict; corrections address the seeded defect; no required external skill. Cost changes must be compared at that quality floor. Small repeated trials indicate regressions but do not prove general model reliability.

Update `README.md` with the short workflow/validation policy, host-specific versus common instructions, and the evaluation command-free runbook. Add a link to this superseding plan; do not rewrite historical results as if revalidated.

### Tests and success criteria

- Automated: `uv run pytest -q` for the repository suite. If Python files were changed, also run `uv run ruff check <changed-python-paths>` and `uv run ruff format --check <changed-python-paths>` with actual paths, preserving unrelated baseline failures. The skill-example tests verify their fixtures; the model output scorecard is manual.
- Manual: review before/after outputs against the hidden answer key; inspect child traces for duplicated reads and output verification; record comparison limitations.
- Installation checks use temporary targets first. When implementation includes rollout, install only the seven named skills using the existing CLI, preserve conflicts/unowned files, and verify status per host. Do not use an unrestricted sync that changes unrelated skills.
- Rollout command after tests: `uv run agentic-hub install code-quality-audit testing-strategy research-codebase review-plan create-plan implement-plan remove-comment-slop --agent claude,pi,codex,opencode`. Verify with `uv run agentic-hub list`. Run only where these target installations are intended; generated output inspection does not count as a runtime smoke test.
- Revert/rework if: quality gates regress, host output contains unsupported operations, or cost gains rely on silently omitted coverage.

### Non-goals

No paid CI model runs, automated LLM judge, broad benchmark platform, hard-coded price table, or claims of measured savings based only on fewer words/agents.

## PR strategy and rollback

Five independently reviewable PRs, one per phase. Phase 1 establishes the contract; Phase 2 calibrates rubrics; Phase 3 tunes orchestration against that contract; Phase 4 changes interaction/testing workflow; Phase 5 packages comparisons and rollout guidance. Capture baseline before PR 1 and use the cases throughout, not only after PR 5. PRs 3 and 4 depend on Phase 1; Phase 5 evaluates the complete stack. Keep rubric and orchestration changes in separate commits so regressions remain attributable.

Rollback the specific phase's edits and regenerate only affected installed skills. References are symlinked, so reverting source restores their content; generated `SKILL.md` files require reinstall. Preserve the pre-existing dirty worktree changes and historical baseline snapshot. No automatic rollback by hard reset or wholesale directory deletion.

## Completion checklist

- [ ] Baseline captured before skill edits, including dirty-tree source and model settings.
- [x] All published defects satisfy the evidence contract; incomplete coverage cannot appear clean.
- [x] Severity and verdict rules are exhaustive; malformed output cannot become a defect.
- [x] All six code-quality rubrics are calibrated and their corrections are technically valid.
- [x] Delegation is scope/risk-driven with explicit cross-area ownership and serial fallback.
- [x] Host-specific mechanics are absent from common actionable instructions.
- [x] Planning and incremental implementation work without an external TDD skill.
- [ ] Structural tests pass and behavioural comparisons meet the stated quality floor.
- [ ] Cost/latency evidence is recorded honestly, including unavailable data and untested hosts.
- [ ] Only intended skills are installed; unrelated user changes and installations are preserved.
