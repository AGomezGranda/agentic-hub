# Reliable skills with less duplicated work

The plan proposes improving seven repository-owned skills so they produce
findings backed by evidence, expose incomplete work, and avoid unnecessary
delegation and approval requests. It keeps support for Pi, Claude Code, Codex,
and OpenCode. Lower cost is acceptable only when important findings and coverage
are preserved.

Source: [implementation plan](2026-09-20-strict-skill-quality-and-cost.md), dated
**2026-09-20**, status **draft**. Companion created **2026-10-12**. The original
remains the implementation and evidence reference. This companion preserves
its proposals and reported progress; it does not change their approval status
or independently validate their correctness.

## Scope and decisions

The seven skills are `code-quality-audit`, `testing-strategy`,
`research-codebase`, `review-plan`, `create-plan`, `implement-plan`, and
`remove-comment-slop`. Changes also reach their bundled agents, references,
host dispatch instructions, structural tests, and README.

Implementation must preserve these decisions:

- Use capabilities available in the running host. Missing custom agents or
  external skills must not block core work.
- Keep the current installer and fan-out marker. Common workflow rules belong
  in each skill; host dispatch and output mechanics belong in its host branch.
  Installer production changes are expected only if tests expose a defect.
- Keep the existing native Codex installation work. The reviewed working tree,
  including its uncommitted edits, is the baseline.
- Keep strong judgment with the parent or capable reviewer. Cheap discovery
  only inventories and locates. Do not change model pins, reasoning settings,
  or user-level configuration in this project.
- Audits remain read-only unless the user explicitly requested fixes. Existing
  authorization must not trigger another approval request.
- Planning and implementation must work without the external `tdd` skill.
  The user will remove it; implementation must leave that installation alone.

The plan excludes new host integrations, configuration or concurrency
frameworks, broad benchmark infrastructure, paid CI model runs, and automatic
fixes. It does not extend the design audit into a full security or performance
audit, though clearly observed risks outside scope may be identified as such.
External and system/plugin skills are outside the change scope.

The source records a scope note dropping the evaluation package, while
other passages still require it. That conflict is retained
[below](#phase-5--checks-measurement-and-rollout).

## What prompted the changes

The source's inspection on 2026-09-20 reports several weaknesses: malformed
child output can become a P1 finding; thin summaries or quotations can pass
as verification; incomplete searches can become claims of absence; and
repository conventions can excuse harmful practices. Plan review has no
verdict for exactly one P1. Some rubric examples fail to enforce the invariant
or type coverage they demonstrate.

It also reports unnecessary default delegation and interaction gates, host
instructions that assume unavailable tools or control over context eviction,
and tests that check wording or rubric length without establishing output
quality. These are the source's dated observations, not a fresh code audit.
Exact locations and the pre-existing edit list are in
[Verified starting point](2026-09-20-strict-skill-quality-and-cost.md#verified-starting-point).

This plan supersedes the older
[four-host tuning plan](2026-09-20-pi-first-skill-cost-and-rubrics.md)'s claims
that Codex lacks native skills/subagents and its index-only verification
policy. Preserve that historical document rather than rewriting its results.

## Phase 1 — Evidence, coverage, and verdicts

Apply one reporting contract to parent and child reviewers:

1. Recover malformed fields where possible. Request one targeted correction
   if needed. If the result remains unusable, report an investigation failure
   and uncovered scope. Formatting failures never become code defects or
   receive defect severity.
2. Every confirmed finding needs a stable ID, severity, confidence, location
   and evidence, violated contract or constraint, concrete consequence,
   counterevidence considered, and the smallest sufficient correction.
   Keep these compact. IDs must distinguish findings at the same location
   and survive deduplication.
3. Summaries and indexes only help navigation. Before publishing a finding,
   inspect its full rationale and enough original code, callers, configuration,
   or tests to establish the claim. A checked quotation alone is insufficient.
   Expand reads when needed; whole-file rereads are not compulsory.
4. Track candidates internally as confirmed, rejected, or unresolved. Only
   confirmed findings enter the prioritized defect list. Unresolved concerns
   state missing evidence and the next probe; rejected candidates need not
   be published.
5. Report each in-scope area and applicable dimension or lens as checked,
   not applicable with a reason, or unverified with a reason. Name exclusions
   and sampling. Unverified work must never appear clean.

There is no quota for defects or strengths. Positive claims also need bounded
scope and evidence. Repository conventions provide context, not a quality
ceiling. Report a systemic root cause once with representative instances and
affected scope; keep independent causes separate.

Severity follows consequences:

| Severity | Meaning |
|---|---|
| P0 | Critical failure requiring immediate action. |
| P1 | Substantial correctness or design consequence requiring correction before proceeding with the affected change. |
| P2 | Material, nonblocking maintainability or reliability improvement. |

Preferences are not defects. Confidence is separate from severity;
low-confidence concerns remain unresolved. Rank findings by severity, then
consequence/confidence. Dimensions are tags or secondary groups; effort is
reported separately so an easy cosmetic fix cannot displace a serious issue.

Plan review must render all four verdicts consistently:

| Condition | Verdict |
|---|---|
| Any confirmed P0 or P1, even with incomplete coverage | REVISE |
| Required coverage incomplete, without a confirmed P0/P1 | INCOMPLETE |
| Only confirmed P2 findings, with required coverage complete | COMMENT |
| No confirmed findings and adequate completed coverage | APPROVE |

Research distinguishes verified, inferred, and unknown. Say “not found within
the searched scope” unless a bounded exhaustive inventory establishes absence.
Preserve open questions and avoid claiming dynamic or external callers do not
exist.

**Checks:** replace tests enforcing index-only verification or universal
pointer-only output with essential schema and verdict checks. Keep frontmatter
and reference checks; do not build a prose-parser verdict engine. Compare the
same manual cases before and after: malformed output, one P1, valid issues in
every dimension, a quotation contradicted by a caller, and incomplete search.
Simplify rendering if the schema adds bureaucracy or suppresses valid findings,
while preserving the evidence contract.

[Phase 1 files and checks](2026-09-20-strict-skill-quality-and-cost.md#phase-1--strict-evidence-severity-and-coverage).

## Phase 2 — Rubrics that distinguish defects from valid choices

Each rubric needs a compact procedure, required evidence, a useful
defect/correction example where appropriate, and a legitimate non-finding.
Length is an authoring guard, not proof of quality.

- **SOLID:** check substitution contracts and when extension rules apply.
  Judge responsibility by independent reasons to change and coupling, not
  class size. A branch is not automatically a violation. Direct dependencies
  need a demonstrated testing, lifecycle, ownership, or substitution problem.
- **DRY:** find duplicated business knowledge that must change together.
  Similar-looking code is insufficient; sharing must not create false coupling.
- **KISS:** identify needless indirection and speculative abstractions directly,
  without mandatory routing to `ponytail-*`. Check consumers and protected
  invariants before proposing deletion. An adapter can be useful with one
  implementation.
- **Typing:** distinguish unsafe escapes from valid boundary narrowing. Check
  argument identity, variant coverage, optional states, and input validation.
  Demonstrate enforceable exhaustiveness with an explicit union and
  `assert_never`, or documented checker settings. Nominal types do not validate
  arbitrary runtime input.
- **Errors:** trace failure to the caller-visible outcome, including swallowed
  errors, lost context, and false success. Broad catches can be valid at a
  deliberate process/task boundary if the outcome remains truthful.
- **DDD:** apply it where business invariants and ownership justify it, without
  requiring a domain folder or rich entities for simple CRUD. The aggregate
  example must use internal storage, immutable external views, and guarded
  transitions so its public API cannot bypass the invariant.

Testing findings need a missed failure mode or concrete maintenance cost.
State-based plumbing assertions may verify a boundary. Mocks, sociable tests,
integration counts, and pyramid proportions depend on context. Missing runtime
or flakiness history is unknown. Async and contract expectations must follow
actual delivery/compatibility contracts and alternative coverage, while keeping
duplicate-delivery and dual-write risks explicit. Separate source summaries
from this project's audit heuristics.

**Checks:** use executable Python fixtures for the corrected examples. Prove
that a closed aggregate rejects additions and exposed items cannot mutate its
internal state. Keep markdown examples aligned. Use the existing `pyrefly`
dependency to check the valid typing fixture and confirm the expected
exhaustiveness diagnostic for an intentionally extended union. An arbitrary
nonzero exit or missing checker does not prove success. Rework wording that
flags ordinary branching, simple scripts, valid catches, or incidental
duplication without a concrete consequence.

[Phase 2 files, fixture paths, and commands](2026-09-20-strict-skill-quality-and-cost.md#phase-2--correct-and-calibrate-the-audit-rubrics).

## Phase 3 — Delegate only where it helps

For a small file, diff, or plan, one investigator maps and checks the scope.
A repository label alone does not justify delegation. For larger scopes,
make one compact map and divide independent modules or bounded contexts when
that reduces duplicate reads. The parent owns cross-area dependencies.

Each child receives a bounded scope, relevant rubrics, known contracts,
evidence/output rules, and a read-only restriction. Keep the existing
`cq-dimension`, `test-level`, and `plan-lens` names, but allow multiple applicable
checks per child. Combine related plan lenses sharing the same sources; retain
an independent second view for high-risk or disputed conclusions. A specialist
pass is appropriate when its question is genuinely independent.

Scouts only inventory and locate. The parent or a capable reviewer probes
missing or ambiguous results that affect scope or conclusions. Use bundled
agents when available; otherwise use a suitable native child or the parent.
Supply required references explicitly rather than assuming inherited skills
or context.

Keep mechanics specific to each host: Pi's `runs.all`, `outputMode`, packaged
fallbacks, and persistence rules belong in `pi.md`. Codex keeps native subagents
with serial execution when unavailable. Claude uses available tools without
requiring Pi frontmatter. OpenCode uses only tools documented in its environment;
an agent directory does not establish a callable API. The index/full-finding
structure is portable; a filesystem output mechanism is not.

Serial work follows risk and dependencies, reuses nearby evidence, and revisits
stale or insufficient evidence. Never claim files can be closed to evict model
context or mandate dropping named dimensions. If budget blocks completion,
mark remaining coverage unverified and identify the next work. Read references
on demand and expand for cross-cutting contracts. Diff reviews cover introduced
or materially affected issues, including consequences in unchanged callers.

**Checks:** test native installation in temporary roots for all four hosts:
only the correct host branch, retained common evidence rules, readable linked
references, staleness after a branch edit, refresh after reinstall, and survival
of unrelated files on removal. Structural tests guard packaging; traces establish
orchestration behavior. Compare total usage and latency separately with fixed
models. Rework if partitioning misses cross-boundary findings, scouts narrow
scope incorrectly, or total tokens rise without useful quality/latency gains.

[Phase 3 files and checks](2026-09-20-strict-skill-quality-and-cost.md#phase-3--adaptive-delegation-and-portable-execution).

## Phase 4 — Planning and implementation without routine gates

Planning starts with research. Ask only about consequential requirements,
tradeoffs, or missing authority that cannot be inferred. Resolve blocking
questions; record reasonable nonblocking assumptions and validation steps.
An accepted structure or explicit request to write the plan authorizes progress.
Use existing plan/research directories without routine confirmation.
Plans describe behaviors and appropriate test levels directly, without requiring
another testing skill.

Implementation includes its own loop: choose one observable behavior, write
one focused test, confirm the intended failure, implement the smallest change,
rerun, refactor while green, and repeat. Existing passing tests provide regression
coverage but do not prove a new test exposed missing behavior. Trivial prose
or glue changes need no ceremonial tests. Reuse project runners and helpers;
test appropriate public boundaries, using doubles for external effects when
needed. Avoid private-structure coupling and redundant higher-level assertions,
while allowing separate integration contracts.

Use progress updates instead of unconditional pauses. Pause for consequential
scope changes, missing user choices, or actions needing fresh authorization.
Handle routine discoveries autonomously and record them. On resume, trust
completed items unless changed code or failed checks justify revisiting them.
Plan re-review covers affected lenses and newly affected interfaces; narrow
research follow-ups reuse current evidence. Resolve competing lenses through
evidence and tradeoffs, leaving value-dependent choices to the user.

Keep seven concise, distinct skill descriptions with flat scalar frontmatter.
Remove claims that parallelism is always required. Preserve
`remove-comment-slop`'s bounded behavior and legal/directive safeguards; broader
checks remain conditional on runtime docstring use, scope, or explicit requests.

**Checks:** validate triggers and interruptions manually. In an isolated fixture
with no external skills, exercise an approved plan, one nontrivial behavior,
one routine adjustment, and one consequential ambiguity. The workflow must
follow the test-first loop, continue through the adjustment, and surface the
ambiguity. If fewer interruptions hide a consequential decision or weaken tests,
restore a targeted gate.

[Phase 4 files and checks](2026-09-20-strict-skill-quality-and-cost.md#phase-4--self-contained-planning-and-implementation).

## Phase 5 — Checks, measurement, and rollout

**Scope conflict in the source:** its 2026-09-20 note says the user dropped the
evaluation package—cases, scorecard, and runbook—and Phase 5 ships only README
policy and rollout guidance. The remaining text still requires an
`evals/skills/` package, a command-free runbook, baseline captures, and before/after
comparisons. The opening decisions also retain manual evaluation. These
instructions conflict. Clarify the retained Phase 5 requirements before creating
evaluation artifacts; this companion does not silently choose between them.

The source's measurement design is preserved here so that decision remains
informed:

- Capture the working-tree diff, existing test failures, and baseline outputs
  **before Phase 1 edits**. Save exact prompts, fixture revisions, generated host
  text, model/reasoning settings, outputs, and available usage metadata. A
  historical commit cannot substitute for the dirty-tree baseline.
- Keep case inputs separate from answer keys. Store detailed local transcripts
  outside normal CI and commit only curated, nonsensitive summaries. Add no
  runtime dependencies or provider credentials.
- Start on the primary host with fixed model, reasoning, inputs, and tool access.
  Run each selected case twice for baseline and revised versions; repeat only
  disputed or unstable cases. Expand as phases land. Installation smoke checks
  cannot establish runtime behavior on unexercised hosts.
- Human review scores missed important defects, unsupported findings, evidence
  accuracy, useful corrections, honest coverage, and unnecessary interruptions.
  Record exposed input/output/reasoning/cache tokens, total child work, tool
  calls, and wall time; mark unavailable fields unknown. Money requires recorded
  applicable pricing and billing terms. Subscription usage is not automatically
  marginal dollar cost.

The case set covers invariant bypasses, valid simple designs, business-rule
duplication, false success after persistence failure, variant exhaustiveness,
counterevidence, systemic typing, malformed/unknown results, a single major plan
issue, implementation without external TDD, and cross-module serial/async
coverage. Exact cases remain in the
[Phase 5 table](2026-09-20-strict-skill-quality-and-cost.md#phase-5--behavioural-checks-measurement-and-rollout).

Its stated quality floor is: no missed must-find defect in fixed cases, no
fabricated critical/major finding, no unsupported clean verdict, useful
corrections, and no required external skill. Cost comparisons must preserve
that floor. Small repeated trials can expose regressions but cannot prove
general model reliability. Do not promise a savings percentage before measurement.

Rollout uses temporary targets first. Where installations are intended, install
only the seven named skills with the existing CLI, preserve conflicts and
unowned files, and verify per-host status. Avoid unrestricted sync. Generated
output inspection is not a runtime smoke test. Update README with common versus
host-specific rules and a link to the superseding plan; do not present historical
results as revalidated. Exact rollout commands are in the source.

## Delivery, rollback, and recorded progress

The plan calls for five independently reviewable PRs, one per phase. Capture
baseline first. Phase 1 establishes the contract; Phase 2 calibrates rubrics;
Phase 3 tunes orchestration; Phase 4 changes planning/testing interaction;
Phase 5 evaluates the complete stack and guides rollout. Phases 3 and 4 depend
on Phase 1. Keep rubric and orchestration edits in separate commits so
regressions remain attributable, and use cases throughout rather than only
after the last phase. Phase 5 packaging remains subject to the conflict above.

Run focused skill/agent checks for Phases 1 and 3, example/skill checks plus
`pyrefly` for Phase 2, and catalog/skill checks for Phase 4. Final checks require
the full repository suite and, if Python changed, Ruff lint and format checks
on actual changed paths. Record unrelated baseline failures separately.
Structural/content tests do not prove that a model follows instructions.
Exact commands and test changes remain in each source phase.

Rollback only the affected phase and regenerate only affected installed skills.
Reverted source restores symlinked references; generated `SKILL.md` files need
reinstallation. Preserve pre-existing edits and the baseline snapshot. Do not
use a hard reset or wholesale directory deletion. Rework any phase if quality
regresses, host output requires unsupported operations, or cost gains depend
on omitted coverage.

The source remains marked **draft**, while its
[completion checklist](2026-09-20-strict-skill-quality-and-cost.md#completion-checklist)
marks evidence rules, severity/verdicts, all six rubrics, adaptive delegation,
host separation, and self-contained planning/implementation as complete.
Baseline capture, structural and behavioral acceptance, cost/latency evidence,
and intended-only installation remain unchecked. These are recorded statuses,
not verification performed for this companion. The source does not explain
whether a baseline taken before the checked work exists elsewhere.

Fidelity check: this companion was compared with the source and its historical
context. The source was preserved. Current code behavior, completed-work claims,
and cost savings were not independently validated.
