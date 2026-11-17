# Lenses

| Lens | Focus |
|---|---|
| Architecture | modularity, coupling, scalability, tradeoffs; new files, layers, ports and wiring placed per the target standard `skills/architecture-audit/references/standard.md` (DDD layers, DI/composition root, package-by-context layout), not just next to similar existing code |
| Security | authn/authz, input handling, secrets, STRIDE/OWASP |
| Test Coverage | test-first/TDD, pyramid balance, edge cases, isolation, right-level coverage |
| Code Quality | design principles, error handling, complexity |
| Correctness | logical validity, boundaries, state, concurrency, atomic writes, duplicate-safe retries and partial-failure recovery |
| Simplicity | YAGNI: work nobody asked for (bounded restructuring of touched code toward the standard is asked for — not a YAGNI finding), speculative abstraction/config/options, phases or steps that can be cut or merged, building what the codebase, stdlib or an installed dep already provides |
| Standards | conventions, API shape, accessibility |
| Usability | DX, API ergonomics, config, onboarding |
| Performance | efficiency, resource use, caching |
| Documentation | completeness, accuracy for the audience |
| Database | migration safety, schema, query correctness |
| Compatibility | API contracts, deps, versioning |
| Portability | env independence, deployment, vendor lock |
| Safety | data-loss prevention, timeout/cancellation, bounded work, resource cleanup, shutdown and observable failures on critical paths |

## Grouping assignments

For a connected plan, group applicable lenses into at most three assignments:

| Assignment | Lenses |
|---|---|
| Behavior and safety | Correctness, Security, Safety, Database, Compatibility |
| Design and simplicity | Architecture, Code Quality, Simplicity |
| Verification and operation | Test Coverage, Performance, Portability, Standards, Usability, Documentation |

These are default work groupings, not new agents or weaker rubrics. For large
independent plan areas, split by area instead and apply all relevant lenses
within each. Give each reviewer the full criteria for its assigned lenses;
never replace the criteria with just a group label. The parent checks
interactions across groups, reconciles conflicts and verifies material findings.
