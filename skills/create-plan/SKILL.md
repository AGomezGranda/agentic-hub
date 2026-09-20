---
name: create-plan
description: Create a detailed implementation plan through interactive, iterative collaboration with the user before writing code. Use when the user needs to plan a feature, refactor, or non-trivial task.
---

# Create Plan

Produce a written implementation plan through back-and-forth with the user —
skeptical, thorough, collaborative. Don't write the whole plan in one shot.

## 1. Gather context

- If given a file/reference, read it FULLY (no offset/limit) before anything else.
- If given nothing, ask for: the task description, relevant constraints, and
  links to prior research or related code. Wait for the reply.
- Research the codebase yourself first (`grep`/`read`). For larger surfaces,
  fan out parallel read-only research subagents in one `subagent` workflow call
  (e.g. "find all files handling X", "explain how Y currently works",
  "find a similar existing pattern") instead of exploring serially. Read every
  file the research turns up FULLY into your own context — don't plan off a
  subagent's summary alone.
- Cross-reference the request against what the code actually does. Present your
  understanding plus only the questions you genuinely can't answer by reading
  code:
  ```
  Based on the request and the codebase, I understand we need to [...].
  Found: [file:line facts]
  Open questions: [judgment calls only research can't resolve]
  ```
- If the user corrects a misunderstanding, go re-verify it in the code — don't
  just accept the correction blind.

## 2. Agree on structure before details

Propose phases first, get a nod, then write details:
```
## Implementation Phases
1. [Phase] - [what it accomplishes]
2. [Phase] - [what it accomplishes]
Does this phasing make sense?
```

## 3. Write the plan

Before picking a path, check for an existing plans dir: `find . -type d -iname plans -not -path '*/node_modules/*'`.
If one exists (e.g. `meta/plans/`, `docs/plans/`), save there. Otherwise save
to `plans/YYYY-MM-DD-description.md` (create the dir; ask the user if they
use a different convention). Frontmatter: just `date`, `title`,
`status: draft`. Body, per phase:

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

If the plan has grown to many phases (roughly 5+, or any phase that's large on
its own), add a **PR Strategy** section: group phases into shippable PRs —
some phases combined into one PR, others standing alone — each an
independently reviewable, mergeable, revertable unit. Note ordering/dependencies
between them.

No open questions in the final plan — resolve every one before writing it down.

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
- Be thorough: read full files, cite `file:line`, use real patterns already in
  the codebase (grep for similar features before inventing a new one).
- Be practical: incremental phases, explicit non-goals, edge cases named.
