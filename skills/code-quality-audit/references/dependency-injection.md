# Dependency Injection

Check dependency injection (DI) as a code-level design lens alongside SOLID.
DI means a consumer receives collaborators from its caller or composition
boundary rather than locating or constructing them internally. It is strict
for side effects and absent for pure code: it never mandates containers,
factories, or interfaces beyond the ports a side effect needs.

Mandatory in domain and application code: database, HTTP, broker,
filesystem, clock, randomness/ID generation and env/settings are received,
never constructed, imported as module singletons, read from globals, or
defaulted (`client=None` then `Client()`). One implementation is no
exemption, and the finding is P1. Inject the narrowest capability, not
`settings`, `container` or `app`.

## Check procedure

1. Trace a material dependency from its construction/lookup to its consumer.
   Read the relevant callers, configuration, lifecycle hooks, and tests; a
   constructor call alone is not evidence of a defect.
2. Name the consequence: for a mandatory side-effecting collaborator it is
   the test that now needs real I/O or the lifecycle the consumer can't
   manage; elsewhere it must be a concrete blocked test double, alternate
   implementation, runtime configuration or ownership need.
3. Check whether the seam is at the right level and no larger than needed.
   Consumers should receive the capabilities they use; composition belongs at
   the application/framework boundary. Respect framework-managed lifetimes.
4. Check for over-injection too: abstractions, wrappers, containers, or
   optional providers without a real variation, test, or lifecycle need.

Evidence needed: path/line, the dependency flow, the affected contract/test or
lifecycle, the consequence, counterevidence considered, and the smallest
correction. Use the language/framework idiom for the fix; a repo-wide habit
of constructing clients inline is one grouped finding, not an exemption.

## Non-findings

- A small, stable, pure helper or value object is called directly.
- A consumer receives a concrete collaborator for pure logic; there is no
  demonstrated need for an interface or second implementation.
- A one-off script constructs a fixed resource at its entry point and has no
  meaningful test, configuration, or ownership problem.
- A framework owns injection and lifecycle at a clear composition boundary.
- A direct construction of a non-side-effecting collaborator exists, and
  evidence shows it does not obstruct a relevant test, variation, or
  resource lifetime.

## Findings

A finding needs an observable design consequence, not just a preference for
DI; a side-effecting collaborator built inside domain or application code
always has one. Examples include a use case constructing a network client such that its
behavior cannot be tested without real I/O, or a long-lived resource being
created and leaked by each consumer invocation. The correction may be a plain
parameter or constructor argument; introduce an abstraction only if the
consumer needs a stable contract or actual substitution.

If the correction crosses module boundaries, changes dependency direction, or
moves architectural ownership, send it to `architecture-audit`. Do not double
report an architectural issue as a local DI finding.
