# Agentic Factory

## Overview

This document describes my vision for an agentic software factory: an end-to-end flow that takes a Jira ticket as input and produces one or more pull requests as output.

**Out of scope for now:**

- Creating and refining tickets. The factory assumes a ticket is ready to be worked on.
- Incident investigation, which may become a second flow in a future version.
- Responding to PR comments from other reviewers on GitHub.

## Goals

- Maximise the quality of the solution, with a strong emphasis on technical excellence.
- Minimise cost.

## Ticket completion flow (v1)

The Jira ticket is the unit of work. The factory takes a ticket as input and produces one or more PRs as output.

The existing agentic-hub skills define how agents behave at each step: `create-plan`, `review-plan`, `implement-plan` and `review-implementation` (which runs the audit swarm). The factory orchestrates them; it does not redefine them.

### Steps

1. **Plan.** Research the current codebase, and other repositories when defined or needed, and produce a multi-phase plan with a PR strategy defining how phases map to PRs.
2. **Agent plan review.** Review the plan through a set of quality lenses: code quality, architecture, testing, security, simplicity, and others as needed.
3. **Update the plan** based on the review findings. Steps 2 and 3 repeat until the reviewers have no further findings, up to a maximum of three loops.
4. **Human plan approval.** I review and update the plan manually. No implementation starts until I approve it. If I request changes, the plan is updated and goes back to step 2.
5. **Implement each PR.** For each PR defined in the PR strategy:
   1. Implement the phase or phases assigned to it.
   2. Run tests, linting and type checks. The phase can’t move forward until they pass.
   3. **Agent implementation review.** Review the changes against the plan (did it implement what the phase says) and through the same quality lenses as the plan review. The agent triages the findings, addresses the accepted ones, and re-runs the checks from step 5.2. This repeats up to a maximum of three loops.
   4. **Open a draft PR** on GitHub so CI runs on it.
   5. **Human PR review** on the draft PR. Code-level changes go back to step 5.3. Plan-level changes go back to the plan: I update it manually and approve it again before development resumes.
   6. Mark the PR ready for review and mark the phase(s) as completed in the plan.
   7. **Next PR.** I decide manually whether and when to start the next PR. It can start once the previous PR is opened, branching from it, but its own PR can't be opened until the previous one is merged. Before opening, rebase it onto the base branch.

### Escalation

The flow stops and escalates to me for a decision when:

- review findings contradict each other and the agent can't resolve them during triage,
- a review loop reaches three iterations without converging,
- checks keep failing and the agent can’t fix them,
- or implementation shows the plan is wrong.

## Open questions

- **Agent swarms:** How swarms of agents fit into the flow, for example running review lenses in parallel.
- **Worktrees:** Using git worktrees (or a similar mechanism) to isolate the work for each phase, and potentially run phases in parallel.
- **Context management:** A ticket can’t be completed within a single context window. Ideally, each step starts with a clean context, which requires a way to persist and pass on the key context between steps.
- **Plan persistence:** Plans should ideally be temporary and never committed, with only lasting artifacts such as docs or ADRs committed and pushed. Still to decide: where the plan lives while a ticket is in progress, and what happens to it afterwards.
- **Measuring success:** Which metrics show the factory is working, such as how often I change the plan at approval, how much I change at PR review, and cost per ticket.

## Future versions

- **CI failure handling.** An agent investigates and fixes failing CI on opened PRs.
- **Incident investigation.** A second flow that takes an incident as input and produces an investigation report.
