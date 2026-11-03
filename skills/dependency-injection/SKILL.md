---
name: dependency-injection
description: 'Apply or audit dependency-injection practices in any language or framework. Use when implementing code that creates or consumes collaborators, choosing how to wire services/resources, or explicitly reviewing dependency injection. Mandatory for side-effecting collaborators (database, HTTP, broker, filesystem, clock, randomness, env) in domain and application code, with one composition root per process; never needed for pure helpers. Not dependency-version/security audits or cross-module architecture review (architecture-audit).'
argument-hint: '[implementation task | repo | path | diff/PR]'
---

# Dependency Injection

Use dependency injection (DI) as a way to make meaningful dependencies visible
and supplied from outside the code that uses them. Keep the mechanism idiomatic
to the language and framework; DI does not require a container, an interface,
or a class.

## When implementing

1. Identify the collaborators the code actually needs, especially resources
   with side effects (network, storage, filesystem, clock, randomness),
   replaceable policies, or services with meaningful lifecycle/ownership.
2. Side-effecting collaborators (database, HTTP, broker, filesystem,
   clock, randomness/ID generation, env/settings) used by domain or
   application code are always injected, even with one implementation: the
   seam is for tests and lifecycle, not only substitution. For everything
   else, inject only when it buys isolated tests, a real alternative,
   runtime configuration, controlled lifetime, or clearer ownership;
   otherwise keep the simple direct call.
3. Choose the smallest idiomatic seam: a function argument for per-call
   variation, a constructor for a long-lived collaborator, a closure for a
   narrow callback, or a factory/provider when creation must be deferred or
   produce a fresh instance. Use the framework's injection mechanism when it
   owns the lifecycle or the project already relies on it.
4. Assemble the object graph in one composition root per process (`main`,
   app factory, worker bootstrap); only it reads env and builds clients.
   Pass a consumer only the capabilities it needs (a port, not `settings`
   or a container); business logic never finds dependencies in a global
   registry, service locator, or lazy module singleton.
5. Preserve ownership and lifecycle semantics: initialization, cleanup, scope,
   concurrency, and error behavior must remain correct after moving creation.
   Do not manually construct resources managed by a framework/container.

### Defaults

- Dependencies with effects or lifetime are explicit, always. Benign
  values and stable, pure helpers are not injected merely to make every
  call configurable.
- A consumer may receive a concrete dependency. Add an abstraction only when
  it expresses a useful contract or enables a real variation; DI and
  dependency inversion are related but not the same requirement.
- Keep construction near the outer edge and behavior in the consumer. A
  factory is useful for deferred or repeated creation, not just to hide a
  constructor behind another name.
- Avoid ambient mutable state, service locators, hidden I/O during object
  construction, and optional parameters that silently create substantial
  services. Do not introduce a container, interface, provider layer, or
  configuration surface without a concrete need.
- If many dependencies are needed, check whether the consumer has too many
  responsibilities before routing them through a container.
- Follow established framework conventions when they preserve clear
  ownership and test seams; do not transplant another language's DI idioms.

## When auditing

**Audit, don't rewrite.** Match the language/framework idiom for corrections, but
judge against the rules above, not the repository's habits. Inspect both where
dependencies are assembled and where they are consumed.
For the requested scope:

- Trace important dependencies from their creation or lookup to the consumer.
  Check calls, constructors, configuration, lifecycle hooks, and relevant
  tests; do not infer a defect from one `new`/constructor call in isolation.
- Look for dependencies hidden in globals, module state, service locators,
  framework lookups, or consumer-owned construction. A side-effecting one
  inside domain or application code is a finding outright, even when the
  whole repo does it (one grouped finding). For others, verify it impairs a
  needed test, alternate implementation, configuration, lifetime or
  ownership.
- Check that the composition boundary owns assembly and that the consumer gets
  only the capabilities it needs. Respect framework-managed scopes and
  lifetimes.
- Check the opposite failure too: abstractions, wrappers, containers, or
  injection parameters that add indirection without a real seam or ownership
  need.
- Report only evidence-backed issues with a concrete consequence and the
  smallest sufficient correction. State checked areas with no issue rather
  than inventing a DI violation to fill the report.

A local constructor/function-level issue belongs in the DI lens of
`code-quality-audit` when that audit is requested. If fixing it changes module
boundaries, dependency direction, or ownership across architectural layers,
route that finding to `architecture-audit`; do not duplicate it as a class-level
DI finding. Dependency health, security, and performance audits are separate
concerns.
