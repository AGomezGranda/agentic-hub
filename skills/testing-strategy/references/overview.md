# Testing Strategies in a Microservice Architecture — overview

Reference notes for the `testing-strategy` skill. Faithful summary of the
infodeck "Testing Strategies in a Microservice Architecture" (18 November
2014): <https://martinfowler.com/articles/microservice-testing/>. Read this
file first; `unit.md`, `integration.md`, `component.md`, `contract.md`,
`e2e.md` and `async.md` in this same directory each cover one level in
depth. Anything marked **[not in source]** is an addition for auditing
purposes, not a claim the deck makes.

## Anatomy of a microservice

| Module | Responsibility |
|---|---|
| **Resources** | Map the application protocol (usually HTTP/REST) to domain messages. Thin. |
| **Domain** | Almost all service logic. *Services* coordinate; *repositories* act on persisted entities. |
| **Gateways** | Encapsulate message passing with a remote service; contain error handling for remote outages. |
| **Data mappers / ORM** | Persist domain objects between requests. |

Two facts drive everything downstream: connections between modules are
**loosely defined** (a request may touch any combination), and gateways and
persistence sit **across network partitions** — coarser-grained, slower to
test, and can fail for reasons outside the team's control.

## Depth is chosen per service, not fixed

Breaking a system into services exposes boundaries that were previously
hidden — that visibility is the benefit. A service encapsulating a critical
business process may warrant the full range of strategies; an
experimental, low-criticality or short-lived service may justify only a
couple. Recommending the full pyramid everywhere contradicts the source.

The more coarse-grained a test, the more brittle, slow and expensive to
maintain; scope increases and test count decreases moving up. Exploratory
testing sits above all of them: manual exploration that teaches the team
and improves the automated tests. Contract testing has no fixed tier — it's
orthogonal, attached to each service boundary, not a pyramid rung.

| Strategy | Verifies |
|---|---|
| **Unit** | The smallest pieces of testable software behave as expected |
| **Integration** | Communication paths between components, to detect interface defects |
| **Component** | A bounded portion of the system (here: one service), isolated with doubles |
| **Contract** | Interactions at an external boundary meet what a consumer expects |
| **End-to-end** | The whole system meets external requirements |

## Audit heuristics **[not in source]**

- Every layer above present in the code should have an identifiable owning
  test level. An untested layer is a finding; a layer tested at the
  *wrong* level (domain logic only reachable through E2E) is a bigger one.
- The right answer for a low-criticality or short-lived service may be
  *fewer* levels, not more.
