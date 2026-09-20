---
name: code-quality-audit
description: 'Audit code against SOLID, DRY, KISS, typing discipline, error handling and DDD modeling for a full repo, a bounded context/domain, or a git diff/PR. Use when asked to review code quality, check design principles, review a PR for design smells, or audit a domain structure. Not over-engineering (ponytail-review/audit), tests (testing-strategy), security or performance.'
argument-hint: '[repo | path/domain | diff/PR ref]'
---

# Code Quality Audit

Audit code against six design-correctness dimensions — SOLID, DRY, KISS,
typing, error handling, DDD — and report findings worth acting on.

**Audit, don't rewrite.** Produce a report. Only change code if the user asks
for that after seeing it. (On Pi, dispatching dimension children to
`reviewer` enforces this structurally — its toolset has no write
capability, so it can't rewrite even if asked.)

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
  dimension — see "Fanning out" below for how, per host. A child cannot see
  this skill (`inheritSkills: false` on every packaged Pi agent, and no
  skill mechanism at all on Claude Code/Codex), so its task text must paste
  in, verbatim: the domain map/conventions from step 2, and that
  dimension's rubric from its `references/<dimension>.md` file (absolute
  path) — not just the dimension's name. Tell it to return findings in the
  "Child finding schema" below. Wait for all before synthesizing the
  report.
- **Path / domain / bounded context** — audit one module or aggregate in
  depth; still read its neighbours and callers to judge boundary leakage, but
  don't map the whole repo.
- **Diff / PR** — audit only the changed lines, but always load the full
  files they belong to and their direct callers/callees. A diff review that
  ignores the surrounding contract will misjudge SRP and DDD violations.

### Fanning out

Bundled agent for this skill: `cq-dimension`; fall back to the packaged
`reviewer`, then a generic child, if it isn't installed.

<!-- agentic-hub: fanout -->

### Child finding schema

Every child — and every dimension you check yourself — reports findings in
this shape, one block per finding:

```
severity: P0 | P1 | P2
confidence: high | medium | low
location: path:line
excerpt: verbatim quoted line(s), not a paraphrase
finding: one paragraph — what's wrong and why it matters
strengths: optional — what's solid here, not just what's wrong
```

If a child has nothing to report for its dimension, it says exactly:
`No issues found. Checked: <what>. Solid because: <one line>.` A bare
"No issues found." can't feed step 4's "Explicitly fine" section — the
structured version can. If a child's output doesn't parse into this shape,
keep its raw text as a single P1 finding under its dimension name rather
than dropping it.

## 2. Map before judging

On Pi, for a full-repo scope large enough to warrant fanning out (see
"Fanning out" below): dispatch the map before judging it, one `runs.all([...])` of
`repo-scout` children — one for domain vocabulary, one for layering, one
for existing conventions (typing, error handling, module boundaries) —
each returning its own evidence (a short answer plus `file:line` proof, or
an honest "not found"). Assemble their output into the map yourself.
Judge nothing at this stage; a scout that volunteers a verdict is out of
contract. Then fan out the dimension children with that map pasted into
each task. Skip this for a path/domain scope or a diff/PR — the parent
reads the relevant files directly either way.

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
(e.g. a script with no domain layer has no DDD findings). Each dimension's
rubric lives in its own reference file — read it (yourself, or paste it
into a child's task per §1):

- **SOLID** — `references/solid.md`
- **DRY** — `references/dry.md`
- **KISS** — `references/kiss.md`
- **Typing** — `references/typing.md`
- **Error handling** — `references/errors.md`
- **DDD** — `references/ddd.md` (only where a domain layer exists)

## 4. Report

If dimensions were fanned out to subagents, verify before writing anything
down — a subagent's `path:line` claim is a lead, not confirmed evidence — but
not at the same depth for every finding:

- **A finding a top-line recommendation rests on** — read the full file. A
  `sed -n 'X,Yp'` window confirms the quote is real, not that the finding is
  correct; judging an SRP or DDD claim needs the surrounding contract. This
  is where you're supposed to pay the read cost.
- **A corroborating finding** (supports a recommendation but isn't the
  reason for it) — a targeted `sed -n 'X,Yp'` / `grep -n` against the cited
  lines is enough.
- **Everything else** — spot-check. (Pi, with `evidence-auditor` installed:
  hand a finding set to it in bulk instead of doing every targeted read
  yourself.)

State which tier each finding is in, so the reader knows what was checked
and at what depth. Drop or fix anything that doesn't hold up.

Dispatch dimension children with `outputMode: "file-only"`. Their chat
response is a pointer, not their findings. For a spot-check-tier finding,
read only the `## Index` line — never open the file for it. For a
top-two-tier finding, or one you're carrying into the report, open just
its `### <location>` section by heading, never the file whole. If an
index line is too thin to judge on its own, that is itself the finding.

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
