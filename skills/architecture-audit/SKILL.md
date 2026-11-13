---
name: architecture-audit
description: 'Audit dependency boundaries, responsibility ownership, and file placement against an explicit architecture standard for a repository, module, or diff. Not class-level design (code-quality-audit), test strategy, security, or performance.'
argument-hint: '[repo | path/bounded context | diff/PR ref]'
---

# Architecture Audit

Produce a read-only audit. Read references/review.md for evidence, severity
and completion requirements and references/checks.md for investigation checks.

## Scope and standard

Resolve the repository, context or diff and its source state. A diff audit
covers introduced or materially affected boundaries and ownership, including
unchanged callers. A context audit includes its incoming and outgoing edges.

Use the explicitly requested or repository-declared architecture contract.
If none exists, use references/standard.md as this skill's strict default and
disclose that choice. Existing structure is under audit, not the baseline.
Accepted ADRs may document deviations. Prevalence does not excuse violations.
Identify conflicting governing instructions before claiming compliance.

Apply the standard's scope classification using evidence of actual invariants.
Preserve strict DDD, DI and placement rules when this profile is selected;
do not infer that every repository has already adopted it.

## Investigation

Inventory modules, public interfaces, dependency edges, state writers and
invariant owners. Record applicable rule IDs against these items. Run configured
architecture checkers and inspect failures in context. Without a graph tool,
inspect imports and calls; static searches cannot prove absence of dynamic
or external edges.

Trace business rules and state transitions through relevant entry points.
Compare placement with the governing layout and ownership map. Use co-change
history when investigating locality; a shared commit is a lead whose reason
needs inspection, not proof of coupling.

Report every confirmed standard violation, grouping systemic instances.
Distinguish compliance violations from recommendations outside the standard.
For enforcement gaps, name the adopted rule and feasible checker.

### Fanning out

Bundled agent: `audit-reviewer` (agents/audit-reviewer.md). Work directly on
small scopes. Prefer independent module/context scopes over separate reviewers
rereading the same code for individual principles. A `repo-scout` may locate
modules but does not judge them. Pass scope, governing standard, applicable
checks and references/review.md by absolute path, plus known evidence.
Reviewers investigate missing evidence themselves. The parent owns edges
between delegated areas and verifies material findings.

<!-- agentic-hub: fanout -->
