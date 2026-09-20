# Component testing

> A component test limits the scope of the exercised software to a portion
> of the system under test, manipulating the system through internal code
> interfaces and using test doubles to isolate the code under test from
> other components.

In a microservice architecture **the component is the service itself**.
Tests at this granularity drive the API contract from the consumer's
perspective and thoroughly acceptance-test the service's behaviour, while
running faster than broad-stack equivalents. Isolation comes from
replacing external collaborators with doubles and using internal API
endpoints to probe or configure the service.

The deck's central question here is **in-process or out-of-process**.

## In-process

Full service instantiated in memory, with in-memory doubles and datastore;
no network at all.

- Faster, fewer moving parts, simpler build.
- Cost: the **deployment artifact must be altered** to start in a "test"
  mode (dependency-injection frameworks help wire it differently by
  configuration).
- Tests talk to the service through an internal interface — usually a
  custom shim, or a library (`inproctester` on the JVM, `plasma` for .NET)
  — getting as close to real HTTP as possible without real network
  overhead.
- Gateways are configured with test doubles instead of real protocol
  clients, programmed to return predefined responses, and to emulate
  unhappy paths (offline, slow, malformed).
- External datastores are replaced with in-memory implementations (a
  lightweight custom one, an embedded mode, or an emulator like H2). The
  real datastore falls outside the test boundary — **persistence
  integration tests must cover that gap**.
- Route setup through **privileged internal resources** rather than
  configuring doubles and data directly, so the service stays a black box.

## Out-of-process

The fully deployed artifact runs as a separate process; all interaction is
real network calls.

- The **artifact is unchanged** — no test-specific logic.
- Exercises more layers and integration points, and additionally verifies
  the service's **network configuration**.
- Client and persistence modules run integrated with real dependencies.
- Complexity moves into the **test harness**: starting/stopping stubs,
  coordinating ports and configuration.
- Slower. Worth it when the service has complex integration, persistence
  or startup logic.
- Stub varieties: dynamically programmed via API, hand-crafted fixtures, or
  record-replay. Named tools: `moco`, `stubby4j`, `mountebank`, `vcr`. If
  an external service has many consumers, a **custom stub owned by that
  service's team** saves every consumer maintaining their own.
- Tests describe behaviour in business language and benefit from a
  business-readable DSL (Gherkin, via Cucumber or SpecFlow).

## Internal resources

Exposing internal controls as resources pays off beyond testing —
monitoring, maintenance, debugging. Typical resources: logs, feature
flags, database commands, system metrics, health checks, a simple ping for
load balancing. They are privileged, so they need **their own
authentication or network-level lockdown**.
