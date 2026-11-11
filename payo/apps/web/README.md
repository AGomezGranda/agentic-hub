# Payo web app

A local React/Vite console for the Payo HTTP API. Keep browser code here;
`@payo/contracts` is the only Payo workspace package it may import.
See [the usage guide](../../../docs/payo/usage.md) for server startup, allowed
origins and token setup.

The sidebar run list refreshes every five seconds. Select a run to see its swarm,
decisions and activity; its workspace streams recorded events while open.
Agent activity may be delayed: the producer batches events and may hold a
partial batch until an attempt ends. Select an agent to inspect its recorded
output, which may contain sensitive text. Server status, run creation and the
shared TOML **Settings** editor each have their own page in the main navigation.

Planning workspaces offer Swarm view, Plan, and Activity view. Approved plans
have explicit per-PR implementation actions. Execution workspaces offer
Implementation, Code review, and Activity view, including phase progress,
checks, finding evidence, verifier decisions, coverage, and saved review context.
Plan-issue gates support clarification answers, unchanged retry, or a new
corrected planning run; corrections keep the original execution paused and do
not transfer its edits. Header actions open the repository or execution worktree
in Terminal or VS Code on the server machine (macOS/Linux).

Each workspace shows the combined cost of planning and all PR executions, with
an expandable breakdown by run, step and attempt. Currency and reporting basis
stay separate; partial and unknown coverage are labeled. Costs refresh every
five seconds while any included run is active, and after workspace updates.
The authenticated `GET /api/v1/runs/:runId/costs` endpoint returns the same work
cost tree from either a planning run or an execution run.

The connection screen accepts a loopback port (default `7331`) and keeps only
that port in `sessionStorage`; the bearer token remains memory-only. After
changing `[server].port`, restart Payo and reconnect at the new port. The
Settings page writes only the server-selected config file and explains that a
restart is required for changes to apply.

## Source layout

```text
src/
  main.tsx                    Browser entry point
  app/
    App.tsx                   Query provider, in-memory session and screen composition
    navigation.ts             Browser-history routing
    styles.css                Global styles and theme tokens
  features/
    connection/               Token prompt, port selection, doctor status and connection errors
    runs/                     Run list, creation form and run-summary API
    run-workspace/            Run display, activity, event API and streaming
      useRunActivity.ts       Queries, stream lifetime, retries and cache refresh
      stream.ts               SSE parsing, event ordering and authenticated transport
    plan-review/              Plan rendering, answers, gate commands and review API
    settings/                 TOML settings form, validation and config API
  shared/
    api/client.ts             HTTP transport, loopback port and API errors
    ui/Button.tsx             Feature-independent UI controls
  test/setup.ts               Shared DOM-test setup
```

Tests live beside their implementation. App tests exercise assembled flows;
feature tests cover interactions and streaming, and shared tests cover transport.
Settings tests cover field editing, contract-backed validation, conflict reload,
environment overrides and dirty-draft navigation guards. Transport tests cover
`PUT`, selected-port URLs and the session-only port.

## Dependency rules

- `app` composes features and owns application-wide resources and session state.
- Features never import `app`, `main.tsx` or test setup.
- `shared` never imports features or app code. Put code here only when it is
  genuinely feature-independent, not simply because it is used in two files.
- Cross-feature dependencies form a directed graph:
  `run-workspace → plan-review → runs`, with `run-workspace → runs` also allowed.
  `connection`, `runs` and `settings` depend only on shared code and external
  packages.
- Endpoint functions belong to the feature that uses them; only HTTP mechanics
  belong in `shared/api`. Public request/response schemas stay in `@payo/contracts`.
- Use relative imports inside a feature and `@web/…` for imports across source
  areas. The alias is configured in both TypeScript and Vite.
- Prefer direct imports over catch-all barrel files. Do not add empty layers or
  new packages just to accommodate one component.

`payo/test/web-boundaries.test.ts` checks source placement and the dependency
graph for literal imports/re-exports (including literal dynamic imports), using
resolved paths so relative imports cannot bypass the rules. Computed import
specifiers are not checked. The existing Biome boundary checks prohibit server,
adapter and other non-contract Payo package imports.

## Commands

From the repository root:

```sh
pnpm -C payo web:dev
pnpm -C payo web:build
pnpm -C payo check
pnpm -C payo exec vitest run --project web
pnpm -C payo exec vitest run test/web-boundaries.test.ts test/boundaries.test.ts
```

The root Vitest config runs separate `core` (Node) and `web` (jsdom) projects.
The web project loads its own Vite config, so tests and production builds use the
same source aliases and React transform.
