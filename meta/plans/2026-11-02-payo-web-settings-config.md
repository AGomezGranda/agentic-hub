---
date: 2026-11-02
title: Payo web settings and config editor
status: Complete
---

# Payo web settings and config editor

## Current State

- `payo/packages/config/src/index.ts:20-29,59-96` defines the resolved `PayoConfig` type and strict TOML schema. `loadPayoConfig` reads the selected file and resolves defaults, TOML values, then environment overrides (`:111-235`). The resolved result includes `configFile`, but `payo/apps/server/src/config.ts:12-28,54-80` currently drops that path and keeps only effective settings.
- `payo/apps/server/src/composition.ts:37-39` exposes the effective `ServerConfig` through `Composition`; there is no service for reading or writing the source TOML document.
- `payo/apps/server/src/http.ts:54-96` checks loopback Host/Origin and bearer authorization before routing to the current doctor and run endpoints. There is no settings route.
- `payo/apps/web/src/app/App.tsx:128-180,199-265` composes the authenticated sidebar and the New run/Server status pages. `payo/apps/web/src/app/navigation.ts:4-30` handles those paths and selected-run routes.
- The web client hardcodes `http://127.0.0.1:7331/api/v1` (`payo/apps/web/src/shared/api/client.ts:1-27`); the SSE client shares that constant (`payo/apps/web/src/features/run-workspace/stream.ts:6,134`). Connection copy also hardcodes port 7331 (`payo/apps/web/src/features/connection/DoctorCard.tsx:46`, `messages.ts:9-10`). Since `[server].port` is editable, the connection flow must support a non-default loopback port too.
- The web app may import only `@payo/contracts` (`payo/apps/web/README.md:3-4`, `payo/test/boundaries.test.ts:21-27,92-96`). Public API schemas belong in contracts (`payo/apps/web/README.md:32-37`). The new file schema will be shared there, with a narrow `@payo/config` → `@payo/contracts` dependency exception so config parsing, persistence, and API validation use the same schema.
- `docs/payo/usage.md:239-305` documents every supported TOML key, environment precedence, and the current read-only behavior. `payo/packages/config/src/index.test.ts` and `payo/apps/server/src/http.test.ts:29-95,238-379` provide the existing parser and authenticated API test patterns.
- The working tree already contains staged config, docs, and web changes. This plan adds a separate implementation; those existing changes must be preserved.

## Design Decisions

- **Edit the TOML document, not process environment or test controls.** The UI covers every supported file setting: `[server]`, `[paths]`, `[execution]`, `[tools]`, `[model]`, and all four `[roles.<role>]` tables. It does not edit environment variables, `PAYO_CONFIG_FILE`, fake/test controls, `VISUAL`/`EDITOR`, Pi credentials/endpoints, or the fixed loopback bind address.
- **One public strict schema.** Add `PayoConfigDocument` to `@payo/contracts` as a strict, browser-safe schema with optional sections/keys matching the TOML format. It must not import Node built-ins; use a portable absolute-path check there and retain `node:path.isAbsolute` as a host-specific validation in `@payo/config`. `@payo/config` may import only this contract; update Biome and boundary tests to allow that single dependency. This avoids divergent structural validation between the file writer, API, and form transport.
- **Write only the process-selected file.** The API never accepts a path. It uses the `PAYO_CONFIG_FILE`-selected path or the default path resolved at server startup. The authenticated snapshot identifies the path, the parsed file document, a revision digest, and the names (not values) of environment variables currently overriding TOML fields.
- **Validate and protect persistence.** Validate the request and resolve the candidate using the same defaults/environment precedence as startup before writing. In real mode, reject a candidate missing an effective model for any role; fake mode may keep models unset. On POSIX, write canonical TOML atomically with mode `0600` and create missing parent directories with mode `0700` without changing existing directory permissions. On Windows, document that mode bits do not provide the same owner-only guarantee and that this phase does not change ACLs. Require the snapshot revision on save so edits visible at the revision check return a conflict; atomic rename cannot prevent an unrelated process from writing in the check-to-rename window, so do not promise protection against that race.
- **Canonical TOML output.** Use the installed `smol-toml` serializer after validation. The structured form will rewrite formatting and remove comments; preserving arbitrary comments or byte formatting is not in scope. A pre-save validation error or revision conflict must leave the file untouched.
- **Restart is explicit.** Saving does not mutate `Composition.config`, reload adapters, or restart the server. The UI states before and after save that the file is saved but changes take effect only after restarting Payo. Environment variables continue to override saved TOML values; show which variable names are active so a saved setting is not misrepresented as effective.
- **Keep the browser local and token handling unchanged.** Add a session-only loopback port choice to the connection prompt (default `7331`) and build both HTTP and SSE URLs from it. Store only the port in `sessionStorage`; keep the bearer token in memory as today. Never accept a non-loopback host from the browser UI.

## Risks & Mitigations

- **A save corrupts or partially truncates the user's config:** validate before writing; on POSIX, write a unique same-directory temporary file with exclusive creation and mode `0600`, rename atomically, and clean up failed temporary files. Reject symlink config paths before saving so atomic rename cannot silently replace the link. Test existing-file and missing-file paths, plus an injected temp-write or rename failure that leaves the original bytes intact and removes the temporary file. Windows mode-bit limitations are documented separately.
- **A stale browser tab overwrites a manual or second-tab edit:** include a SHA-256 revision of the exact current file bytes (or a distinct missing-file revision) in GET; require it in PUT, compare immediately before replacement, serialize concurrent in-process writes, and return `409 conflict` if the revision differs. This detects edits present at the check, but cannot close the check-to-rename race with an unrelated process; document this limit rather than claiming an absolute no-clobber guarantee. Keep the user's draft visible and offer reload on conflict.
- **Environment overrides make saved values appear ineffective:** return only active override variable names, explain defaults → TOML → environment precedence, and distinguish file values from active overrides in the page. Do not copy effective environment values into the TOML automatically.
- **Changing the port or CORS origins locks out the browser:** make the connection port editable and session-only, show the selected loopback target, warn when the current web origin is absent from the candidate `web_origins`, and document reconnecting after a port change. Keep the bind address fixed to loopback.
- **Changing `paths.data_dir` appears to lose runs or token access:** explain that the data directory also selects the database and token location; verify the same TOML is used by the server and CLI after restart.
- **A structurally valid TOML file cannot start real mode:** run effective role-model checks against the candidate before persistence; preserve server startup validation as the final authority.
- **A dense form is difficult to use or its values are ambiguous:** group controls by TOML section, state validation requirements beside the fields, label empty optional model pairs as unset/inherit, expose save/error/conflict states in text, and inspect the layout at narrow and desktop widths.
- **Existing staged work is accidentally changed:** keep edits scoped to the planned files and inspect the staged diff before implementation; do not reset or reformat unrelated files.

## Phase 1 — Shared schema and safe config-file persistence

### Overview

Make the TOML document itself a validated, testable type that both the server API and browser contracts can use. Add safe read/write operations to the Node-only config package without changing startup resolution or environment precedence.

### Changes

- Add `payo/packages/contracts/src/config.ts` with `PayoConfigDocument`, its inferred type, and strict, browser-safe schemas for every existing TOML section/key. Keep fields optional so an absent key continues to mean the existing default or inheritance behavior. Use portable validators and no Node imports; retain host-specific `isAbsolute` validation in `@payo/config`. Export it from `payo/packages/contracts/src/index.ts`.
- Add `ConfigSettingsSnapshot` and `SaveConfigSettingsRequest` schemas/types in the same contract file: snapshot fields are `configFile`, `revision`, `document`, and `environmentOverrides: string[]`; save request fields are `revision` and `document`. Reject unknown fields at both levels.
- Refactor `payo/packages/config/src/index.ts` to consume `PayoConfigDocument` instead of its private duplicate `tomlSchema`. Extract the side-effect-free resolution step as `resolvePayoConfigDocument(document, env, cwd)` so normal startup and candidate-save validation use identical precedence and validation.
- Add config package functions `readPayoConfigDocument(configFile)` and `writePayoConfigDocument(configFile, document, expectedRevision)`. Reads return `{ configFile, revision, document }`, with `{}` and a distinct revision for a missing file. Writes target only the path passed by the server's startup-resolved `ServerConfig.configFile`, validate with the shared schema, check the expected raw-file revision immediately before replacement, serialize via `smol-toml.stringify`, and return the new snapshot. Reject an existing symlink config path before saving. On POSIX, create missing parent directories with mode `0700` without changing existing directories and atomically replace through a same-directory exclusive temporary file with mode `0600`; on Windows, document that mode bits do not guarantee owner-only access and leave ACLs unchanged. The API never supplies this path. Do not silently create an explicitly selected missing file on startup; a successful UI save may create it. A revision check followed by rename still has a narrow race with unrelated external writers; document this limitation.
- Add a config helper that reports active TOML-overriding environment variable **names** for the snapshot; never return environment values. Include legacy global model/provider overrides and path, server, tool, concurrency, and origin overrides.
- Add `@payo/contracts` as the sole Payo dependency of `payo/packages/config/package.json` and update its importer in `payo/pnpm-lock.yaml`. Update `payo/biome.json` and `payo/test/boundaries.test.ts` so config may import contracts but still cannot import any other Payo package.
- Add `configFile` to `ServerConfig` in `payo/apps/server/src/config.ts` so server composition can use the exact path resolved at startup. Keep the current `PayoConfig` resolution defaults and all CLI behavior unchanged.

### Tests (write first)

- **Contract unit — `payo/packages/contracts/src/config.test.ts`:** accept a full fixture with all sections and role overrides; accept absent sections and optional keys; reject unknown top-level and nested fields, invalid port/concurrency/timeouts, relative configured paths, invalid origins, blank executables, incomplete provider/model pairs, and a save envelope with an unknown key.
- **Config unit — `payo/packages/config/src/index.test.ts`:** preserve all existing defaults/precedence cases; verify read of a missing default and a complete explicit file; verify read/write round-trip through TOML for every key; reject invalid candidates (including paths that fail host-specific absolute-path validation) without changing existing bytes; verify symlink config paths are rejected for writes; verify file creation, mode `0600`, and newly created parent-directory mode `0700` on POSIX; verify stale revisions conflict; verify an external edit completed before the revision check is not overwritten; verify concurrent writes with the same revision cannot both succeed; inject a temp-write or rename failure and verify original bytes remain intact and failed temporary files are removed; verify environment overrides remain authoritative after writing.
- **Boundary — `payo/test/boundaries.test.ts` and `payo/biome.json`:** assert config → contracts is allowed, config → any other Payo package remains rejected, and the web package remains restricted to contracts.

### Success criteria

- [x] **Automated:** `pnpm -C payo exec vitest run packages/contracts/src/config.test.ts packages/config/src/index.test.ts test/boundaries.test.ts`; `pnpm -C payo exec biome check packages/config packages/contracts test/boundaries.test.ts`.
- [ ] **Manual:** Inspect a serialized full config for valid TOML, verify a failed validation leaves the original file byte-for-byte intact, and confirm the generated file has restrictive permissions on a POSIX system.

### What we're NOT doing

TOML comment/format preservation, config hot reload, migration of old config, multiple config files, or changes to CLI resolution semantics.

## Phase 2 — Authenticated config settings API

### Overview

Expose the selected TOML document through a token-protected API and save validated updates through the config persistence boundary. Keep HTTP routing separate from filesystem mechanics and do not mutate the running composition.

### Changes

- Add `payo/apps/server/src/settings.ts` with a `ConfigSettingsService` that composes `readPayoConfigDocument` / `writePayoConfigDocument`, reports active override names, resolves the submitted document with `resolvePayoConfigDocument` using the startup environment and working directory, and validates effective role models against the server's `devFakes` mode before any file write. Extract `assertRealModeRoleModels(roles, devFakes)` in `payo/apps/server/src/config.ts` and have existing `assertRealModeModels(config)` and settings-save validation use it, so startup and save share the same real-mode rule.
- Update `payo/apps/server/src/auth.ts` so `corsHeaders` advertises `PUT` alongside the existing methods; keep exact Host/Origin validation unchanged.
- Extend `HandlerOptions` in `payo/apps/server/src/http.ts` with an injected `ConfigSettingsService`. Add `GET /api/v1/settings/config` returning `ConfigSettingsSnapshot` and `PUT /api/v1/settings/config` accepting `SaveConfigSettingsRequest`; reject other methods, validate the complete request, return `400 invalid_request` for schema failures and `409 conflict` for stale revisions. Keep both routes behind the existing Host, Origin, bearer-token and startup checks.
- Construct the settings service in `payo/apps/server/src/main.ts` using the startup-resolved `configFile`, process environment, and fake-mode flag; pass it to `createHandler`. Do not pass arbitrary request paths to the service.
- Map filesystem failures to a safe internal API response while logging server-side diagnostics. Do not include config content, environment values, token data, or raw filesystem errors in API error responses.
- Keep `payo/packages/contracts/src/config.ts` as the sole request/response schema source; use its parsers before returning a snapshot and before accepting a save.

### Tests (write first)

- **HTTP component tests — `payo/apps/server/src/http.test.ts`:** GET returns the active config path, document, revision, and override names; PUT writes the exact selected file and returns the new revision; an allowed-origin OPTIONS preflight requesting `PUT` returns the allowed methods including `PUT`; hostile-origin preflight remains rejected; a second save with the old revision returns `409` without replacing an edit already present before the revision check; invalid/unknown bodies return `400`; invalid methods return `405`; wrong/missing token returns `401`; hostile Host/Origin behavior remains unchanged; settings are not available while composition is starting.
- **Service unit tests — `payo/apps/server/src/settings.test.ts`:** real mode rejects a candidate that removes the last effective model for any role before writing; fake mode accepts it; `PAYO_MODEL` / `PAYO_PI_PROVIDER` overrides remain effective; failures do not leak values or alter the file.
- **Integration check:** use a temp `PAYO_CONFIG_FILE` in the existing HTTP harness, save a changed document, then call `loadPayoConfig` against that same file and assert the saved file parses while the existing in-memory `Composition.config` remains unchanged until a restart.

### Success criteria

- [x] **Automated:** `pnpm -C payo exec vitest run packages/contracts/src/config.test.ts packages/config/src/index.test.ts apps/server/src/settings.test.ts apps/server/src/http.test.ts`.
- [ ] **Manual:** With a dev-fakes server and temporary `PAYO_CONFIG_FILE`, GET and save a setting using the bearer token; confirm an unauthenticated request fails, the file changes on disk, and server behavior remains unchanged until restart.

### What we're NOT doing

Hot reload, server self-restart, editing environment variables, editing the config file path through the request, or adding a generic file-management endpoint.

## Phase 3 — Tactical web settings editor

### Overview

Add an authenticated Settings / Config page to the existing sharp, light operations UI. Edit every supported TOML key through typed controls, save to the server API, and make the restart requirement and environment precedence visible.

### Changes

- In `payo/apps/web/src/app/navigation.ts` and `App.tsx`, add `/settings`, a selected sidebar link, heading/description, and the Settings page while preserving run routes, browser history, current token-in-memory lifecycle, and existing navigation.
- Add `payo/apps/web/src/features/settings/api.ts` for GET/PUT using the contract schemas. Extend `payo/apps/web/src/shared/api/client.ts` to support `PUT` while retaining request validation, bearer auth, safe API errors, and abort signals.
- Add `payo/apps/web/src/features/settings/SettingsPage.tsx` with grouped fields for every supported TOML key: port and web origins; data directory, repo and base branch; concurrency; the three executable names; optional global provider/model; and each role's optional model plus timeout. Preserve absent/empty semantics: blank optional fields remain unset, role models inherit the global model when omitted, and provider/model pairs must be complete. Show inline constraints for absolute paths, positive ranges, loopback origins, and provider/model values without `/`.
- Bind the editor to the raw TOML `document`, not resolved values, so saving never copies environment overrides into the file. Show the selected config path, any active overriding environment-variable names, and a persistent explanation that settings take effect after restarting Payo. On save, show the saved state and restart notice; on `409`, retain the draft and offer reload; on validation/API errors, keep the draft and associate messages with the form. Associate field errors with their controls (for example, `aria-describedby` and `aria-invalid`) and expose submission-level errors through an accessible alert/live region. Provide a discard/reset-to-loaded-document action and guard against silently losing a dirty draft when navigating away: cover in-app links and browser Back/Forward, and use the browser's native before-unload warning for reload or tab close. If a `popstate` occurs while dirty, retain the current page until the user confirms or cancels leaving.
- In `payo/apps/web/src/features/connection/TokenPrompt.tsx`, add a numeric loopback server-port field defaulting to `7331`; store only this port in `sessionStorage`. Add `getApiBaseUrl` / `setServerPort` in `shared/api/client.ts` and use the resolved URL in both HTTP requests and `features/run-workspace/stream.ts`. Update `DoctorCard.tsx` and `connection/messages.ts` to report the selected port instead of hardcoding `7331`. Keep the host fixed at `127.0.0.1` and the token memory-only. Explain reconnecting at the configured port after changing `[server].port`.
- Warn when the current web page origin will not be included in the saved `web_origins` for the candidate port. Do not silently add origins or weaken the server's exact-loopback CORS validation.
- Keep styling within existing CSS variables, sharp borders, left sidebar, semantic labels, visible focus, and responsive layout. Update `payo/apps/web/README.md` with the new Settings feature and port selection behavior.

### Tests (write first)

- **Feature API unit — `payo/apps/web/src/features/settings/api.test.ts`:** GET parses the snapshot; PUT sends only the document and expected revision with bearer authorization; malformed responses and safe server errors are rejected.
- **Component tests — `payo/apps/web/src/features/settings/SettingsPage.test.tsx`:** render and edit fields from every section; preserve omitted keys and role inheritance; validate a partial model pair and invalid path/port before submit; verify invalid state and field errors are programmatically associated with controls and submission errors are announced; verify the complete valid document and revision are sent; show successful saved/restart messaging; keep edits visible on server error and stale revision; reload the latest snapshot after conflict; show active environment override names; warn when the current web origin would be excluded; reset restores the loaded document.
- **Assembled app tests — `payo/apps/web/src/app/App.test.tsx`:** Settings appears in the connected main navigation, marks the current route, loads after connection, and remains separate from run selection/history. Verify the bearer token remains in memory and is never placed in the request URL or session storage. Verify cancelling an in-app or browser Back/Forward navigation keeps a dirty settings draft, confirming leaves the page, and reload/tab close triggers the native before-unload warning.
- **Shared transport tests — `payo/apps/web/src/shared/api/client.test.ts` and `features/run-workspace/stream.test.ts`:** PUT method/body and selected-port URL; port validation and default; session-only port survives reload but the bearer token does not; SSE uses the same selected loopback port.

### Success criteria

- [x] **Automated:** `pnpm -C payo exec vitest run --project web`; `pnpm -C payo web:build`.
- [ ] **Manual:** At 320px and desktop widths, navigate to Settings, inspect every section, edit a global model and a role override, clear a role override to inherit, save, refresh the settings data, and confirm the restart notice. Test validation, discard, server error, and stale-revision feedback. Set a non-default port, restart the server, reconnect to that port, and verify doctor, runs, and SSE still work. Confirm CORS origin guidance, visible keyboard focus, and no horizontal overflow.

### What we're NOT doing

Client-side config-file access, remote/non-loopback server hosts, token persistence, live reload, automatic origin insertion, secrets or provider-endpoint editing, config comments preservation, or editing the server's fixed bind address.

## Phase 4 — Documentation and end-to-end verification

### Overview

Document the web editor's exact persistence and restart behavior, then validate the server/API/browser flow without adding a second test harness.

### Changes

- Update the configuration sections in `docs/payo/usage.md` and the root `README.md`: explain Settings navigation, every field and inheritance rule, active environment overrides, the selected config path, canonical TOML rewrite/comment behavior, POSIX `0600` saved files and `0700` newly created parent directories (existing directory permissions are unchanged), and that Windows ACLs are unchanged and mode bits do not promise owner-only access. Document symlink save rejection and the optimistic revision check's external-writer race limitation, as well as loopback port reconnection, CORS origin constraints, data-directory effects, and the mandatory server restart after saving.
- Replace statements that Payo never writes TOML; state that only the authenticated web Settings endpoint writes the selected user config file. Preserve warnings that `[tools]` values select trusted executables and that credentials/provider endpoints remain in Pi.
- Update `payo/apps/web/README.md` to document the Settings feature, session-only API port, testing layout, and the fact that the token remains memory-only.
- Keep edits to existing staged docs surgical; preserve unrelated content and do not reset user changes.

### Tests (write first)

- **Full automated regression:** run the full project checks after focused tests; no duplicate browser harness is needed because parser persistence, HTTP authorization/write behavior, and web interactions are covered at their cheapest existing levels.
- **Manual process walkthrough:** start dev-fakes using a temporary explicit `PAYO_CONFIG_FILE`; edit/save all config sections; inspect the resulting TOML; stop and restart the server; reconnect using the configured port; confirm settings and runs load. Repeat with an environment override to confirm the UI marks the overridden key and the TOML remains saved beneath it. Exercise a stale tab by editing the file externally before save and verify the UI reports conflict without clobbering the external change.

### Success criteria

- [x] **Automated:** `pnpm -C payo check`; `pnpm -C payo web:build`.
- [ ] **Manual:** Complete the process walkthrough above; verify no credentials or token are stored in the config file or browser storage; verify wrong-token and hostile-origin requests remain rejected; inspect the tactical page at narrow and desktop widths.

### What we're NOT doing

A live-reload mechanism, UI for environment variables, adding a config command to the CLI, hosted or multi-user settings, or broad changes to the existing Payo workflow.
