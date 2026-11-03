# Lenses

| Lens | Focus |
|---|---|
| Architecture | modularity, coupling, scalability, tradeoffs; new files, layers, ports and wiring placed per the target standard `skills/architecture-audit/references/standard.md` (DDD layers, DI/composition root, package-by-context layout), not just next to similar existing code |
| Security | authn/authz, input handling, secrets, STRIDE/OWASP |
| Test Coverage | test-first/TDD, pyramid balance, edge cases, isolation, right-level coverage |
| Code Quality | design principles, error handling, complexity |
| Correctness | logical validity, boundaries, state, concurrency |
| Simplicity | YAGNI: work nobody asked for, speculative abstraction/config/options, phases or steps that can be cut or merged, building what the codebase, stdlib or an installed dep already provides |
| Standards | conventions, API shape, accessibility |
| Usability | DX, API ergonomics, config, onboarding |
| Performance | efficiency, resource use, caching |
| Documentation | completeness, accuracy for the audience |
| Database | migration safety, schema, query correctness |
| Compatibility | API contracts, deps, versioning |
| Portability | env independence, deployment, vendor lock |
| Safety | data-loss prevention, ops safety on critical paths |
