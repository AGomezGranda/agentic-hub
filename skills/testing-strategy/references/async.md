# Async and event-driven services **[not in source]**

The deck develops all five strategies for synchronous request/response
only. For a service that consumes or emits events, the strategies still
apply — but the boundaries, failure modes and assertion style all change.

## Anatomy, extended

| Module | Responsibility |
|---|---|
| **Consumers / subscribers** | Inbound adapter from the broker. Deserialize, dispatch into the domain, commit the offset or ack. The async twin of a resource. |
| **Publishers / producers** | Outbound adapter. Marshal domain events onto a topic. The async twin of a gateway. |
| **Serializers / schema** | Map domain objects to the wire format (JSON, Avro, Protobuf). Where compatibility is won or lost. |
| **Outbox** | If state and events must be written atomically, a transactional table plus a relay. Its own failure mode. |
| **Broker** | Kafka, SQS/SNS, RabbitMQ, Pub/Sub. Network-partitioned, with delivery semantics of its own. |

Consumers and publishers are plumbing: **solitary** unit tests with
doubles. The logic worth unit-testing is deserialization, mapping and
error classification — not delivery.

## Integration testing the broker

Against a **real broker in a container**, not an in-memory fake. Cover: a
published message lands on the expected topic/key/partition; a consumer
commits its offset or acks **only after successful handling**
(committing first silently drops messages on failure); dead-letter routing
for unprocessable messages; reconnection after a broker drop; consumer-group
rebalancing if the service scales horizontally. In-memory/embedded brokers
model none of this — an integration suite must cover what they exclude,
exactly as in-process component tests require persistence integration
tests.

## Component testing

Still the component. Drive it by **publishing input events** and assert on
the **events it emits** and the state it exposes, with collaborators and
the broker stubbed or containerised. There is no response to wait on: poll
for the outcome with a **bounded timeout**. **Never `sleep`** — it is
either flaky or slow, usually both.

## Contract testing without a request/response

The contract is the **message schema plus its compatibility guarantees**:

- **A schema registry with an enforced compatibility mode** —
  `BACKWARD`/`FORWARD`/`FULL`, chosen by deploy order. `NONE` is a finding.
- **Message contracts / consumer-driven contracts for events** — the
  consumer declares which fields it reads; the producer verifies it still
  emits them. Pact supports message pacts; AsyncAPI can be linted in CI.

Postel's Law binds harder here: consumers must ignore unknown fields, and a
new field must never be required on an existing event version. A schema
registry alone is not contract testing — it proves a message is
*parseable*, not that it carries the fields a consumer's behaviour depends
on.

## End-to-end across async boundaries

A business flow spanning services via events completes **eventually**.
Assert on terminal state with bounded polling, not intermediate steps, and
never assume read-after-write across a service boundary — the single
largest source of flake in event-driven systems.

## The async failure modes worth explicit tests

1. **Idempotency.** At-least-once delivery guarantees duplicates. Deliver
   the same message twice; assert one effect.
2. **Out-of-order delivery.** Unless a single consumer reads an ordered
   partition, events arrive out of order; assert convergence or explicit
   rejection of the stale event.
3. **Poison messages.** A permanently-unprocessable message must reach the
   DLQ without wedging the consumer in a crash loop.
4. **Retry and redelivery.** Backoff, max attempts, and no double-applied
   effect (reduces to idempotency).
5. **Dual-write / outbox.** Test the crash between writing state and
   publishing the event — untested, this diverges silently.
6. **Schema evolution, both directions.** Old consumer vs. new message, new
   consumer vs. old message, against real historical payloads.
7. **Replay.** Can a consumer reset and reprocess safely? Depends entirely
   on idempotency being real.
8. **Consumer lag and backpressure.** Not unit-testable; note its absence
   rather than proposing a unit test for it.

Freeze the clock in all of the above — timestamps, TTLs and windowed
aggregations flake against a live clock.

## Audit heuristics

- No idempotency test on a consumer of an at-least-once broker is a
  finding regardless of how good the rest of the suite is.
- Tests that `sleep` to wait for an event are a finding: future flakes and
  runtime budget.
- An in-memory broker with no real-broker integration suite means offsets,
  redelivery and rebalancing are untested everywhere.
- Consumers/producers tested only through E2E means schema breakage is
  caught after deployment, not before.
- An outbox or dual-write with no crash-case test is silent divergence
  waiting to happen.
