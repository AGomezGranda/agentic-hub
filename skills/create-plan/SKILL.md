---
name: create-plan
description: Create a detailed implementation plan through interactive, iterative collaboration with the user before writing code. Use when the user needs to plan a feature, refactor, or non-trivial task. Not reviewing an existing plan (review-plan) or open-ended research with no plan to write (research-codebase).
---

# Create Plan

Produce a written implementation plan through back-and-forth with the user —
skeptical, thorough, collaborative. Don't write the whole plan in one shot.

## 1. Gather context

- If given a file/reference, read it FULLY (no offset/limit) before anything else.
- If given nothing, ask for: the task description, relevant constraints, and
  links to prior research or related code. Wait for the reply.
- Research the codebase yourself first (`grep`/`read`). For larger surfaces,
  fan out instead of exploring serially, using `research-codebase`'s own
  decomposition, child task template, and evidence schema (its §2-4)
  rather than a second copy of them here — see "Fanning out" below for
  dispatch, per host. A subagent's `path:line` claim is a lead, not
  confirmed evidence: read the file yourself before a plan decision rests
  on it, and a targeted `sed -n`/`grep -n` check is enough for anything the
  plan doesn't hinge on.
- Cross-reference the request against what the code actually does. Present your
  understanding plus only the questions that are consequential and
  unanswerable by reading code — requirements, tradeoffs, or missing
  authority you genuinely cannot infer:
  ```
  Based on the request and the codebase, I understand we need to [...].
  Found: [file:line facts]
  Open questions: [consequential judgment calls only research can't resolve]
  ```
- If the user corrects a misunderstanding, go re-verify it in the code — don't
  just accept the correction blind.
- An already accepted structure, or an explicit request to write the plan, is
  authorisation to proceed — don't re-confirm phasing that was already agreed.

### Fanning out

Bundled agent for this skill: `repo-scout` (takes an explicit bounded scope
— see `agents/repo-scout.md`); if it isn't installed, use a host-native
child or research yourself.

<!-- agentic-hub: fanout -->

## 1b. Leave the touched area cleaner (boy-scout rule)

Every plan moves the code it touches toward the governing architecture
contract — that is a standing requirement, not scope creep. For each module
the change touches (and the boundary it crosses), compare against the
contract and decide the target shape *before* deciding where new code goes:

- **Split** a file or class that mixes independent reasons to change
  (pricing + notification, rule + I/O) so the new code lands in a cohesive home.
- **Move** code into its context/layer folder (`<context>/domain|application|adapters`)
  instead of growing a layer-first or junk-drawer module (`services/`, `utils/`).
- **Extract** what the change needs to be clean: a port for a side effect
  constructed inline, a value object for a primitive with rules, an invariant
  owner for a rule duplicated across callers, a composition-root wiring point.
- **Add enforcement** (import-linter / dependency-cruiser contract) for a
  boundary the plan establishes, so it stays fixed.

Bound it: restructure what the change touches and what new code must depend
on — not the whole repository. Prefer the target design that makes the next
feature in this area a one-folder change. Violations outside that boundary go
in a **Structural Debt** list (location, rule ID, suggested follow-up), not
into the phases. If a restructure is too large to bundle (many callers,
cross-context, migration), say so and propose it as its own PR ahead of the
feature, with the trade-off stated — never silently add to a non-compliant area.

## 2. Agree on structure before details

Propose phases first, get a nod, then write details. Structural phases come
first and are behaviour-preserving (moves/splits/extractions with tests green
before and after), so the feature phases build on the clean shape:
```
## Implementation Phases
1. [Restructure] - [target shape and why it eases this and later changes]
2. [Phase] - [what it accomplishes]
Does this phasing make sense?
```

## 3. Write the plan

Before picking a path, check for an existing plans dir: `find . -type d -iname plans -not -path '*/node_modules/*'`.
If one exists (e.g. `meta/plans/`, `docs/plans/`), save there without asking.
Otherwise create `plans/` and save there. Frontmatter: just `date`, `title`,
`status: draft`. Top-level, where material: **Current State** (key facts with
`file:line` refs), **Design Decisions** (decision + rationale, else none
beyond conventions), **Target Structure** (before → after tree of the
touched area, with the rule IDs each move satisfies), **Structural Debt**
(out-of-boundary violations noticed, for follow-up), **Risks & Mitigations**
(risk → mitigation). Body, per phase:

- **Overview** — 1-2 sentences
- **Changes** — specific files/functions, not vague intent
- **Tests** — name the tests to write *before* the code (TDD), and at which
  level of the pyramid: mostly fast unit tests, fewer integration tests, a
  thin top of end-to-end. State edge cases each test pins down. Push behaviour
  down to the cheapest level that can catch the bug; don't cover in an e2e test
  what a unit test already proves.
- **Success criteria**, split in two:
  - **Automated**: exact commands (`make test`, `npm run lint`, ...)
  - **Manual**: what a human needs to click/check
- **What we're NOT doing** — explicit non-goals

Give every executable phase a unique numbered heading in the form
`## Phase 1 — Add the execution contract`. Keep its number stable on revision.
Include a **PR Strategy** even for one PR. List PRs in delivery order and give
each a title and its ordered phase headings, copied verbatim without the
Markdown hashes. Assign every phase exactly once. Group phases when they ship
together and note dependencies between PRs. Keep pure moves/renames in their
own commits (or PR) separate from behaviour changes so the diff stays
reviewable. After edits, check the mapping
against the final headings before presenting the plan.

No blocking questions in the final plan — resolve every one before writing it
down. For the rest, record reasonable nonblocking assumptions with a
validation step each, rather than forcing answers to every unknown. Describe
behaviours and the appropriate test level for each directly; don't invoke
another testing skill to say it. No placeholders — never write TODO, TBD,
or vague intent; every change names the exact file and the exact change
(types, signatures, commands). Self-review before presenting: (a) every
requirement maps to a phase, (b) no placeholders, (c) names/types consistent
across phases, (d) no new code lands in a touched area that still violates
the contract without a restructure phase or a stated reason.

## 4. Iterate

Present the draft, ask what needs adjusting, edit, repeat until the user is
satisfied. Prefer incremental, test-first phases over one giant change: each
phase should be shippable with its tests written first and green. Note
migration/rollback for anything risky.

Match the existing suite — reuse the project's test runner, helpers, and
layout instead of inventing a parallel harness. Don't over-test: skip tests
for trivial glue, and don't stack an integration test on top of a unit test
that already covers the case.

## Guidelines

- Be skeptical: question vague requirements, verify instead of assuming.
- Be thorough: read full files, cite `file:line`, reuse existing patterns
  (grep for similar features before inventing a new one) — but only where
  they comply with the governing architecture contract below.
- Place every new file, port, adapter and wiring point per the governing
  architecture contract: the repo's declared standard/ADRs, else the
  `architecture-audit` skill's `references/standard.md`. Existing structure is
  not the baseline; a plan that copies a violation fails review-plan. Cite the
  rule IDs (L/T/D/S) a placement decision rests on in **Design Decisions**,
  and name invariant owners and value objects for domain changes.
- Be practical: incremental phases, explicit non-goals, edge cases named.
