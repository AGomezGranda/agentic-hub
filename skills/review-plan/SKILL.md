---
name: review-plan
description: Review an implementation plan through quality lenses (architecture, security, tests, etc.), then collaboratively iterate the plan. Use before implementing a plan. Not writing the plan (create-plan) or executing it (implement-plan).
---

# Review Plan

## 1. Read the plan FULLY

Read the plan file and anything it references (no offset/limit). Note its
scope: what layers/technologies it touches, complexity, risk.

Before picking a path, check for an existing plans or reviews dir:
`find . -type d -iname plans -not -path '*/node_modules/*'`
`find . -type d -iname reviews -not -path '*/node_modules/*'`

If one exists (e.g. `meta/reviews/`, `docs/reviews/`), use it as reference for the review folder.

Check for a prior review at `reviews/plans/{plan-stem}-review-*.md`. If one
exists, read the latest, tell the user its verdict, and use it as context for
what recurs vs. what's been fixed — but still review the plan fresh.

## 2. Pick lenses

Full lens table (focus area per lens): `references/lenses.md`.

Architecture, Code Quality, Test Coverage, and Correctness are near-always
relevant. Pick the rest by what the plan actually touches — skip lenses that
plainly don't apply (a docs-only plan doesn't need a Security lens). Combine
related lenses that share the same source set in one reviewer; keep an
independent second view only for high-risk or disputed conclusions. A small,
low-risk plan gets reviewed by you directly with no children. If the user
gave focus areas, prioritize those. State your selection and skip-reasons,
then proceed (no need to block on confirmation for a routine review).

## 3. Spawn reviewers

Dispatch one child per selected lens-group together per host — see "Fanning
out" below. Each child's task carries its explicit bounded scope plus:

```
Review the plan at <path> through these lenses: [each lens + its 1-line
focus from the table].
Read the plan fully, and read whatever source it references for context.
Return: a short summary, a list of strengths, and a list of findings. Each
finding needs: finding ID (stable, unique per finding), severity (P0/P1/P2),
confidence (high/medium/low), a location (which plan section), violated
contract, concrete consequence, counterevidence considered, and smallest
sufficient correction, plus a one-paragraph body. Be specific and reference the
plan section, not vague.
```

Wait for all children before continuing. If a child's output doesn't parse
into that shape, normalise recoverable fields; request one targeted
correction if needed. If still unusable, report an investigation failure with
its uncovered scope. Never manufacture a defect or severity from missing
formatting. Do not retry in a loop.

This is the same P0/P1/P2 vocabulary `code-quality-audit`/`testing-strategy`
use for their judgement findings — one vocabulary, no mapping needed if a
finding from either of those ever needs folding in here.

### Fanning out

Bundled agent for this skill: `plan-lens` (takes an explicit bounded scope
and one or more applicable lenses — see `agents/plan-lens.md`); if it isn't
installed, use a host-native child or review the lens-group yourself.

<!-- agentic-hub: fanout -->

## 4. Aggregate

- Merge findings across lenses; only merge two findings if they're about the
  *same* underlying concern from different angles, not just nearby text.
- Candidate summaries and indexes are navigation aids only. Before publishing
  a finding, inspect its full rationale and enough plan text plus referenced
  source to establish the claim. Expand reads when the contract is unclear;
  whole-file rereads are not automatically required. A checked quotation alone
  is insufficient.
- Keep an internal candidate disposition: confirmed, rejected, or unresolved.
  Only confirmed findings drive the verdict. Unresolved concerns name the
  missing evidence and next probe. Do not publish a dump of rejected candidates.
- Coverage ledger: list in-scope lenses and plan areas as checked, not
  applicable with reason, or unverified with reason. An unverified area is
  never described as clean. Scope may be bounded, but say what was excluded.
- Positive findings require a bounded claim and evidence; there is no quota
  for strengths or defects. Treat repository conventions as context: group a
  systemic problem once with representative instances, keep independent root
  causes separate, and never let consistency excuse a harmful practice.
- Severity is consequence-based: P0 = critical failure requiring immediate
  action; P1 = substantial correctness/design consequence requiring correction
  before proceeding with the affected change; P2 = material, nonblocking
  maintainability or reliability improvement. Preference-only suggestions are
  not defects. Confidence is independent of severity; low-confidence concerns
  remain unresolved rather than being inflated or disguised as P2.
- Rank by severity, then consequence/confidence; lenses are tags or secondary
  grouping. State effort separately.
- Verdict: `REVISE` if any confirmed P0/P1 finding exists, `COMMENT` if only
  confirmed P2 findings, `APPROVE` if no confirmed findings and adequate
  completed coverage, `INCOMPLETE` if required coverage is incomplete (unless
  confirmed findings already justify REVISE). Render all four values
  consistently.
- Call out cross-cutting themes (2+ lenses flagging the same thing) and any
  tradeoffs where lenses conflict (e.g. security wants more validation,
  usability wants less friction) — present both sides, don't referee for
  the user.

Write the review to `reviews/plans/{plan-stem}-review-{N}.md` (N = next
unused number), formatted:

```markdown
## Plan Review: {plan title}
**Verdict:** APPROVE | REVISE | COMMENT | INCOMPLETE
{2-3 sentence synthesis across lenses}

### Coverage
{ledger: checked / not applicable with reason / unverified with reason}

### Cross-Cutting Themes
### Findings
#### Critical / Major / Minor
- 🔴/🟡/🔵 **{lens}**: {title} — **Location**: {section} — {summary}

### Strengths
- ✅ {deduped strengths, not repeated per-finding}

### Recommended Changes
1. {actionable change} (addresses: {findings})
```

Use real emoji (🔴🟡🔵✅), not shortcodes. Strengths go only in the summary,
never as individual findings.

## 5. Iterate with the user

Present the review, ask what to address, edit the plan file directly and
conservatively (targeted edits, not rewrites), then summarize what changed and
what was deliberately skipped and why. Where lenses compete, recommend a
resolution with evidence and tradeoffs from both sides — ask the user only
for genuinely value-dependent decisions.

Offer a re-review pass afterward: re-run the affected lenses and any newly
affected interfaces, not just the lenses that previously found defects.
Compare titles against the previous pass (resolved / partially / still
present), append a dated `## Re-Review (Pass N)` section to the same review
file rather than creating a new one.
