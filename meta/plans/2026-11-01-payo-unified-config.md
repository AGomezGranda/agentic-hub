---
date: 2026-11-01
title: Payo unified TOML configuration
status: complete
---

## Current State

- `payo/apps/server/src/config.ts:7-22,103-139` resolves server settings from environment variables and code defaults. These include the data directory, repo and base branch, concurrency, web origins, tool binaries, provider, model, and listener port. `PAYO_TEST_PORT`, `PAYO_SCENARIO`, and `--dev-fakes` are test/development controls in this same module (`:34-42,77-80,116-119`).
- The CLI separately resolves its data directory and assumes the server is on port `7331` (`payo/apps/cli/src/client.ts:30-40`). Both processes must resolve the same TOML file once `data_dir` and `port` are configurable.
- All four roles currently receive one model and a hard-coded 300,000 ms timeout (`payo/apps/server/src/composition.ts:111-115`). `FactoryRunConfig` already persists a model and timeout per role (`payo/packages/contracts/src/factory.ts:150-183`), so effective choices can remain stable for existing runs.
- The Pi adapter accepts provider-qualified model IDs, and its auth check currently checks one provider at a time (`payo/adapters/runner-pi/src/index.ts:339-371,427-455`). `runDoctor` currently performs one Pi check using the global provider (`payo/apps/server/src/doctor.ts:31-38`).
- The CLI is currently restricted to importing `@payo/contracts` by Biome and `payo/test/boundaries.test.ts:19-27,120-145`; using one shared config reader therefore needs an explicit, narrow boundary exception rather than a server import.
- `docs/payo/usage.md:237-252` documents the current environment-variable interface. The working tree already has uncommitted edits to this file and unrelated web UI changes; implementation must preserve and integrate those edits rather than revert them.

## Design Decisions

- Use one per-user file at `~/.config/payo/config.toml`; select another file with an absolute `PAYO_CONFIG_FILE`. An absent default file means defaults plus environment variables; an explicitly selected but missing file is an error.
- Resolve settings in this order: built-in defaults, TOML values, then environment overrides. Existing `payo start --repo` and `--base` remain the highest-priority per-run overrides. Test-only port/server URL values and fake-mode controls stay outside the TOML file.
- Add a small Node-only `@payo/config` workspace package shared by the CLI and server. It owns TOML parsing, typed validation, defaults, environment overrides, and common path/port resolution. The CLI may import this package only for local bootstrap settings; it must not import server, factory, or adapter code. The web package continues to import contracts only and never reads the local file.
- Use `smol-toml` (`^1.9.1`) with unsafe-key rejection and Zod (`^4.6.7`) for strict schema validation. Unknown TOML keys fail with a path-qualified error instead of being silently ignored. Keep TOML read-only; Payo does not rewrite or migrate the user's file.
- V1 configuration sections are `[server]` (`port`, `web_origins`), `[paths]` (`data_dir`, `repo`, `base_branch`), `[execution]` (`max_concurrent_agents`), `[tools]` (`pi`, `acli`, `git`), and `[model]` (`provider`, `id`). The server always binds to `127.0.0.1`; the bind address is not configurable. Keep existing defaults: port `7331`, data directory `~/.payo`, repo equal to server startup cwd, base branch `main`, concurrency `4`, tools `pi`/`acli`/`git`, and provider `anthropic`.
- Add optional `[roles.planner]`, `[roles.reviewer]`, `[roles.verifier]`, and `[roles.reviser]` tables with `timeout_ms` and an optional inline `model = { provider = "...", id = "..." }`. An omitted role model inherits `[model]`; each role timeout defaults to the existing 300,000 ms. A model selection is a provider/model pair, not a catalogue entry. Pi remains authoritative for provider credentials, endpoints, and provider-specific model setup.
- Preserve current environment names. `PAYO_MODEL` and `PAYO_PI_PROVIDER` are global overrides applied to all effective role selections, so they retain their current shared-setting behavior even when TOML contains role overrides. Keep `PAYO_DATA_DIR`, `PAYO_REPO`, `PAYO_BASE_BRANCH`, `PAYO_MAX_CONCURRENT_AGENTS`, `PAYO_WEB_ORIGINS`, `PAYO_PI_BIN`, `PAYO_ACLI_BIN`, and `PAYO_GIT_BIN` as overrides. Add `PAYO_PORT` for the configured loopback port and `PAYO_CONFIG_FILE` for the file location. Keep `PAYO_TEST_PORT`, `PAYO_TEST_SERVER_URL`, `PAYO_SCENARIO`, `NODE_ENV`, `--dev-fakes`, and `VISUAL`/`EDITOR` out of TOML.
- Normalize each effective model to `provider/id` in the existing per-role run config. This preserves provider identity without changing the persisted `RoleSettings` contract; every new run records its resolved role models and timeouts, and config edits affect only later runs.
- A real run must resolve a model for every role. `payo doctor` checks every distinct configured provider through Pi, aggregates provider results into its existing single `pi` check, and never prints credential values. If no role has an explicit provider/model, the default provider remains `anthropic` for doctor reporting in fake mode.
- No web UI or config endpoint is part of this change. When the web app later needs settings, it will receive an explicit sanitized view from the authenticated server API rather than parsing TOML or receiving the raw local config.

## Risks & Mitigations

- **CLI and server read different config/data locations:** both use `@payo/config` with the same `PAYO_CONFIG_FILE` and environment. Unit tests cover resolution parity; process acceptance covers TOML `data_dir`/token parity and the normal TOML-configured port path. Keep the dynamic-port test-only scenario separate because `PAYO_TEST_PORT` and `PAYO_TEST_SERVER_URL` bypass normal port resolution.
- **TOML typos or unsafe keys silently change behavior:** strict Zod objects reject unknown keys; `smol-toml` runs with unsafe-key rejection. Tests cover unknown keys, duplicate keys, `__proto__`, malformed syntax, and invalid value ranges.
- **Environment model settings unexpectedly bypass role choices:** document and test the explicit compatibility rule that `PAYO_MODEL` and `PAYO_PI_PROVIDER` override all roles; without those variables, each role inherits the default or uses its TOML override.
- **Provider authentication appears healthy for only one of several configured providers:** doctor gathers distinct providers from effective role selections and fails its aggregate Pi check if any required provider is unavailable. Unit tests assert every distinct provider is probed once and duplicate selections are not probed repeatedly.
- **Config changes alter work already in progress:** role models, timeouts, and effective concurrency continue to be recorded on `run.created`; tests assert later settings changes do not rewrite an existing run's recorded config.
- **A configurable port weakens the local-only security boundary:** keep the listener bound to `127.0.0.1`, validate ports in `1..65535`, and retain port `0` only through `PAYO_TEST_PORT` when `NODE_ENV=test`.
- **Provider secrets leak into the shared file or future web UI:** keep secrets and provider endpoints in Pi's existing configuration/auth system, reject unsupported TOML fields, and do not expose raw config through an API. The future web view is explicitly out of scope here.
- **Documentation edits conflict with ongoing local work:** update the existing `docs/payo/usage.md` in place and retain its current uncommitted edits; do not reset or replace unrelated web UI changes.

## Phase 1 — Shared TOML configuration and bootstrap resolution

### Overview

Introduce one typed config reader shared by the server and CLI. Move production operator settings into the TOML schema while preserving existing environment variables, test seams, loopback binding, and per-run CLI overrides.

### Changes

- Add `payo/packages/config/package.json` as `@payo/config`, exporting `./src/index.ts` and declaring `smol-toml` and `zod` as direct dependencies. Add `payo/packages/config/src/index.ts` with `PayoConfig`, `ModelSelection`, `PayoRole`, `loadPayoConfig(env, cwd)`, the default config path resolver, and `resolveDataDir`. Parse TOML with unsafe-key behavior set to `throw`, validate strict sections and values, and convert parser/validation failures into actionable errors that include the config path.
- Add `payo/packages/config/src/index.test.ts` before the implementation. Unit tests cover: absent default file; valid defaults and full TOML; `PAYO_CONFIG_FILE` absolute-path selection; explicit missing-file error; default-file missing behavior; malformed TOML and duplicate keys; unsafe keys; unknown settings; precedence of defaults/TOML/environment; blank values; absolute path checks; positive concurrency and port ranges; exact loopback origin validation; comma-separated `PAYO_WEB_ORIGINS`; and rejection of a slash in the separate provider/model fields.
- Resolve `[model]` as an optional default pair in this phase. Real-mode validation remains in the server; the config package may return no model so fake mode and `payo doctor` continue to work without `PAYO_MODEL`.
- Keep test-only behavior in `payo/apps/server/src/config.ts`: delegate production settings to `loadPayoConfig`, then resolve `devFakes`, `scenario`, `testMode`, and the test-only `PAYO_TEST_PORT` override. `PAYO_TEST_PORT=0` remains valid only under `NODE_ENV=test`; normal `port` remains `1..65535`.
- Update `payo/apps/server/src/main.ts` to use the shared resolved data directory, repo, base branch, concurrency, origins, port, and tool binaries. Preserve the hard-coded `127.0.0.1` bind and current startup/doctor behavior.
- Add `@payo/config` to `payo/apps/cli/package.json`. Update `payo/apps/cli/src/client.ts` so `resolveDataDir` and the normal `serverUrl` come from the same shared config resolution as the server; retain `PAYO_TEST_SERVER_URL` only when `NODE_ENV=test`. Do not make the CLI import `apps/server`.
- Update the CLI boundary exception in `payo/biome.json` and the explicit cases/messages in `payo/test/boundaries.test.ts`: allow `apps/cli` to import `@payo/contracts` and `@payo/config`, reject server or other Payo imports, and assert that `@payo/config` imports no other Payo package. Keep `apps/web` restricted to contracts.
- Add a tracked `payo/config.example.toml` with the non-secret defaults and the `[model]` pair; omit machine-specific repo/data paths so those continue to use documented defaults. Do not add secrets, tokens, or provider endpoints.

### Tests

- **Unit — `packages/config/src/index.test.ts`:** parse a complete fixture and check the resolved type; absent/default file behavior; precedence; malformed, duplicate, unknown, and unsafe keys; invalid paths, ports, concurrency, model pairs, and origins. These are cheapest to test directly at the parser boundary.
- **Unit — `apps/server/src/config.test.ts`:** preserve fake scenario gating and test-port restrictions while confirming server settings come from the shared loader and test values cannot enter production config.
- **Unit — `apps/cli/src/client.test.ts`:** read the same data directory and port from TOML and prove environment values override TOML; retain the test-only server URL behavior.
- **Boundary — `test/boundaries.test.ts` and `biome.json`:** prove CLI may import the shared config package but not server internals, and the web still cannot import config.

### Success criteria

**Automated:**
- `pnpm -C payo exec vitest run packages/config/src/index.test.ts apps/server/src/config.test.ts apps/cli/src/client.test.ts test/boundaries.test.ts`
- `pnpm -C payo check`

**Manual:** With no config file, start the dev-fake server and verify the current defaults still work. Then use an absolute `PAYO_CONFIG_FILE` pointing to a temporary TOML file with a non-default `data_dir` and `port`; confirm startup uses those values, stays on `127.0.0.1`, and an environment override wins over the file.

### Implementation progress

- [x] Phase 1 — shared TOML configuration and bootstrap resolution (`pnpm -C payo check` passed; manual smoke deferred to process acceptance in Phase 3).
- [x] Phase 2 — per-role model/provider and timeout resolution (`pnpm -C payo check` passed; manual multi-provider auth check not performed because it requires disposable authenticated Pi providers).
- [x] Phase 3 — documentation, compatibility, and process acceptance (targeted 108 tests and full `pnpm -C payo check` passed; manual TOML smoke verified doctor, token, fake run/status, loopback port, and environment concurrency override).

### What we're NOT doing

No config-writing command, config hot reload, project-local config discovery, multiple layered config files, non-loopback bind, remote access, web UI/API, credential storage, provider endpoint configuration, or provider/model catalogue.

## Phase 2 — Per-role model/provider and timeout resolution

### Overview

Allow each factory role to inherit the configured default model or override it with another Pi provider/model pair and timeout. Pass those resolved values into the factory, doctor, and Pi runner while keeping run snapshots immutable.

### Changes

- Extend the config schema in `payo/packages/config/src/index.ts` for the four `[roles.<role>]` tables. Validate each role override as a complete `{ provider, id }` pair, reject blank or slash-containing values, and constrain `timeout_ms` to `1..2,147,483,647` (default `300000`) to match the `AgentSpec` timer limit. Resolve role model as role override or global `[model]`; apply legacy `PAYO_MODEL` and `PAYO_PI_PROVIDER` field overrides to every role after TOML resolution.
- Update `payo/apps/server/src/config.ts` types to expose `roles: Record<PayoRole, { model: ModelSelection | null; timeoutMs: number }>` and use the same role defaults for fake and real mode. In real mode, fail before opening the listener if any role resolves without a model; the error names the missing roles and points users to `[model]`, `[roles.<role>]`, or legacy environment variables.
- Update `payo/apps/server/src/composition.ts` to map each role to `model: "<provider>/<id>"` and its configured timeout when calling `beginFactory`. Preserve effective per-role models, timeouts, and concurrency in `run.created.config.factory`; do not change the persisted `RoleSettings` schema because it already stores the fully qualified model string and timeout.
- Update `payo/apps/server/src/doctor.ts` to collect unique providers from effective role selections, or the default provider when none are selected, call the Pi auth probe once per provider, and return one aggregate `pi` check in the existing doctor response. Retain redaction and bounded detail handling.
- Update `payo/apps/server/src/adapters.ts` to construct `createPiRunner` with the default provider for unqualified/harness fallback use. Effective role models sent by composition are provider-qualified, so the runner forwards each role's requested model unchanged through its existing `--model` path.
- Add coverage to `payo/apps/server/src/config.test.ts`, `payo/apps/server/src/composition.test.ts`, and `payo/apps/server/src/doctor.test.ts`. Extend `payo/adapters/runner-pi/src/index.test.ts` only if necessary to pin that provider-qualified IDs continue to pass through unchanged; the current test already exercises `custom/model` in `index.test.ts:413-430`.

### Tests

- **Unit — `packages/config/src/index.test.ts`:** default inheritance; independent planner/reviewer overrides; role timeout defaults and overrides; reject the valid TOML value `timeout_ms = 2147483648`; incomplete role model pairs; legacy provider/model env overrides winning over TOML role settings; and real-mode missing-role detection at the server-config boundary.
- **Unit — `apps/server/src/doctor.test.ts`:** one check per unique provider, duplicate providers probed once, multiple provider failures make the aggregate Pi check fail, and failure details do not contain credentials.
- **Component — `apps/server/src/composition.test.ts`:** a new run records each role's provider-qualified model and timeout; later config changes do not alter the persisted run config; concurrency behavior remains capped by active-run records.
- **Unit — `adapters/runner-pi/src/index.test.ts`:** provider-qualified role model is passed as the single `--model` value without a duplicate provider prefix. Reuse the existing fake spawn harness, not a live Pi login.

### Success criteria

**Automated:**
- `pnpm -C payo exec vitest run packages/config/src/index.test.ts apps/server/src/config.test.ts apps/server/src/composition.test.ts apps/server/src/doctor.test.ts adapters/runner-pi/src/index.test.ts`
- `pnpm -C payo check`

**Manual:** Configure two roles with different Pi provider/model pairs and run `payo doctor` with both providers authenticated; verify one `pi` check reports readiness. Remove one provider's auth in a disposable Pi test setup and confirm the aggregate check fails without printing secrets. No live agent run is required.

### What we're NOT doing

No named model-profile catalogue, routing/fallback policy, model discovery, provider-specific request parameters, direct provider adapters, credential management, or per-run model selection. A selected role model/provider is fixed into a run when it starts.

## Phase 3 — Documentation, compatibility, and process acceptance

### Overview

Document the single settings surface and prove the same config file drives both processes. Preserve environment-only setups so existing users can adopt TOML incrementally or roll back by removing the file.

### Changes

- Update the Payo configuration section in `docs/payo/usage.md` and the Payo setup section in `README.md`. Document `~/.config/payo/config.toml`, absolute `PAYO_CONFIG_FILE`, every TOML section/key/default, strict validation, defaults → TOML → environment → per-run CLI precedence, legacy environment aliases, test/fake-only controls, fixed loopback binding, and provider credentials remaining in Pi. State that the config file is trusted input because `[tools]` values select executables; advise users not to run Payo with an untrusted config. Include role inheritance and a complete inline `{ provider, id }` override example.
- Add `payo/config.example.toml` to the Payo usage instructions. Keep its values non-secret, omit local repository/data paths, and state that config edits require a server restart.
- Extend `payo/apps/server/src/e2e.test.ts` with process-level acceptance coverage using two scenarios. Retain a dynamic-port scenario with `PAYO_TEST_PORT=0` and `PAYO_TEST_SERVER_URL` to prove `payo token` finds the token under the TOML `data_dir` and a fake run works. Add a configured-port scenario that chooses a free nonzero loopback port, writes it to TOML `[server].port`, starts the server with `PAYO_CONFIG_FILE` and `--dev-fakes` but without `PAYO_TEST_PORT`, and invokes the CLI with the same file but without `PAYO_TEST_SERVER_URL`; assert the CLI connects and can start and observe a run. If the chosen port is occupied before the server binds, retry with another free port. This verifies the normal server/CLI TOML port path across processes.
- Extend CLI/config tests to prove current environment-only invocation still works with no TOML file and that each legacy variable keeps its documented meaning. Preserve `PAYO_TEST_PORT` and `PAYO_TEST_SERVER_URL` restrictions to `NODE_ENV=test` and `PAYO_SCENARIO` restriction to `--dev-fakes`.
- Update the current uncommitted `docs/payo/usage.md` content in place; do not reset, reformat wholesale, or revert the unrelated web UI edits in the working tree.

### Tests

- **Unit:** Existing config and CLI unit tests pin missing-file fallback, environment-only compatibility, and precedence; edge cases remain covered at the config parser level rather than duplicated in process tests.
- **Integration — `apps/server/src/e2e.test.ts`:** a temp-file/temporary-data-directory dynamic-port scenario proves data-directory/token parity and a simple fake run; a separate nonzero TOML-port scenario, without test URL/port overrides, proves server and CLI resolve the configured port through the public CLI path.
- **Full suite:** run the complete Payo check to catch workspace dependency, Biome boundary, type, and regression failures.

### Success criteria

**Automated:**
- `pnpm -C payo exec vitest run packages/config/src/index.test.ts apps/server/src/config.test.ts apps/server/src/doctor.test.ts apps/server/src/composition.test.ts apps/server/src/e2e.test.ts apps/cli/src/client.test.ts test/boundaries.test.ts`
- `pnpm -C payo check`

**Manual:** From `payo/`, create a user config with the documented sample, start the dev-fake server, run `payo doctor`, `payo start`, and `payo status`, then change `PAYO_MAX_CONCURRENT_AGENTS` in the environment to confirm it overrides TOML. Remove the config file and verify the documented legacy environment-only setup still works. Confirm the listener remains loopback-only and the config contains no secrets.

### What we're NOT doing

No web settings screen, settings API, remote config editing, TOML migration writer, live reload, real Jira/Git/Pi end-to-end run, or change to Payo's current workflow behavior beyond the selected role models and timeouts.

## Plan Validation

- All current production server settings map to `[server]`, `[paths]`, `[execution]`, `[tools]`, or `[model]`; role-specific choices map to `[roles.<role>]`. Test/fake controls, editor selection, Pi credentials, and per-run repository overrides remain in their existing sources.
- Server and CLI share one loader for user settings; the server stays the only composition root, and CLI gains only the narrow `@payo/config` dependency required to find the same data directory and listener port.
- Model selection remains a provider/model pair interpreted by Pi, not a Payo model registry. Per-role effective settings continue to use the already persisted role schema.
- No secrets are stored in TOML or returned through an API. The future web app consumes a sanitized server-owned view; no web code changes are planned.
- Rollback requires only removing the optional TOML file or using existing environment variables; no existing persisted run or SQLite schema changes.
