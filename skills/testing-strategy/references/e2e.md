# End-to-end testing

> An end-to-end test verifies that a system meets external requirements and
> achieves its goals, testing the entire system, from end to end.

The system is a black box, exercised through public interfaces — GUIs (via
Selenium WebDriver or similar) or service APIs (via an HTTP client) — and
correctness is judged by state changes or events at the test boundary.
Being business-facing, they commonly use a business-readable DSL.

What they uniquely buy in a microservice architecture:

- Coverage of the **gaps between services**, including network
  infrastructure (firewalls, proxies, load balancers) that no other level
  exercises.
- Confidence during **large-scale architectural refactoring** — as
  services split and merge, E2E tests confirm business functions survive.

Externally managed services are usually inside the boundary, but may be
excluded when a third party makes repeatable, side-effect-free testing
impossible or when reliability problems cause failures outside the team's
control. Stubbing them trades end-to-end confidence for suite stability.

E2E tests have the most moving parts, hence the most reasons to fail, plus
asynchrony in the GUI and backend — producing flakiness, long runtimes and
maintenance cost. The deck's five guidelines:

1. **Write as few as possible.** Confirm everything ties together, not
   comprehensively test business requirements — lower levels already give
   that confidence. Apply a **time budget**, of the order of minutes, not
   hours. When the suite exceeds it, delete the least valuable tests.
2. **Focus on personas and user journeys.** Model tests on real users and
   the journeys they make, leaving the rest to other levels. (Tools:
   Gauge, Concordion.)
3. **Choose your ends wisely.** If a particular external service or GUI is
   a major source of flakiness, redefine the boundary to exclude it —
   acceptable as long as another form of testing covers that component.
4. **Rely on infrastructure-as-code for repeatability.** Building a fresh
   environment per suite run improves reliability and doubles as a test of
   the deployment logic.
5. **Make tests data-independent.** Relying on pre-existing data causes
   *false failures*. Have tests define their world up front via public or
   internal APIs; import canned data only for services that can't
   construct their own entities.

Alternative the deck also records: some teams skip E2E entirely in favour
of thorough **production monitoring and testing in production** —
**synthetic transactions** supplementing monitoring, plus alerting when
key business metrics fall outside acceptable norms.

## Audit heuristic **[not in source]**

An E2E suite that exceeds a minutes-scale budget, is not persona-shaped, or
depends on pre-seeded shared data will produce false failures and erode
trust.
