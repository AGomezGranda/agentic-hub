# Contract testing

> An integration contract test is a test at the boundary of an external
> service verifying that it meets the contract expected by a consuming
> service.

A contract forms whenever a consumer couples to a component's interface.
It covers expected **input and output data structures, side effects, and
performance and concurrency characteristics**. Each consumer forms a
*different* contract based on what it actually uses.

- The **maintainers of each consuming service** write an independent suite
  verifying only the aspects of the producer they use.
- These are **not component tests** — they don't test behaviour deeply,
  only that inputs/outputs contain the required attributes and that
  latency and throughput are within acceptable limits.
- Ideally each consumer's suite is **packaged and run in the producing
  service's build pipeline**, so producers see the impact of their
  changes.

Why producers gain most: with every consumer's suite in hand, a producer
can change safely. The deck's worked example — a resource with `id`,
`name`, `age`; consumer A uses id+name, B uses id+age, C uses all three.
To retire `name`, the producer deletes it and sees which contract tests
fail (A and C), notifies those consumers, waits for migration, then
removes the field. That is a **Parallel Change**.

For this to work, both sides must follow **Postel's Law** when serializing
and deserializing: ignore fields you don't care about.

Contract suites are also a design tool for a *new* service: consumers
express what they need as tests, which become the discussion point with
the producing team and an automated readiness signal —
**consumer-driven contracts**. Named tools: Pact, Pacto, Janus.

## Audit heuristic **[not in source]**

No contract tests across a boundary between two teams means changes to the
producer are validated only by E2E tests — or not at all.
