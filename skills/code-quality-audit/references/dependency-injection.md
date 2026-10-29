# Dependency Injection

Check dependency injection (DI) as a code-level design lens alongside SOLID.
DI means a consumer receives collaborators from its caller or composition
boundary rather than locating or constructing them internally. It is a
technique, not a mandate to add interfaces, containers, or factories.

## Check procedure

1. Trace a material dependency from its construction/lookup to its consumer.
   Read the relevant callers, configuration, lifecycle hooks, and tests; a
   constructor call alone is not evidence of a defect.
2. Establish a concrete consequence: does the current arrangement block a
   needed test double, real alternate implementation, runtime configuration,
   resource lifecycle/ownership, or isolation of side effects?
3. Check whether the seam is at the right level and no larger than needed.
   Consumers should receive the capabilities they use; composition belongs at
   the application/framework boundary. Respect framework-managed lifetimes.
4. Check for over-injection too: abstractions, wrappers, containers, or
   optional providers without a real variation, test, or lifecycle need.

Evidence needed: path/line, the dependency flow, the affected contract/test or
lifecycle, the consequence, counterevidence considered, and the smallest
correction. Apply repository conventions and language/framework idioms.

## Non-findings

- A small, stable, pure helper is called directly.
- A consumer receives a concrete collaborator; there is no demonstrated need
  for an interface or second implementation.
- A one-off script constructs a fixed resource at its entry point and has no
  meaningful test, configuration, or ownership problem.
- A framework owns injection and lifecycle at a clear composition boundary.
- A direct construction exists, but evidence shows it does not obstruct a
  relevant test, variation, or resource lifetime.

## Findings

A finding needs an observable design consequence, not just a preference for
DI. Examples include a use case constructing a network client such that its
behavior cannot be tested without real I/O, or a long-lived resource being
created and leaked by each consumer invocation. The correction may be a plain
parameter or constructor argument; introduce an abstraction only if the
consumer needs a stable contract or actual substitution.

If the correction crosses module boundaries, changes dependency direction, or
moves architectural ownership, send it to `architecture-audit`. Do not double
report an architectural issue as a local DI finding.
