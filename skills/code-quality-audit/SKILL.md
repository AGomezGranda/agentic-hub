---
name: code-quality-audit
description: >
  Audit code against SOLID, DRY, KISS, typing discipline, error handling and
  DDD modeling for a full repo, a bounded context/domain, or a git diff/PR.
  Use when asked to review code quality, check design principles, review a
  PR for design smells, or audit a domain's structure. Not for
  over-engineering/simplification (use ponytail-review/ponytail-audit),
  test coverage (use testing-strategy), security, or performance.
argument-hint: '[repo | path/domain | diff/PR ref]'
---

# Code Quality Audit

Audit code against six design-correctness dimensions — SOLID, DRY, KISS,
typing, error handling, DDD — and report findings worth acting on.

**Audit, don't rewrite.** Produce a report. Only change code if the user asks
for that after seeing it.

## Boundary — read this before starting

This skill is about **design correctness**, not simplicity or safety. Route
findings that belong elsewhere instead of duplicating those skills:

- "This is more complex/abstract than it needs to be" → `ponytail-review`
  (diff) or `ponytail-audit` (repo). Not here.
- Test coverage, test pyramid balance → `testing-strategy`. Not here.
- Security (injection, secrets, trust boundaries), performance (N+1,
  allocations), dependency health → out of scope entirely. Say so, don't
  attempt them.

If a finding is genuinely both (e.g. an abstraction that's both unnecessary
*and* violates SRP), report it here as the SOLID finding and skip the
complexity angle — don't make the user read the same line twice from two
skills.

## 1. Resolve scope

- **Full repo** — audit architecture-wide: layering, cross-cutting SOLID/DRY
  violations, whether DDD boundaries hold across the whole codebase. Broad
  enough to fan out: after step 2's map, spawn one subagent per applicable
  dimension in a single `subagent` workflow call (fanned out together, not a
  loop), each given the domain map/conventions from step 2 and told to
  return that dimension's findings table with `path:line` evidence. Cap it
  at 4-5 children — if all six dimensions genuinely apply, merge the two
  most related into one child's task (e.g. SOLID+DDD, or KISS+typing) rather
  than spawning a sixth. Wait for all before synthesizing the report.
- **Path / domain / bounded context** — audit one module or aggregate in
  depth; still read its neighbours and callers to judge boundary leakage, but
  don't map the whole repo.
- **Diff / PR** — audit only the changed lines, but always load the full
  files they belong to and their direct callers/callees. A diff review that
  ignores the surrounding contract will misjudge SRP and DDD violations.

## 2. Map before judging

You cannot judge design without knowing the model it's supposed to express.
Before scoring anything, establish:

- **Domain vocabulary** — what are the entities, value objects, and
  aggregates actually called in code vs. how the team/docs/tests talk about
  them? Mismatches here predict most other findings.
- **Layering** — is there a real domain layer, or is everything
  controller → ORM model → controller (anemic, no domain to violate DDD in)?
  Note this explicitly; it changes what's even checkable.
- **Existing conventions** — the codebase's own typing strictness, error
  handling idiom, and module boundaries. Judge against the repo's own
  standard first, the textbook standard second.

For a diff/PR, this is just: what contract did the changed function/class
already have, and what does the surrounding domain call it.

## 3. Check each dimension

One findings table per dimension that actually applies to this scope — skip
a dimension entirely and say so if the codebase has nothing to say about it
(e.g. a script with no domain layer has no DDD findings).

**SOLID** — SRP: a class/function changing for more than one reason. OCP:
new cases requiring edits to existing branches instead of extension. LSP:
a subtype that narrows preconditions or breaks a caller's expectation of the
base type. ISP: callers forced to implement/depend on methods they don't
use. DIP: high-level logic importing/constructing a concrete low-level
dependency directly instead of depending on an abstraction it owns.

**DRY** — duplication that will *drift* (the same business rule expressed
twice, will silently diverge) vs. incidental repetition (two unrelated
things that happen to look similar today). Only the first is a finding;
flagging the second creates a false coupling when someone "fixes" it.

**KISS** — the wrong abstraction, not too much abstraction (that's
`ponytail-review`'s job). A wrapper that doesn't match the problem shape, a
generic solution for one concrete case, control flow that's hard to trace
because it's modeling the wrong thing.

**Typing** — leaky `any`/`unknown`/untyped boundaries at the edges of the
domain, primitive obsession (a `string` where an `Email` or `UserId` type
would make invalid states unrepresentable), missing discriminated
unions/exhaustiveness checks on variants, stringly-typed enums.

**Error handling** — swallowed exceptions, catch-and-log-and-continue where
the caller needed to know, errors that lose type/context crossing a module
boundary, broad `catch`/`except` hiding a specific failure a caller could
handle differently.

**DDD** (only where a domain layer exists) — anemic models (all data,
getters/setters, logic lives in services instead of the entity), logic that
belongs in the domain leaking into controllers/handlers, a bounded context's
internals (types, IDs) crossing into another context instead of going
through its published interface, an aggregate whose invariants can be broken
by reaching through it instead of its root.

## 4. Report

If dimensions were fanned out to subagents, open each cited file yourself
before writing anything down — a subagent's `path:line` claim is a lead, not
confirmed evidence. Drop or fix anything that doesn't hold up.

1. **Scope and model** — two or three sentences: what was audited, what
   domain layer (if any) exists, which dimensions actually applied.
2. **Findings** — grouped by dimension, each one: `path:line`, what's wrong,
   why it matters (what breaks or drifts because of it, not just "it's not
   pure"), suggested fix. Order by cost within each group.
3. **Explicitly fine** — dimensions checked and found solid. One line each.
   An audit with findings everywhere isn't credible.
4. **Out of scope, flagged anyway** — anything that's clearly a security,
   performance, or over-engineering issue spotted along the way; name it and
   point at the right skill instead of addressing it.

## Judgement rules

- **Cite evidence.** Every finding is a real path/line, not a generic
  principle restated. Advice that would read the same for any repo is not a
  finding.
- **Judge against the repo's own convention first.** A repo that's
  consistently loose with typing has one finding ("no typing discipline
  established") not fifty individual `any` findings.
- **Severity is about consequence, not purity.** A DIP violation with one
  concrete dependency that will never change is a non-issue; the same
  violation blocking a needed test double or a real second implementation is
  a real finding.
- **Don't invent a violation to fill a dimension.** If SOLID has nothing to
  say about a 40-line script, the table is empty. Say so.
