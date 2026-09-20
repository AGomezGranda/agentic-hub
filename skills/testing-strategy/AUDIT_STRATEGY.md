# Testing Strategies in a Microservice Architecture

Reference notes for the `testing-strategy` skill. Faithful summary of the
infodeck "Testing Strategies in a Microservice Architecture" (18 November
2014): <https://martinfowler.com/articles/microservice-testing/>

Anything marked **[not in source]** is an addition for auditing purposes and is
not a claim made by the deck.

## 1. Anatomy of a microservice

Microservices tend to share an internal structure. A testing strategy should
cover each layer *and the connections between them*, at the finest granularity
possible, while staying lightweight.

| Module | Responsibility |
|---|---|
| **Resources** | Map the application protocol (usually HTTP/REST) to domain messages. Thin: sanity-check the request, produce a protocol-specific response. |
| **Domain** | Almost all service logic. *Services* coordinate across multiple domain activities; *repositories* act on collections of entities and are usually persistence-backed. |
| **Gateways** | Encapsulate message passing with a remote service, marshalling requests/responses to and from domain objects. Use a protocol *client* underneath. Contain the error handling for remote outages. |
| **Data mappers / ORM** | Persist domain objects between requests. Usually invoked by repositories. |

Two structural facts drive everything downstream:

- Connections between modules are **loosely defined** — a given request may
  touch resources, services, gateways or repositories in varying combinations.
- Gateways and persistence sit **across network partitions**. Communications
  there are coarser-grained (to avoid chattiness and latency), tests of those
  modules run slower, and they can fail for reasons outside the team's control.

At the system level, a team typically guards one or more services. Testing
concerns differ for services owned by *other* teams: fewer guarantees about
interface stability and availability. Failure modes (timeouts, circuit
breakers, bulkheads) are a first-class design and testing concern.

## 2. Unit testing

> A unit test exercises the smallest piece of testable software in the
> application to determine whether it behaves as expected.

Typically written at class level or around a small group of related classes.
The smaller the unit, the lower the branch complexity and the easier the
behaviour is to express. Difficulty writing a unit test is a signal the module
should be split — unit testing is **a design tool**, not only a testing
strategy, especially with TDD.

Two styles, used together in the same codebase for different problems:

- **Sociable** — tests behaviour by observing **state changes**, letting the
  unit talk to real collaborators. Treats the unit as a black box through its
  interface.
- **Solitary** — tests the **interactions and collaborations** between an
  object and its dependencies, which are replaced by test doubles.

Which style where:

| Code type | Style | Why |
|---|---|---|
| Domain logic (complex calculations, state transitions) | **Sociable**, real collaborators | Highly state-based; little value in isolating |
| Plumbing (gateways, clients, mappers) | **Solitary**, doubles | Hard to isolate *and* assert on state; doubles control the request/response cycle repeatably and can force error conditions faster than integration tests |
| Coordination logic | **Solitary**, doubles | The messages passed matter more than logic inside collaborators |

Two warnings the deck is explicit about:

- Needing **too many doubles** in a piece of coordination logic means a concept
  should be extracted and tested in isolation.
- As a service gets smaller, the ratio of plumbing/coordination to domain logic
  rises. Some services are *entirely* plumbing (adapters, aggregators) — there,
  **comprehensive unit testing may not pay off** and component testing gives
  more value. Tests constrain behaviour, but over-reliance on mocks also
  constrains implementation; keep questioning value versus maintenance cost.

## 3. Integration testing

> An integration test verifies the communication paths and interactions between
> components to detect interface defects.

Modules are collected and tested as a subsystem to check for incorrect
assumptions each has about how to talk to its peers. This differs from a
sociable unit test: the goal is the *subsystem's collaboration*, not the
behaviour of one unit. In microservices it is typically used to verify
integration code against **other microservices, data stores and caches**.

The goal is to verify the module can communicate sufficiently — **not** to
acceptance-test the external component. Cover basic success and error paths
only.

**Gateway integration tests** flush out protocol-level defects at the finest
granularity: missing HTTP headers, incorrect SSL handling, request/response
body mismatches, and special-case error handling. When abnormal behaviour
(timeouts, slow responses) is hard to trigger, use a stub of the external
component as a configurable test harness.

**Persistence integration tests** assert the schema assumed by the code matches
the data store, and that ORM mappings are compatible with real result sets.
Structure them so **transactions close between preconditions, actions and
assertions** — modern ORMs cache and flush lazily, and without this the data
never makes a full round trip. Verify graceful handling of data-store timeouts
and network failures too.

State management: agree on a **fixed set of representative but harmless data**
guaranteed to exist in every environment.

Cost: these tests have **more than one reason to fail** — a regression in the
integration module, *or* the external component being unavailable or breaking
its contract. Mitigations the deck names:

- Write only **a handful** of them, for fast feedback.
- Get comprehensive coverage of each side of the boundary from unit tests and
  contract tests instead.
- **Separate them in the CI pipeline** so external outages don't block
  development.

## 4. Component testing

> A component test limits the scope of the exercised software to a portion of
> the system under test, manipulating the system through internal code
> interfaces and using test doubles to isolate the code under test from other
> components.

In a microservice architecture **the component is the service itself**. Tests
at this granularity drive the API contract from the consumer's perspective and
thoroughly acceptance-test the service's behaviour, while running faster than
broad-stack equivalents. Isolation comes from replacing external collaborators
with doubles and using internal API endpoints to probe or configure the service.

The deck's central question here is **in-process or out-of-process**:

### In-process

Full service instantiated in memory, with in-memory doubles and datastore; no
network at all.

- Faster, fewer moving parts, simpler build.
- Cost: the **deployment artifact must be altered** to start in a "test" mode
  (dependency-injection frameworks help wire it differently by configuration).
- Tests talk to the service through an internal interface — usually a custom
  shim, or a library (`inproctester` on the JVM, `plasma` for .NET) — getting as
  close to real HTTP as possible without real network overhead.
- Gateways are configured with test doubles instead of real protocol clients,
  programmed to return predefined responses on matched requests, and to emulate
  unhappy paths (offline, slow, malformed).
- External datastores are replaced with in-memory implementations (a
  lightweight custom one, an embedded mode like Cassandra's or Elasticsearch's,
  or an emulator like H2). The real datastore then falls outside the test
  boundary — **persistence integration tests must cover that gap**.
- Route setup through **privileged internal resources** rather than configuring
  doubles and data directly, so the service stays a black box and persistence
  or transport changes don't break the component suite.

### Out-of-process

The fully deployed artifact runs as a separate process; all interaction is real
network calls.

- The **artifact is unchanged** — no test-specific logic.
- Exercises more layers and integration points, and additionally verifies the
  service's **network configuration** and ability to serve real requests.
- Client and persistence modules run integrated with real dependencies.
- Complexity moves into the **test harness**: starting/stopping stubs,
  coordinating ports and configuration, pointing the service at test URLs.
- Slower. Worth it when the service has complex integration, persistence or
  startup logic.
- Stub varieties: dynamically programmed via API, hand-crafted fixtures, or
  record-replay. Named tools: `moco`, `stubby4j`, `mountebank` (dynamic +
  fixture), `vcr` (record-replay). If an external service has many consumers,
  a **custom stub owned by that service's team** saves every consumer
  maintaining their own.
- Tests at this level describe behaviour in business language and benefit from
  a business-readable DSL (Gherkin, via Cucumber or SpecFlow).

### Internal resources

Exposing internal controls as resources pays off beyond testing — monitoring,
maintenance, debugging — because RESTful uniformity means tooling already
exists. Typical resources: logs, feature flags, database commands, system
metrics, health checks (service + dependency health, key transaction timings,
configuration parameters), and a simple ping for load balancing.

They are privileged, so they need **their own authentication or network-level
lockdown** — namespace them by URL convention or expose them on a different
port so access can be restricted at the firewall.

## 5. Contract testing

> An integration contract test is a test at the boundary of an external service
> verifying that it meets the contract expected by a consuming service.

A contract forms whenever a consumer couples to a component's interface. It
covers expected **input and output data structures, side effects, and
performance and concurrency characteristics**. Each consumer forms a *different*
contract based on what it actually uses.

- The **maintainers of each consuming service** write an independent suite
  verifying only the aspects of the producer they use.
- These are **not component tests** — they don't test behaviour deeply, only
  that inputs/outputs contain the required attributes and that latency and
  throughput are within acceptable limits.
- Ideally each consumer's suite is **packaged and run in the producing
  service's build pipeline**, so producers see the impact of their changes.

Why producers gain most: with every consumer's suite in hand, a producer can
change safely. The deck's worked example — a resource with `id`, `name`, `age`;
consumer A uses id+name, B uses id+age, C uses all three. To retire `name`, the
producer deletes it and sees which contract tests fail (A and C), notifies those
consumers, waits for migration, then removes the field. That is a
**Parallel Change**.

For this to work, both sides must follow **Postel's Law** when serializing and
deserializing: ignore fields you don't care about.

Contract suites are also a design tool for a *new* service: consumers express
what they need as tests, which become the discussion point with the producing
team and an automated readiness signal — **consumer-driven contracts**. Named
tools: Pact, Pacto, Janus.

## 6. End-to-end testing

> An end-to-end test verifies that a system meets external requirements and
> achieves its goals, testing the entire system, from end to end.

The system is a black box, exercised through public interfaces — GUIs (via
Selenium WebDriver or similar) or service APIs (via an HTTP client) — and
correctness is judged by state changes or events at the test boundary. Being
business-facing, they commonly use a business-readable DSL.

What they uniquely buy in a microservice architecture:

- Coverage of the **gaps between services**, including network infrastructure
  (firewalls, proxies, load balancers) that no other level exercises.
- Confidence during **large-scale architectural refactoring** — as services
  split and merge, E2E tests confirm business functions survive.

Externally managed services are usually inside the boundary, but may be
excluded when a third party makes repeatable, side-effect-free testing
impossible or when reliability problems cause failures outside the team's
control. Stubbing them trades end-to-end confidence for suite stability.

E2E tests have the most moving parts, hence the most reasons to fail, plus
asynchrony in the GUI and in backend processes — producing flakiness, long
runtimes and maintenance cost. The deck's five guidelines:

1. **Write as few as possible.** Their role is to confirm everything ties
   together, not to comprehensively test business requirements — lower levels
   already give that confidence. Apply a **time budget**: an amount of time the
   team is willing to wait, *of the order of minutes, not hours*. When the suite
   exceeds it, delete the least valuable tests.
2. **Focus on personas and user journeys.** Model tests on real users and the
   journeys they make, covering what users value most and leaving the rest to
   other levels. (Tools: Gauge, Concordion.)
3. **Choose your ends wisely.** If a particular external service or GUI is a
   major source of flakiness, redefine the boundary to exclude it — acceptable
   as long as another form of testing covers that component.
4. **Rely on infrastructure-as-code for repeatability.** Snowflake environments
   are a source of non-determinism. Building a fresh environment per suite run
   improves reliability and doubles as a test of the deployment logic.
5. **Make tests data-independent.** Relying on pre-existing data causes
   *false failures* — failures that don't indicate a fault in the software.
   Have tests define their world up front via public or internal APIs; import
   canned data at the database level only for services that can't construct
   their own entities.

The deck also records the alternative: some teams skip E2E testing entirely in
favour of thorough **production monitoring and testing in production** —
**synthetic transactions** (fake users exercising real transactions against
production) supplementing monitoring, plus alerting when key business metrics
fall outside acceptable norms.

## 7. Conclusions

### More options, deliberately chosen

Breaking a system into services exposes boundaries that were previously hidden,
which is itself the benefit: it becomes easy to see the components and treat
them in isolation. **Testing depth should be chosen per service.** A service
encapsulating a critical business process with complex requirements may warrant
the full range of strategies; an experimental, low-criticality or short-lived
service may justify only a couple. This decision is possible in a monolith too,
but clear boundaries make it tractable.

### The test pyramid

The more coarse-grained a test, the more brittle, slow, and expensive to write
and maintain — more moving parts, more reasons to fail. Moving up the pyramid,
scope increases and the number of tests decreases. **Exploratory testing sits at
the very top**: manual exploration in ways the scripted tests didn't consider,
which teaches the team about the system and improves the automated tests.

Note the deck does **not** assign a fixed tier ordering to contract tests within
the pyramid; contract testing is orthogonal, attached to each service boundary.

### Summary of the five strategies

| Strategy | Verifies |
|---|---|
| **Unit** | The smallest pieces of testable software behave as expected |
| **Integration** | Communication paths and interactions between components, to detect interface defects |
| **Component** | A bounded portion of the system (here: one service), driven through internal code interfaces, isolated with test doubles |
| **Contract** | Interactions at an external service boundary meet the contract a consumer expects |
| **End-to-end** | The whole system meets external requirements and achieves its goals |

## 8. Audit heuristics **[not in source]**

Derived from the above, for use when auditing an existing repository:

- Every layer in §1 present in the code should have an identifiable owning test
  level. An untested layer is a finding; a layer tested at the *wrong* level
  (e.g. domain logic only reachable through E2E) is a bigger one.
- Mock-heavy tests over domain logic invert §2 and usually indicate the domain
  is entangled with plumbing.
- A large integration suite that duplicates domain assertions is the §3
  anti-pattern: it should shrink, with coverage moving to unit and contract
  tests.
- No contract tests across a boundary between two teams means changes to the
  producer are validated only by E2E tests — or not at all.
- An E2E suite that exceeds a minutes-scale budget, is not persona-shaped, or
  depends on pre-seeded shared data will produce false failures and erode trust.
- The right answer for a low-criticality or short-lived service may be *fewer*
  levels, not more — §7. Recommending the full pyramid for every service
  contradicts the source.

## 9. Event-driven and asynchronous services **[not in source]**

The deck names publish-subscribe as an integration style and then develops all
five strategies for synchronous request/response only. Its contract section, in
particular, is entirely about HTTP resources. For a service that consumes or
emits events, the strategies still apply — but the boundaries, the failure
modes and the assertion style all change.

### Anatomy, extended

| Module | Responsibility |
|---|---|
| **Consumers / subscribers** | Inbound adapter from the broker. Deserialize, dispatch into the domain, commit the offset or ack. The async twin of a resource. |
| **Publishers / producers** | Outbound adapter. Marshal domain events onto a topic. The async twin of a gateway. |
| **Serializers / schema** | Map domain objects to the wire format (JSON, Avro, Protobuf). Where compatibility is won or lost. |
| **Outbox** | If state and events must be written atomically, a transactional outbox table plus a relay. A layer with its own failure mode. |
| **Broker** | Kafka, SQS/SNS, RabbitMQ, Pub/Sub. A network-partitioned dependency like a datastore, but with delivery semantics of its own. |

Consumers and publishers are plumbing: **solitary** unit tests with doubles,
per §2. The logic worth unit-testing there is deserialization, mapping and
error classification — not delivery.

### Integration testing the broker

Against a **real broker in a container**, not an in-memory fake. Cover:

- A published message actually lands on the expected topic, with the expected
  key, headers and partition.
- A consumer subscribes, deserializes, and **commits its offset or acks only
  after successful handling** — committing first silently drops messages on
  failure.
- Dead-letter routing for unprocessable messages.
- Reconnection after a broker connection drop.
- Consumer-group rebalancing, if the service scales horizontally.

In-memory and embedded brokers do not model partitions, offsets, rebalancing or
redelivery — which is precisely the set of things that break in production. If
one is used for speed, an integration suite must cover the real broker
semantics it excludes, exactly as in-process component tests require
persistence integration tests (§4).

### Component testing an event-driven service

The service is still the component. Drive it by **publishing input events** and
assert on the **events it emits** and the state it exposes, with external
collaborators and the broker stubbed or containerised. This is the direct
analogue of driving a synchronous service through its API.

Assertion style is the difference: there is no response to wait on. Poll for
the expected outcome with a **bounded timeout** (Awaitility or equivalent).
**Never `sleep`** — a fixed sleep is either flaky or slow, and usually both.

### Contract testing without a request/response

The contract is the **message schema plus its compatibility guarantees**. Two
complementary mechanisms:

- **A schema registry with an enforced compatibility mode.** `BACKWARD` (a new
  consumer can read old messages), `FORWARD` (an old consumer can read new
  messages), or `FULL`. The correct choice depends on deployment order — if
  producers deploy first, you need `FORWARD`. An unenforced or `NONE` mode is a
  finding.
- **Message contracts / consumer-driven contracts for events** — the consumer
  declares which fields it actually reads; the producer verifies it still emits
  them. Pact supports message pacts; AsyncAPI documents the channels and can be
  linted in CI.

Postel's Law (§5) binds harder here than over HTTP: consumers must ignore
unknown fields, and a new field must never be required on an existing event
version. Parallel Change also has an event form — add the field, dual-publish
or version the event, migrate consumers, then retire the old shape.

A schema registry alone is not contract testing. It proves a message is
*parseable* by the next version, not that it still carries the fields a
consumer depends on for its behaviour.

### End-to-end across async boundaries

A business flow spanning services via events completes **eventually**. E2E
tests must assert on the terminal state with bounded polling, not on
intermediate steps, and must not assume read-after-write across a service
boundary. Tests that do are the single largest source of flake in event-driven
systems.

### The async failure modes worth explicit tests

These are where an audit usually finds nothing at all:

1. **Idempotency.** At-least-once delivery guarantees every consumer will see
   duplicates. Deliver the same message twice; assert one effect. Absent this,
   duplicates cause silent data corruption.
2. **Out-of-order delivery.** Unless ordering is guaranteed by partition key
   and a single consumer, events arrive out of order. Apply them out of order;
   assert either convergence to the same state or explicit rejection of the
   stale event.
3. **Poison messages.** A malformed or permanently-unprocessable message must
   go to the DLQ without blocking the partition or wedging the consumer in a
   crash loop.
4. **Retry and redelivery.** Backoff, max attempts, and that a retried message
   does not double-apply its effect (which reduces to idempotency again).
5. **Dual-write / outbox.** If the service writes state *and* publishes an
   event, test the crash between the two. Untested, this diverges state from
   events silently and is typically found months later.
6. **Schema evolution, both directions.** Old consumer against a new message,
   and new consumer against an old message — replayed against real historical
   payloads where they are available.
7. **Replay.** Can a consumer be reset and reprocess from the start safely?
   The answer depends entirely on idempotency being real.
8. **Consumer lag and backpressure.** Not unit-testable; belongs to load
   testing and production monitoring. Note its absence rather than proposing a
   unit test for it.

Freeze the clock in all of the above. Event timestamps, TTLs and windowed
aggregations flake against a live clock.

### Audit heuristics for async

- No idempotency test on a consumer of an at-least-once broker is a finding
  regardless of how good the rest of the suite is.
- Tests that `sleep` to wait for an event are a finding: they are the suite's
  future flakes and its runtime budget.
- An in-memory broker with no real-broker integration suite behind it means
  offsets, redelivery and rebalancing are untested everywhere.
- Consumers and producers tested only through E2E means schema breakage is
  caught after deployment, not before.
- A schema registry in `NONE` compatibility mode, or none at all, means the
  contract is enforced by convention only.
- An outbox or dual-write with no crash-case test is silent divergence waiting
  to happen.
