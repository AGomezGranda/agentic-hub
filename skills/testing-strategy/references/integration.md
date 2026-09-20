# Integration testing

> An integration test verifies the communication paths and interactions
> between components to detect interface defects.

Modules are collected and tested as a subsystem to check for incorrect
assumptions each has about how to talk to its peers. This differs from a
sociable unit test: the goal is the *subsystem's collaboration*, not the
behaviour of one unit. In microservices it typically verifies integration
code against **other microservices, data stores and caches**.

The goal is to verify the module can communicate sufficiently — **not** to
acceptance-test the external component. Cover basic success and error
paths only.

**Gateway integration tests** flush out protocol-level defects at the
finest granularity: missing HTTP headers, incorrect SSL handling,
request/response body mismatches, special-case error handling. When
abnormal behaviour (timeouts, slow responses) is hard to trigger, use a
stub of the external component as a configurable test harness.

**Persistence integration tests** assert the schema assumed by the code
matches the data store, and that ORM mappings are compatible with real
result sets. Structure them so **transactions close between preconditions,
actions and assertions** — modern ORMs cache and flush lazily, and without
this the data never makes a full round trip. Verify graceful handling of
data-store timeouts and network failures too.

State management: agree on a **fixed set of representative but harmless
data** guaranteed to exist in every environment.

Cost: these tests have **more than one reason to fail** — a regression in
the integration module, *or* the external component being unavailable or
breaking its contract. Mitigations the deck names:

- Write only **a handful** of them, for fast feedback.
- Get comprehensive coverage of each side of the boundary from unit tests
  and contract tests instead.
- **Separate them in the CI pipeline** so external outages don't block
  development.

## Audit heuristic **[not in source]**

A large integration suite that duplicates domain assertions is the
anti-pattern above: it should shrink, with coverage moving to unit and
contract tests.
