---
name: review-implementation
description: Review uncommitted changes against their implementation plan and affected code contracts. Not reviewing a plan before implementation (review-plan) or implementing changes (implement-plan).
---

# Review Implementation

Read references/review.md for evidence, findings and completion requirements.
Resolve the plan and implemented phase from the request and actual diff.
Do not assume the first unchecked phase is the one just implemented: execution
may already have checked it off. If no plan is available, review the code and
state that plan conformance is unverified.

Scope local changes with git status --short, git diff HEAD, and direct reads
of untracked files. Do not include branch history in an uncommitted review.
Read the relevant plan requirements and source contracts, expanding to callers,
configuration and tests where behavior depends on them.

Map requirements and success criteria to changes. Report missing behavior,
unexplained deviations and extra scope. Run applicable checks when authorized;
otherwise record them as unverified. Judge correctness, ownership, boundaries,
design, tests and security where the actual change warrants them. Use the
repository's architecture contract and relevant audit checks. Do not launch
a full-repository audit merely because a diff touches a boundary.

### Fanning out

Bundled agent: `audit-reviewer` (agents/audit-reviewer.md). Work directly on
small changes. For independent substantial areas, pass the exact scope,
plan requirements, applicable check references and references/review.md by
absolute path. The parent owns interactions across assignments and verifies
material findings. Hosts with the Pi workflow may use pi/workflows/swarm.js
with the same exact scope; other hosts use their native delegation tools.

<!-- agentic-hub: fanout -->

Report plan conformance, confirmed findings, completed checks and remaining
coverage. Review does not authorize fixes. When fixes are authorized, recheck
them and affected contracts, classifying new findings against the prior pass.
A bounded number of rounds limits work, not the meaning of complete coverage.
