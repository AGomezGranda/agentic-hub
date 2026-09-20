---
name: review-plan
description: Review an implementation plan through multiple quality lenses (architecture, security, tests, etc.) using parallel subagents, then collaboratively iterate the plan. Use before implementing a plan.
---

# Review Plan

## 1. Read the plan FULLY

Read the plan file and anything it references (no offset/limit). Note its
scope: what layers/technologies it touches, complexity, risk.

Before picking a path, check for an existing plans  or reviews dir: `find . -type d -iname plans -not -path '*/node_modules/*'`  `find . -type d -iname reviews -not -path '*/node_modules/*'`.

If one exists (e.g. `meta/reviews/`, `docs/reviews/`), use it as reference for the review folder.

Check for a prior review at `reviews/plans/{plan-stem}-review-*.md`. If one
exists, read the latest, tell the user its verdict, and use it as context for
what recurs vs. what's been fixed — but still review the plan fresh.

## 2. Pick lenses

| Lens | Focus |
|---|---|
| Architecture | modularity, coupling, scalability, tradeoffs |
| Security | authn/authz, input handling, secrets, STRIDE/OWASP |
| Test Coverage | test-first/TDD, pyramid balance, edge cases, isolation, right-level coverage |
| Code Quality | design principles, error handling, complexity |
| Correctness | logical validity, boundaries, state, concurrency |
| Standards | conventions, API shape, accessibility |
| Usability | DX, API ergonomics, config, onboarding |
| Performance | efficiency, resource use, caching |
| Documentation | completeness, accuracy for the audience |
| Database | migration safety, schema, query correctness |
| Compatibility | API contracts, deps, versioning |
| Portability | env independence, deployment, vendor lock |
| Safety | data-loss prevention, ops safety on critical paths |

Architecture, Code Quality, Test Coverage, and Correctness are near-always
relevant. Pick the rest by what the plan actually touches — skip lenses that
plainly don't apply (a docs-only plan doesn't need a Security lens). Aim for
4-5 lenses. If the user gave focus areas, prioritize those. State your
selection and skip-reasons, then proceed (no need to block on confirmation
for a routine review).

## 3. Spawn reviewers in parallel

One `subagent` workflow call, one child per lens, fanned out together (not a
loop of sequential single calls). Each child's task:

```
Review the plan at <path> through the [LENS] lens: [1-line focus from the table].
Read the plan fully, and read whatever source it references for context.
Return: a short summary, a list of strengths, and a list of findings. Each
finding needs: severity (critical/major/minor/suggestion), confidence
(high/medium/low), a location (which plan section), and a one-paragraph body.
Be specific and reference the plan section, not vague.
```

Wait for all children before continuing. If a child's output doesn't parse
into that shape, keep its raw text as a single "major" finding under its lens
name rather than dropping it.

## 4. Aggregate

- Merge findings across lenses; only merge two findings if they're about the
  *same* underlying concern from different angles, not just nearby text.
- Sort by severity (critical > major > minor > suggestion), then confidence.
- Verdict: `REVISE` if any critical finding or 2+ major findings exist,
  `COMMENT` if only minor/suggestion findings, `APPROVE` if none.
- Call out cross-cutting themes (2+ lenses flagging the same thing) and any
  tradeoffs where lenses conflict (e.g. security wants more validation,
  usability wants less friction) — present both sides, don't referee for
  the user.

Write the review to `reviews/plans/{plan-stem}-review-{N}.md` (N = next
unused number), formatted:

```markdown
## Plan Review: {plan title}
**Verdict:** APPROVE | REVISE | COMMENT
{2-3 sentence synthesis across lenses}

### Cross-Cutting Themes
### Findings
#### Critical / Major / Minor / Suggestions
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
what was deliberately skipped and why.

Offer a re-review pass afterward: re-run only the lenses that had findings,
compare titles against the previous pass (resolved / partially / still
present), append a dated `## Re-Review (Pass N)` section to the same review
file rather than creating a new one.
