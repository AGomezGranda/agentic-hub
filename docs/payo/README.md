# Payo documentation

Payo is the local, TypeScript-based workflow engine in `payo/`. It turns a Jira
work item or direct prompt into a reviewed implementation plan and stops at the
human approval gate. **It does not implement code, run project checks, or create
pull requests yet.** The web console is for Payo runs; it does not display
independent Pi swarms.

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
| [Implementation roadmap](implementation-roadmap.md) | Planning snapshot. The foundation and web UI are implemented; code implementation and PR automation remain future work. Not a live task list. |
| [Agentic factory](agentic-factory.md) | Target end-to-end workflow; implementation and PR steps describe future vision. |
| [High-level architecture](high-level-architecture.md) | Long-term workbench proposal, not a description of current capabilities. |
| [Local workbench research](local-agent-workbench-research.md) | Dated research report and architectural recommendations; upstream details may have changed. |
| [Web UI direction](payo-web-ui-v1.md) | Historical UI proposal. The running app and usage guide supersede its phase plan. |
| [UI design system](ui-design-system.md) | Current visual tokens and accessibility guardrails for the web console. |

## Source map

- `payo/packages/contracts/`: shared API, run, configuration, and factory schemas.
- `payo/packages/kernel/`: agent execution, event log, run state, storage port,
  and workspace/work-item ports.
- `payo/packages/config/`: shared TOML parsing, validation, and precedence.
- `payo/modules/factory/`: Jira/prompt planning, plan reviews, human gates,
  versions, and approval flow.
- `payo/adapters/`: Pi runner, Jira CLI, Git workspace, fake runner, and SQLite
  store adapters.
- `payo/apps/server/`: HTTP/SSE API and composition root.
- `payo/apps/cli/`: HTTP client and `payo` commands.
- `payo/apps/web/`: local React console.
