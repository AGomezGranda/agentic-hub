---
name: testing-strategy
description: 'Audit the testing strategy of a service repository against the microservice test pyramid (unit, integration, component, contract, end-to-end) and propose prioritised improvements. Use when asked to review, audit, or improve how a service is tested, where coverage gaps are, whether the test suite is balanced, why the suite is slow or flaky, what tests a service is missing, or how an event-driven or message-consuming service should be tested.'
argument-hint: '[optional path, service name, or area to focus on]'
---

# Testing Strategy Audit

Audit how a service repository tests itself, classify what exists against the
five strategies, find the gaps, and propose changes worth making. Reference
material: `AUDIT_STRATEGY.md` in this skill directory — a summary of "Testing
Strategies in a Microservice Architecture"
(<https://martinfowler.com/articles/microservice-testing/>). Read it before
judging anything; everything below assumes its vocabulary.

Scope defaults to the current repository. `$ARGUMENTS` may narrow it to a path,
a single service in a monorepo, or one concern ("why is CI slow", "our
contract coverage").

**Audit, don't rewrite.** Produce a report. Only write or change tests if the
user asks for that after seeing it.

## 1. Map the service before looking at the tests

You cannot judge a test suite without knowing what it has to cover. Establish:

- **Layers present** — resources/controllers, domain (services, entities,
  repositories), gateways/clients, persistence/ORM. Some services have no
  domain at all (adapters, aggregators); that changes the verdict entirely.
- **Boundaries crossed** — every outbound HTTP/gRPC call, every datastore and
  cache, and every topic, queue or subscription the service publishes to or
  consumes from. List them; each is a candidate integration and contract
  boundary.
- **Async surface** — if the service consumes or emits events, identify the
  consumers/subscribers, publishers, serializers and any outbox, plus the
  broker and its delivery semantics (at-least-once? ordered by key?). §9 of the
  reference applies and the rest of this audit changes shape.
- **Consumers** — who calls this service's API *or reads its events*, and are
  they another team?
- **Criticality and lifespan** — a central business process versus an
  experiment. This sets how much testing is *worth* it (§7 of the reference).

Read the build config, CI pipeline definitions and test tooling too: runners,
fixtures, containers, stub servers, coverage config, how and when each suite
runs.

## 2. Inventory and classify the existing tests

Walk the test directories and classify each suite — not by the folder it lives
in, but by **what it actually exercises**. Directory names lie: "unit" tests
that spin up a database are integration tests; "integration" tests that assert
business rules through the API are component tests.

For each suite record: what it covers, what it stubs, where it runs, how long
it takes, and how often it fails.

Produce the real distribution:

| Level | Count | Runtime | What it actually exercises |
|---|---|---|---|

Then, for unit tests specifically, check the **style matches the code type**
(§2 of the reference): sociable with real collaborators for domain logic,
solitary with doubles for plumbing and coordination. Mock-heavy domain tests
and state-based plumbing tests are both findings.

## 3. Assess each level

Work through these questions. Evidence in the repo, not impressions.

For a service large enough to have several boundaries and an async surface,
this fans out cleanly: spawn one subagent per applicable level (unit,
integration, component, contract, e2e, plus async if present) in a single
`subagent` workflow call, each given the service map and test inventory from
steps 1-2 and told to answer that level's questions below with `path:line` /
suite-name evidence. Cap it at 4-5 children — if all levels apply including
async, merge two adjacent ones into one child's task (e.g. contract+e2e, or
async folded into its transport's integration level) rather than spawning a
sixth. Wait for all before step 4. For a small or single-layer service, work
through the levels yourself — the fan-out overhead isn't worth it for a
handful of questions.

**Unit** — Is domain logic tested in isolation from I/O at all, or only
reachable through slower tests? Do coordination tests need so many doubles that
a concept is begging to be extracted? Is the service mostly plumbing, in which
case thin unit coverage is *correct* and component tests should carry the load?

**Integration** — Are there gateway tests covering protocol-level failure
(timeouts, malformed responses, non-2xx, SSL/headers) and not just happy paths?
Do persistence tests actually prove the schema matches the code, with
transactions closing between arrange/act/assert so data round-trips? Is the
suite *small* — a handful — or has it grown into a slow duplicate of the unit
suite? Is it separated in CI so an external outage doesn't block development?

**Component** — Is the service acceptance-tested as a whole, through its API,
with collaborators stubbed? Is it in-process or out-of-process, and does that
choice match the service (in-process where startup and integration are simple;
out-of-process where they are complex, or where network configuration itself
needs verifying)? If in-process, does an integration suite cover the real
datastore that the in-memory substitute excluded? Is setup routed through the
API and internal endpoints rather than reaching into internals?

**Contract** — For each consumed service: is there anything verifying the
producer still satisfies what this code needs, or is that only caught in E2E
or production? For this service's own API: do consumer contract suites run in
*this* repo's pipeline? Does the serialization follow Postel's Law, so adding a
field can't break a consumer? Is there a deprecation path (parallel change) for
removing one?

**End-to-end** — How many, how long, how flaky? Is the suite persona- and
journey-shaped or a second functional suite? Does it depend on pre-seeded
shared data — the classic false-failure source — or build its own world? Is the
environment built from infrastructure-as-code per run? If E2E is thin or
absent, is there production monitoring and are there synthetic transactions
compensating?

**Async and event-driven** (if the service has an async surface) — Is there a
test that delivers the same message twice and asserts one effect? Out-of-order
delivery? Poison messages reaching a DLQ without wedging the consumer? Retry
and redelivery? If state is written and an event published, is the crash
between the two tested? Do broker integration tests run against a real broker
in a container, or only an in-memory fake with nothing covering offsets,
redelivery and rebalancing? Is message-schema compatibility actually enforced
— a registry in a real compatibility mode, or message contracts — rather than
by convention? Do any tests `sleep` to wait for an event instead of polling
with a bounded timeout? Is the clock frozen?

**Across the board** — what breaks in production that no test level would have
caught? Look at recent incidents, hotfix commits and bug-fix PRs; they are the
strongest evidence of where the strategy is actually failing.

## 4. Report

If levels were fanned out to subagents, open each cited file/suite yourself
before writing anything down — a subagent's claim is a lead, not confirmed
evidence. Drop or fix anything that doesn't hold up.

Write the findings as markdown. Structure:

1. **Service shape** — layers, boundaries, consumers, criticality. Two or three
   sentences.
2. **Current distribution** — the table from step 2, plus how it departs from a
   pyramid, with the actual numbers and runtimes.
3. **Findings** — each one: what is wrong, the evidence (`path:line`, suite
   names, CI timings), and what it costs (a class of bug that ships, slow
   feedback, flakiness, maintenance). Order by cost, worst first.
4. **Recommendations** — prioritised. For each: the change, the level it
   belongs at, why that level, and rough effort. Separate "do now" from "worth
   doing" from "only if this service grows".
5. **Explicitly not recommended** — what a naive reading of the pyramid would
   suggest here and why it's wrong for this service. Include this section; it
   keeps the audit honest.

## Judgement rules

- **Cite evidence.** Every finding points at a file, a suite, a CI job, or an
  incident. No generic testing advice that would read the same for any repo.
- **Push tests down, but only where they fit.** The value of moving a test down
  the pyramid is faster feedback and fewer reasons to fail — not purity. Say
  which of those you are buying.
- **More tests is not the default answer.** Deleting a redundant, slow or
  flaky suite is a legitimate recommendation, and often the highest-value one.
  Too many E2E tests is a worse finding than too few.
- **Match depth to criticality.** An experimental or short-lived service does
  not need five levels. Recommending the full pyramid everywhere contradicts
  the source material.
- **Respect the repo's stack.** Propose tools and patterns that fit the
  languages, frameworks and CI already in use; name the specific library the
  repo would plausibly adopt, not a generic category.
- **Async gaps outrank most others.** A service consuming an at-least-once
  broker with no idempotency, redelivery or poison-message test has a hole that
  no amount of unit coverage compensates for, because the failures are silent
  and surface as corrupt data rather than red builds.
- **Say when it's fine.** If a level is genuinely well covered, record that in
  one line and move on. An audit that finds problems everywhere is not credible.
