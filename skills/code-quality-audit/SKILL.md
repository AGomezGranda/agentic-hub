---
name: code-quality-audit
description: 'Audit code against SOLID, DRY, KISS, typing discipline, error handling and DDD modeling for a full repo, a bounded context/domain, or a git diff/PR. Use when asked to review code quality, check design principles, review a PR for design smells, or audit a domain structure. Not over-engineering (ponytail-review/audit), tests (testing-strategy), security or performance.'
argument-hint: '[repo | path/domain | diff/PR ref]'
---

# Code Quality Audit

Audit code against six design-correctness dimensions — SOLID, DRY, KISS,
typing, error handling, DDD — and report findings worth acting on.

**Audit, don't rewrite.** Produce a report. Only change code if the user asks
for that after seeing it. (Dispatching dimension children to a read-only
child enforces this structurally where the host supports it — without a
write capability it can't rewrite even if asked.)

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
  violations, whether DDD boundaries hold across the whole codebase. First
  produce one compact map (step 2), then choose the cheapest split. A small
  scope — a few files, one module, a focused diff — gets mapped,
  investigated, and checked by you directly, with no mandatory agent count.
  A large scope delegates by independent module/bounded context when that
  minimises duplicate reads. A targeted single-dimension child is allowed
  when its question is genuinely independent. A repository label alone does
  not justify delegation.
- **Path / domain / bounded context** — audit one module or aggregate in
  depth; still read its neighbours and callers to judge boundary leakage, but
  don't map the whole repo.
- **Diff / PR** — audit issues introduced or materially affected by the
  change, including consequences in unchanged callers. Read referenced
  sections on demand and expand to whole files for cross-cutting contracts;
  trace changed behaviour beyond changed lines when needed, but don't load
  full files and all callers exhaustively for a trivial change.

### Fanning out

Bundled agent for this skill: `cq-dimension` (takes an explicit bounded
scope and one or more applicable dimensions — see `agents/cq-dimension.md`);
if it isn't installed, use a host-native child or do the check yourself.
Each child's task text must carry everything it needs — don't depend on
inherited context: the domain map/conventions from step 2, that
dimension's rubric pasted verbatim from its `references/<dimension>.md`
file (absolute path, not just the dimension's name), known contracts, the
output/evidence rules from "Child finding schema" below, and a read-only
restriction. Assign cross-area dependencies to yourself so module splits do
not hide coupling. Tell each child to return findings in the "Child finding
schema" below. Wait for all before synthesizing the report.

<!-- agentic-hub: fanout -->

### Child finding schema

Every child — and every dimension you check yourself — reports findings in
this shape, one block per finding:

```
finding ID: <stable ID, unique per finding even at the same location>
severity: P0 | P1 | P2
confidence: high | medium | low
location: path:line
excerpt: verbatim quoted line(s), not a paraphrase
violated contract: the invariant, interface, or rule broken
consequence: concrete correctness/design effect if left as-is
counterevidence considered: what was checked that could disprove it
correction: smallest sufficient change
finding: one paragraph — what's wrong and why it matters
strengths: optional — what's solid here, not just what's wrong
```

Keep each block compact; these are fields, not eight verbose paragraphs.
IDs distinguish multiple findings at the same location and survive
deduplication.

If a child has nothing to report for its dimension, it says exactly:
`No issues found. Checked: <what>. Solid because: <one line>.` A bare
"No issues found." can't feed step 4's "Explicitly fine" section — the
structured version can. If a child's output doesn't parse into this shape,
normalise recoverable fields; request one targeted correction if needed.
If still unusable, report an investigation failure with its uncovered scope.
Never manufacture a defect or severity from missing formatting. Do not retry
in a loop.

## 2. Map before judging

One inventory pass suffices for the map: ask a `repo-scout` for domain
vocabulary, layering, and existing conventions — or gather them yourself
for a small scope — each with evidence (a short answer plus `file:line`
proof, or an honest "not found"). Assemble the map yourself. Judge nothing at this stage; a scout that volunteers a verdict is out of contract. Then
delegate by module/bounded context (per §1) with that map pasted into each
task. Skip separate mapping for a path/domain scope or a diff/PR — read
the relevant files directly either way.

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
into a child's task per §1). Each rubric gives a compact check procedure,
evidence needed, a defect/correction example where useful, and a legitimate
non-finding:

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
- **Everything else** — spot-check.

State which tier each finding is in, so the reader knows what was checked
and at what depth. Drop or fix anything that doesn't hold up.

Candidate summaries and indexes are navigation aids only. Before publishing
a finding, inspect its full rationale and enough original code, callers,
configuration, or tests to establish the claim. Expand reads when the
contract is unclear; whole-file rereads are not automatically required.
A checked quotation alone is insufficient.

Keep an internal candidate disposition: confirmed, rejected, or unresolved.
Only confirmed findings enter the prioritised defect list. Unresolved
concerns name the missing evidence and next probe. Do not publish a dump of
rejected candidates.

Coverage ledger: list in-scope areas and applicable dimensions as checked,
not applicable with reason, or unverified with reason. An unverified area is
never described as clean. Scope may be bounded, but say what was excluded or
sampled.

1. **Scope and model** — two or three sentences: what was audited, what
   domain layer (if any) exists, which dimensions actually applied.
2. **Findings** — one entry per confirmed finding with its finding ID,
   severity, confidence, location and evidence, violated contract,
   consequence, counterevidence considered, and smallest sufficient
   correction. Rank by severity, then consequence/confidence; dimensions are
   tags or secondary grouping. State effort separately so a cheap cosmetic
   fix cannot displace a serious issue.
3. **Explicitly fine** — dimensions checked and found solid. One line each,
   with a bounded claim and evidence; there is no quota for strengths or
   defects.
4. **Out of scope, flagged anyway** — anything that's clearly a security,
   performance, or over-engineering issue spotted along the way; name it and
   point at the right skill instead of addressing it.
5. **Coverage and unresolved** — the ledger plus any unresolved concerns with
   missing evidence and next probe.

## Judgement rules

- **Cite evidence.** Every finding is a real path/line, not a generic
  principle restated. Advice that would read the same for any repo is not a
  finding. Positive findings require a bounded claim and evidence; there is
  no quota for strengths or defects.
- **Treat repository conventions as context.** Group a systemic problem once
  with representative instances and affected scope, while keeping independent
  root causes separate. Consistency does not excuse harmful practices. A repo
  that's consistently loose with typing gets one grouped finding with scope,
  not fifty copies — but it still gets the finding.
- **Severity is consequence-based, not purity.** P0 = critical failure
  requiring immediate action; P1 = substantial correctness/design consequence
  requiring correction before proceeding with the affected change; P2 =
  material, nonblocking maintainability or reliability improvement.
  Preference-only suggestions are not defects. Confidence is independent of
  severity; low-confidence concerns remain unresolved rather than being
  inflated or disguised as P2. A DIP violation with one concrete dependency
  that will never change is a non-issue; the same violation blocking a needed
  test double or a real second implementation is a real finding.
- **Don't invent a violation to fill a dimension.** If SOLID has nothing to
  say about a 40-line script, the table is empty. Say so.
