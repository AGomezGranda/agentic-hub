# Unit testing

> A unit test exercises the smallest piece of testable software in the
> application to determine whether it behaves as expected.

Typically written at class level or around a small group of related
classes. The smaller the unit, the lower the branch complexity and the
easier the behaviour is to express. Difficulty writing a unit test is a
signal the module should be split — unit testing is **a design tool**, not
only a testing strategy, especially with TDD.

Two styles, used together in the same codebase for different problems:

- **Sociable** — tests behaviour by observing **state changes**, letting
  the unit talk to real collaborators. Treats the unit as a black box
  through its interface.
- **Solitary** — tests the **interactions and collaborations** between an
  object and its dependencies, which are replaced by test doubles.

| Code type | Style | Why |
|---|---|---|
| Domain logic (calculations, state transitions) | **Sociable**, real collaborators | Highly state-based; little value in isolating |
| Plumbing (gateways, clients, mappers) | **Solitary**, doubles | Hard to isolate *and* assert on state; doubles force error conditions repeatably |
| Coordination logic | **Solitary**, doubles | The messages passed matter more than logic inside collaborators |

Two warnings the deck is explicit about:

- Needing **too many doubles** in a piece of coordination logic means a
  concept should be extracted and tested in isolation.
- As a service gets smaller, the ratio of plumbing/coordination to domain
  logic rises. Some services are *entirely* plumbing (adapters,
  aggregators) — there, **comprehensive unit testing may not pay off** and
  component testing gives more value. Over-reliance on mocks also
  constrains implementation; keep questioning value versus maintenance
  cost.

## Audit heuristic **[not in source]**

Check procedure: name the failure mode missed or maintenance cost incurred
before calling a style choice a finding. Evidence needed: the test's
path:line, what it mocks, and the bug class that ships or the refactor cost
paid because of it.

Mock-heavy tests over domain logic that hide calculation/state bugs, or
brittle doubles that break on every unrelated refactor, are findings. Mocks,
sociable vs solitary choice, and suite proportions are context-sensitive —
a plumbing-heavy service with thin unit coverage is correct when component
tests carry the load. State-based plumbing assertions are legitimate when
they verify the boundary (mapping, serialization, error classification).
A legitimate non-finding: solitary coordination tests whose doubles make
message-passing assertions repeatable.
