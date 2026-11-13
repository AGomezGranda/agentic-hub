---
name: code-quality-audit
description: 'Audit class and function design, simplicity, duplication, typing, dependency injection, and error handling in a repository, module, or diff. Not architectural ownership across modules (architecture-audit), test strategy, security, or performance.'
argument-hint: '[repo | path | diff/PR ref]'
---

# Code Quality Audit

Produce a read-only report using references/review.md for evidence, severity
and completion requirements. Read references/checks.md for design checks and
legitimate exceptions.

Resolve scope and source state. A diff audit covers introduced or materially
affected behavior and consequences in unchanged callers. A module audit
includes public contracts and consumers. A repository audit starts with a
bounded inventory of modules and public contracts.

Identify domain vocabulary, explicit requirements, dependency lifecycles and
error conventions. Conventions explain scope and compatible corrections;
consistency alone does not excuse a defect. Apply the adopted architecture
contract to DI choices. Without one, justify recommendations by testability,
lifecycle or caller-visible effects; do not silently impose another profile.

Work through applicable checks against the inventory. Follow behavior through
callers, error paths and tests; do not stop after a few promising examples.
Inspect counterevidence before proposing corrections. Simplicity and unnecessary
abstraction belong here alongside SOLID; KISS findings need no second audit.

Corrections changing cross-module ownership or dependency direction are
architectural: identify that decision within the finding without duplicating
it or automatically launching another audit. Incidental security, performance or
test-strategy concerns do not establish coverage of those areas.

### Fanning out

Bundled agent: `audit-reviewer` (agents/audit-reviewer.md). Work directly on
small scopes. Delegate larger independent modules/contexts with absolute paths
to applicable checks and references/review.md, known contracts and scope.
A `repo-scout` can locate code but does not judge it. Reviewers investigate
missing evidence with available tools. The parent owns cross-area contracts
and verifies material findings. An independent second assessment is useful
for high-risk or disputed conclusions when justified.

<!-- agentic-hub: fanout -->
