---
name: review-plan
description: Review an implementation plan against requirements, architecture and implementation risks. Not writing a plan (create-plan) or reviewing implemented code (review-implementation).
---

# Review Plan

Read the plan and references needed to establish its requirements and assumptions.
Read references/review.md for evidence, findings and coverage rules, and select
applicable lenses from references/lenses.md. A small plan needs no delegation.

Inventory requirements, proposed phases, changed interfaces and success criteria.
Check that the proposed ownership and placement follow the governing architecture
contract. Trace assumptions into actual source and callers. Identify missing
behavior, migration or compatibility hazards, unjustified abstractions and
verification gaps. Avoid prescribing additional work without a requirement,
adopted rule or concrete consequence.

If a previous review exists, compare its scope and source state and track its
findings while assessing remaining coverage. Distinguish newly missed issues
from changes to the plan or its assumptions.

### Fanning out

Bundled agent: `audit-reviewer` (agents/audit-reviewer.md). Delegate only
independent plan areas that justify it. Pass scope, plan path, governing rules,
selected lens criteria and references/review.md by absolute path. Reviewers
may inspect missing evidence themselves. The parent verifies material findings
and owns interactions between delegated areas.

<!-- agentic-hub: fanout -->

## Verdict and iteration

REVISE if any confirmed P0/P1 finding exists; COMMENT for only P2 findings;
APPROVE only with no confirmed findings and complete required coverage.
Otherwise use INCOMPLETE, unless confirmed findings already justify REVISE.

Save the review in the repository's existing reviews directory, alongside prior
plan reviews when present, or reviews/plans/<plan-stem>-review-1.md otherwise.
Include verdict, confirmed findings, coverage and unresolved concerns.
On follow-up, update the same review with resolved and remaining findings.

Present the consequential changes and recommend resolutions for conflicting
criteria. Edit the plan when authorized. Re-review affected requirements and
interfaces after edits, preserving previous evidence that remains valid.
