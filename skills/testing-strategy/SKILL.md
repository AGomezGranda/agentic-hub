---
name: testing-strategy
description: 'Audit the testing strategy of a service repository against the microservice test pyramid (unit, integration, component, contract, end-to-end) and propose prioritised improvements. Use when asked to review, audit, or improve how a service is tested, where coverage gaps are, whether the test suite is balanced, why the suite is slow or flaky, what tests a service is missing, or how an event-driven or message-consuming service should be tested. Not general code quality unrelated to tests (code-quality-audit) or fixing a single failing test.'
argument-hint: '[optional path, service name, or area to focus on]'
---

# Testing Strategy Audit

Read references/review.md for finding, severity and coverage requirements.

Audit how a service repository tests itself, classify what exists against the
five strategies, find the gaps, and propose changes worth making. Reference
material: a summary of "Testing Strategies in a Microservice Architecture"
(<https://martinfowler.com/articles/microservice-testing/>) — read
`references/overview.md` in this skill directory before judging anything;
everything below assumes its vocabulary. Each level's own file
(`references/unit.md`, `references/integration.md`,
`references/component.md`, `references/contract.md`, `references/e2e.md`,
`references/async.md`) goes deeper on that level only — read your own
level's file (yourself, or paste its path into a child's task per §3), not
all six.

Scope defaults to the current repository. `$ARGUMENTS` may narrow it to a path,
a single service in a monorepo, or one concern ("why is CI slow", "our
contract coverage").

**Audit, don't rewrite.** Produce a report. Only write or change tests if the
user asks for that after seeing it. (Dispatching level children to a
read-only child enforces this structurally where the host supports it —
without a write capability it can't rewrite even if asked.)

## 1. Map the service before looking at the tests

One inventory pass suffices for the map: ask a `repo-scout` for layers,
boundary classes, and the test inventory — or gather them yourself for a
small or single-layer service — each with evidence (a short answer plus
`file:line` proof, or an honest "not found"). Assemble the map yourself.
Judge nothing at this stage; a scout that volunteers a verdict is out of
contract. Then delegate per step 3 with that map pasted into each task.
Skip separate mapping for a small service or a diff/PR — read the changed
files directly either way.

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
  broker and its delivery semantics (at-least-once? ordered by key?).
  `references/async.md` applies and the rest of this audit changes shape.
- **Consumers** — who calls this service's API *or reads its events*, and are
  they another team?
- **Criticality and lifespan** — a central business process versus an
  experiment. This sets how much testing is *worth* it
  (`references/overview.md`).

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
(see `references/unit.md`): sociable with real collaborators for domain
logic, solitary with doubles for plumbing and coordination. A style mismatch
is a finding only with the failure mode missed or maintenance cost incurred —
e.g. mock-heavy domain tests that hide a calculation bug, or brittle doubles
that break on every refactor. State-based plumbing assertions are legitimate
when they verify the boundary (mapping, error classification). Mocks,
sociable/solitary choice, integration counts, and pyramid proportions are
context-sensitive; missing runtime/flakiness history is unknown, not an
invented statistic.

## 3. Assess each level

Work through these questions. Evidence in the repo, not impressions.

For a service large enough to have several boundaries and an async surface,
delegate to keep reads independent: prefer splitting by module/bounded
context when per-level children would re-read the same suites, or one child
for a single level (unit, integration, component, contract, e2e, plus
async if present) when that level's question is genuinely independent — see
"Fanning out" below for how, per host. Each child's task text must carry
everything it needs — don't depend on inherited context: the service map
and test inventory from steps 1-2, that level's own questions from below,
the absolute path to that level's own file under `references/` in this
skill directory (`unit.md`, `integration.md`, `component.md`,
`contract.md`, `e2e.md`, or `async.md`) for background reading — never the
whole set — plus references/review.md and a read-only restriction.
Wait for all before step 4. For a small
or single-layer service, work through the levels yourself — the fan-out
overhead isn't worth it for a handful of questions.

### Fanning out

Bundled agent: `audit-reviewer` (agents/audit-reviewer.md). Pass the assigned
scope, applicable level references, known inventory and references/review.md
by absolute path. Reviewers investigate missing evidence with available tools.
The parent owns cross-area contracts and verifies material findings.

<!-- agentic-hub: fanout -->

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

Apply references/review.md. Include the service shape, observed distribution
of tests and runtimes (unknown when unavailable), confirmed findings, and
prioritized changes at the cheapest level that catches the failure. State
what additional testing is unwarranted when the pyramid would otherwise be
misleading. Include coverage and unresolved concerns.

Prefer recommendations grounded in actual failure modes and existing tooling.
More tests is not the default answer: removing redundant or flaky coverage may
be the best improvement. Async delivery and persistence gaps deserve attention
when they can silently corrupt state; do not infer severity from test counts.
