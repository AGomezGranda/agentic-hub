# Payo documentation

Payo is the local, TypeScript-based workflow engine in `payo/`. It turns a Jira
work item or direct prompt into a reviewed implementation plan and waits for
human approval. An explicit implementation action starts a linked execution run
for one PR unit, with sequential phases, configured checks, mandatory code review,
bounded repairs, and restart recovery. The result is a retained local branch and
worktree; pushing and creating pull requests remain future work. The web console
shows planning, execution, review, and combined work costs for Payo runs; it does
not display independent Pi swarms.

## Start here

- [Usage guide](usage.md): setup, TOML and environment configuration, CLI and
  web workflows, plan history, security notes, and recovery. This is the
  user-facing source of truth for supported behavior.
- [Engine design](engine-design.md): module boundaries, current implementation
  scope, and design targets for later workflow slices.
- [`payo/apps/web/README.md`](../../payo/apps/web/README.md): web-app source map,
  testing commands, and frontend dependency rules.

## Design and historical material

| Document | Status and purpose |
|---|---|
| [Implementation roadmap](implementation-roadmap.md) | Planning snapshot. The foundation, web UI, and local approved-plan execution are implemented; PR automation remains future work. Not a live task list. |
| [Agentic factory](agentic-factory.md) | Target end-to-end workflow; publication and human PR review extend beyond the current local execution flow. |
| [High-level architecture](high-level-architecture.md) | Long-term workbench proposal, not a description of current capabilities. |
| [Local workbench research](local-agent-workbench-research.md) | Dated research report and architectural recommendations; upstream details may have changed. |
| [Web UI direction](payo-web-ui-v1.md) | Historical UI proposal. The running app and usage guide supersede its phase plan. |
| [UI design system](ui-design-system.md) | Current visual tokens and accessibility guardrails for the web console. |

## Source map

- `payo/packages/contracts/`: shared API, run, configuration, and factory schemas.
- `payo/packages/kernel/`: agent execution, event log, run state, storage port,
  and workspace/work-item ports.
- `payo/packages/config/`: shared TOML parsing, validation, and precedence.
- `payo/modules/factory/`: Jira/prompt planning, plan versions/reviews, approval,
  execution preparation, phase/check/review/repair flow, recovery, and work costs.
- `payo/adapters/`: Pi and fake runners, Jira CLI, Git workspaces, process checks,
  and SQLite store adapters.
- `payo/apps/server/`: HTTP/SSE API, run application service, and composition root.
- `payo/apps/cli/`: HTTP client and `payo` commands.
- `payo/apps/web/`: local React console.
