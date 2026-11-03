# Target architecture standard

This is the bar every lens judges against. The repository's current
structure is the thing under audit, not the baseline: "most modules already
do it this way" measures blast radius, never correctness. A rule yields only
to a repo ADR that names the rule, the deviation and the reason. Cite rules
by ID (e.g. `L2`, `D1`) in each finding's violated contract.

## Applicability — classify the scope first, with evidence

- **Domain service** — has business rules or invariants (money, limits,
  state transitions, eligibility, scheduling). The full standard applies.
- **Integration/CRUD service** — moves or exposes data with no rule beyond
  input validation. L, D and S apply; T does not.
- **Script, CLI tool or library** — D1–D3 and S3 apply to its core logic.

Name the invariants found, or searched for and not found. An invariant in
a "CRUD" service makes it a domain service and the missing domain layer
the finding; under-classifying to dodge findings is how audits go soft.

## L — Layers and dependency direction

Dependencies point inward: `adapters → application → domain`, all wired by
the composition root.

- **L1** Domain imports nothing from application, adapters, frameworks,
  ORM, HTTP, brokers, or settings/env. Allowed: stdlib, the shared kernel,
  pure libraries with no I/O.
- **L2** Application (use cases) orchestrates: load through ports, call
  domain behaviour, commit, publish. It holds no business rule (a branch on
  domain state that decides an outcome belongs in the domain) and no
  vendor, ORM or HTTP types.
- **L3** Ports are owned by the consumer: outbound ports (repositories,
  gateways, clock, ID source, publisher) are declared in domain or
  application in domain terms. Adapters implement them and translate vendor
  types and exceptions; none cross the port.
- **L4** Inbound adapters (HTTP, CLI, consumers, jobs) are thin: parse and
  validate, map to a command, call one use case, map result or error back.
  No business logic, no direct repository or ORM use.
- **L5** No module-level import cycles, including ones hidden behind
  function-local imports.

## T — Tactical DDD (domain services)

- **T1** Every invariant has one owner. An aggregate (or a domain service
  when the rule spans aggregates) enforces it. State changes go through
  intention-revealing methods; no public setters or mutable collections
  escape.
- **T2** Aggregates reference other aggregates by ID. One transaction
  changes one aggregate; cross-aggregate consistency goes through domain
  events or a process manager.
- **T3** Domain concepts with rules or units are value objects, not
  primitives: money, currency, rates, IDs, date ranges, quantities. Float
  for money is P1.
- **T4** One repository per aggregate root, returning aggregates in domain
  types. No generic `Repository[T]` or query builder leaking to callers.
- **T5** Code uses the ubiquitous language of tickets and docs. Technical
  names standing in for domain concepts (`Manager`, `Processor`, `Helper`,
  `DataService`) are a finding when a domain term exists.
- **T6** Bounded contexts integrate only through published interfaces
  (API, events, client). Never another context's tables, ORM models or
  internal enums. External models are translated at an anti-corruption
  layer at the edge.

## D — Dependency injection and composition

- **D1** Side-effecting collaborators (database, HTTP, broker, filesystem,
  clock, randomness and ID generation, env/settings) are injected into
  domain and application code. They are never constructed, imported as
  module singletons, or looked up there. "Only one implementation" is no
  exemption: the seam exists for tests and lifecycle, not just substitution.
- **D2** One composition root per process (`main`, app factory, worker
  bootstrap) builds the object graph and owns lifecycles. Only config
  loading at the root reads env; it passes typed config down.
- **D3** Constructor injection for long-lived collaborators, parameters for
  per-call values. No service locator, global registry, lazy `get_x()`
  singleton consulted from business code, or optional parameter that
  silently builds a real client (`client=None` → `Client()`).
- **D4** Inject the narrowest capability (a port), not `container` or `settings`.
- **D5** Pure helpers and value objects are not injected, and interfaces
  exist only at ports (L3). An interface over pure logic with one
  implementation is over-engineering: route to ponytail, not a D finding.

## S — Folder structure

- **S1** Package by bounded context or feature first, then by layer:

  ```text
  src/<package>/
    <context>/              # payments/, pricing/ ...
      domain/               # aggregates, value objects, events, owned ports
      application/          # use cases / command handlers
      adapters/             # inbound (api/, consumers/) and outbound (db/, clients/)
      __init__.py           # the context's public surface (index.ts in TS)
    shared_kernel/          # small, stable: Money, IDs, Clock port
    main.py | entrypoints/  # composition root(s)
  tests/                    # mirrors src/; unit, integration, component, contract
  ```

  A single-context service may drop the `<context>/` level; never the layers.
- **S2** Layer-first top level (`models/`, `services/`, `controllers/`,
  `repositories/` spanning every feature) is a finding once there is more
  than one context: every feature change touches every top-level folder.
- **S3** No junk drawers: `utils`, `helpers`, `common`, `misc`, `core`,
  `lib` with mixed responsibilities. A module's name says what it owns.
- **S4** One home per kind of artefact: schemas, ORM models, settings and
  clients each live in one predictable place per context, not two.
- **S5** Cross-context imports go through the package root only, never
  `<other>.domain.*` or `<other>.adapters.*`.
- **S6** ORM and framework models live in adapters; the domain model is not
  the ORM model unless an ADR accepts active record for a CRUD context.

## E — Enforcement

- **E1** Every L, S and D rule a tool can check is checked in CI. Python:
  `import-linter` (`layers` per context, `independence` between contexts,
  `forbidden` domain → framework/ORM/HTTP), ruff `TID251` banned-api.
  TypeScript: `dependency-cruiser` or eslint `no-restricted-imports`. Plus
  one test asserting the folder layout. A rule enforced only by review is
  an enforcement gap: report it with the concrete contract to add.

## Severity

A standard violation is always reported, grouped once if systemic. Its
consequence is the rule's rationale made concrete for this repo: the test
that needs real I/O, the feature change that touches N folders, the path
that bypasses the invariant. P1: L1, T1 or a missing domain layer in a domain
service; T3 float money; T6; D1 in domain/application; L5 between contexts;
D2 when a process has no root; S2 with sampled commits spanning layers.
P2: any other rule. P0 still requires incorrect production behaviour now.
