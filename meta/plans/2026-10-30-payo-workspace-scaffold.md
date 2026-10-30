---
date: 2026-10-30
title: Payo step 1 — workspace scaffold with enforced dependency rules
status: draft
---

Roadmap step 1 of [docs/payo/implementation-roadmap.md](../../docs/payo/implementation-roadmap.md).
Goal: an empty `payo/` pnpm workspace whose `pnpm check` (Biome, `tsc --noEmit`,
Vitest) fails on a layering violation from day one.

## Current State

- Layout and dependency rules: `docs/payo/engine-design.md:18-44`. Tooling decision
  (pnpm, Biome, TS strict `tsc --noEmit`, Vitest, Zod, Node 24 type stripping):
  `docs/payo/engine-design.md:11-12`.
- No JS workspace exists. The only Node code is `tools/swarm-viewer` (no deps,
  `node --test`, `tools/swarm-viewer/package.json`) and `pi/workflows/*.js`.
- CI: `.github/workflows/ci.yml` has a `ci` (Python) job and a `swarm-viewer` job
  (Node 22/24 matrix, `persist-credentials: false`, `permissions: contents: read`).
- Root `.gitignore` covers Python only; `node_modules` is not ignored.
- README: Development section lists only `uv` commands (`README.md:181-188`); Tools
  (`README.md:208-210`) and Docs (`README.md:212-218`) mark payo as "not implemented".
- Local toolchain: Node 24.19.0, pnpm 10.9.0. Current npm versions: Biome 2.6.4,
  TypeScript 7.0.2, Vitest 5.0.5, Zod 4.6.7.

Spike results (throwaway dir, Biome 2.6.4 and TypeScript 7.0.2):

- `noRestrictedImports` `patterns` with negation (`["@payo/*", "!@payo/contracts"]`)
  inside a per-directory `overrides[].includes` blocks `@payo/git` and allows
  `@payo/contracts` in `packages/kernel/**`.
- Pattern `**/adapters/**` matches the relative specifier
  `../../../adapters/git/src/index.ts`; `./x.ts` and `../src/y.ts` pass.
- Caught forms: static `import`, `import type`, `export * from`, dynamic
  `import()`. Not caught: `import.meta.resolve("@payo/git")` and non-literal specifiers
  such as `import(x)`.
- `biome lint --stdin-file-path` cannot be used for tests: it exits 1 with
  "contents aren't fixed" for clean input too. Linting a real file in a temp dir
  holding a copy of `biome.json` works, and `--reporter=json` returns the
  diagnostic `category` and `message`.
- `tsc` 7.0.2 accepts `module: nodenext`, `noEmit`, `allowImportingTsExtensions`,
  `erasableSyntaxOnly` (rejects `enum` with TS1294), `verbatimModuleSyntax`.

## Design Decisions

- **Biome is enough; no dependency checker.** Settles the roadmap question. Three
  layers cover the rules:
  1. Undeclared `@payo/*` import → `tsc` fails to resolve it (pnpm's isolated
     `node_modules` links only declared deps into each package).
  2. Declared but forbidden import → Biome `noRestrictedImports` per-layer
     allow-list.
  3. Relative path into another package → Biome pattern on `packages/`, `modules/`,
     `adapters/`, `apps/` segments.
- **No build step.** Every package exports `./src/index.ts`. Node 24 strips types at
  runtime (symlinked workspace packages resolve to their real path, outside
  `node_modules`, so stripping is allowed); `tsc` only type-checks.
- **One root `tsconfig.json`** covering the whole workspace, not per-package configs.
  A per-package config is added when a package needs different settings (e.g.
  `apps/web` DOM libs in step 10).
- **Packages created now: all of slice 1, nothing later.** `contracts`, `kernel`,
  `factory`, `runner-fake`, `runner-pi`, `jira-acli`, `git`, `store-sqlite`,
  `server`, `cli`. `gh` (step 9) and `web` (step 10) are not created.
- **Layer rules** (design rules plus three agreed additions, marked *):

  | From | May import `@payo/*` |
  |---|---|
  | `packages/contracts` | nothing * |
  | `packages/kernel` | `contracts` |
  | `modules/*` | `kernel`, `contracts` |
  | `adapters/*` | `kernel`, `contracts` (no adapter → adapter *) |
  | `apps/cli` | `contracts` * (thin HTTP client) |
  | `apps/server` | anything |

  Every layer, including `apps/server`, is also barred from relative imports into
  another package.
- **Biome overrides carry the full pattern list each.** A file matches exactly one
  layer override, so no reliance on how Biome merges rule options across overrides.
- **Zod is declared in `contracts` now** (the only package that will use it), with no
  code yet, so step 2 does not touch tooling.
- **Pins:** exact versions for `@biomejs/biome` (formatter output must not drift),
  caret for the rest; `@types/node@^24` to match the runtime, not 26;
  `packageManager: pnpm@10.9.0`.

## Risks & Mitigations

- `import.meta.resolve` bypasses Biome → it does not load code. `tsc` rejects an
  undeclared package imported by name. It exits 0 on the `import.meta.resolve` form (see
  Deviations). Recorded as a known limit, along with non-literal specifiers such as
  `import(x)`, in the header of `payo/test/boundaries.test.ts`; not mitigated further.
- Pattern `**/adapters/**` (etc.) would also match a third-party specifier like
  `lib/adapters/x` → no such import exists; the message tells the reader why, and
  the pattern can be narrowed to `../**/adapters/**` if one appears.
- TypeScript 7 is a new major (native compiler) → spike showed the needed options
  work; if a later step hits a TS 7 gap, pin `typescript@~5.9` (one-line change).
- pnpm 10 blocks dependency build scripts by default → Biome ships platform binaries
  via optional deps, no postinstall; if `pnpm install` warns about an ignored
  build, add it to `onlyBuiltDependencies` in `pnpm-workspace.yaml`.
- A file directly in a package root (not under `src/`) importing a sibling with
  `../<pkg>/…` matches no pattern, because `../../*/**` needs two levels. Covering it
  with `../*/**` would also block the same-package `../src/y.ts` that must pass. Accepted
  as a known limit; revisit if such a file appears.
- A same-package `./adapters/x.ts` may match `**/adapters/**`, depending on how Biome
  normalises `./`. Not run; if a real package needs a folder with one of these names,
  check this first.

## Phase 1: Workspace and tooling

### Overview

Create `payo/` with all slice-1 packages empty but wired, and a green `pnpm check`,
including a runtime smoke test that proves Node type stripping across workspace
links.

### Changes

- `payo/package.json`:
  ```json
  {
    "name": "payo",
    "private": true,
    "type": "module",
    "packageManager": "pnpm@10.9.0",
    "engines": { "node": ">=24" },
    "scripts": {
      "check": "biome check . && tsc && vitest run",
      "fix": "biome check --write ."
    },
    "devDependencies": {
      "@biomejs/biome": "2.6.4",
      "@types/node": "^24",
      "typescript": "^7.0.2",
      "vitest": "^5.0.5"
    }
  }
  ```
- `payo/pnpm-workspace.yaml`: `packages: [packages/*, modules/*, adapters/*, apps/*]`.
- `payo/pnpm-lock.yaml`: generated by `pnpm install`, committed.
- `payo/.gitignore`: `node_modules/`.
- `payo/tsconfig.json`:
  ```json
  {
    "compilerOptions": {
      "target": "esnext",
      "module": "nodenext",
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "noEmit": true,
      "allowImportingTsExtensions": true,
      "erasableSyntaxOnly": true,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true,
      "types": ["node"]
    },
    "include": ["**/*.ts"]
  }
  ```
- `payo/biome.json`: `$schema` pointing at
  `./node_modules/@biomejs/biome/configuration_schema.json`, linter
  `recommended`, formatter defaults. Restricted-import overrides land in phase 2.
- One package per directory below, each with `package.json` and `src/index.ts`
  containing `export {};`:
  - `packages/contracts` — deps: `zod@^4.6.7`
  - `packages/kernel` — deps: `@payo/contracts`
  - `modules/factory` — deps: `@payo/kernel`, `@payo/contracts`
  - `adapters/runner-fake`, `adapters/runner-pi`, `adapters/jira-acli`,
    `adapters/git`, `adapters/store-sqlite` — deps: `@payo/kernel`,
    `@payo/contracts`
  - `apps/cli` — deps: `@payo/contracts`
  - `apps/server` — deps: every package above. Instead of `src/index.ts` it has
    `src/main.ts`: side-effect imports of `@payo/kernel` and `@payo/contracts`,
    then `console.log("payo server: not implemented")`.

  Package manifest shape (workspace deps as `workspace:*`):
  ```json
  {
    "name": "@payo/kernel",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "exports": { ".": "./src/index.ts" },
    "dependencies": { "@payo/contracts": "workspace:*" }
  }
  ```

### Tests

- `apps/server/src/main.test.ts` (integration, the only one in this step): spawn
  `process.execPath` on `apps/server/src/main.ts` with `node:child_process`
  `spawnSync`; assert exit 0 and stdout `payo server: not implemented`. Pins down
  that plain Node (not Vitest's resolver) loads `.ts` workspace packages through
  pnpm symlinks. Written first; fails until the packages and links exist.

### Success criteria

**Automated**
- [x] `cd payo && pnpm install --frozen-lockfile && pnpm check` exits 0.

**Manual**
- [x] Add `enum E { A }` to `packages/kernel/src/index.ts` → `pnpm check` fails in
  `tsc` (TS1294). Revert.
- [x] `git status` shows no `node_modules` files.

### What we're NOT doing

- No real code, schemas or ports (step 2+).
- No `gh` or `web` packages, no per-package tsconfigs, no build or bundling.
- No `bin` entry for `payo` (step 5).

## Phase 2: Dependency rules

### Overview

Add per-layer restricted-import overrides to `biome.json` and pin every rule with a
test that lints a fixture file against a copy of the real config.

### Changes

- `payo/biome.json`: add `overrides`, one entry per layer, each setting
  `linter.rules.style.noRestrictedImports` to `level: "error"` with `options.patterns`
  = `[<layer allow-list>, <relative-escape rule>]`:
  - Relative-escape rule (in every entry):
    `{ "group": ["**/packages/**", "**/modules/**", "**/adapters/**", "**/apps/**",
       "../../*/**"],
       "message": "Import another Payo package by its @payo name, not a relative path." }`
    The `"../../*/**"` glob blocks a relative import into a sibling package, which the
    directory-name globs cannot see.
  - Allow-lists:

    | `includes` | `group` | `message` |
    |---|---|---|
    | `packages/contracts/**` | `["@payo/*"]` | `contracts imports no other @payo package.` |
    | `packages/kernel/**` | `["@payo/*", "!@payo/contracts"]` | `kernel imports only @payo/contracts.` |
    | `modules/**` | `["@payo/*", "!@payo/kernel", "!@payo/contracts"]` | `Modules import only @payo/kernel and @payo/contracts.` |
    | `adapters/**` | `["@payo/*", "!@payo/kernel", "!@payo/contracts"]` | `Adapters import only @payo/kernel and @payo/contracts; only apps/server wires adapters.` |
    | `apps/cli/**` | `["@payo/*", "!@payo/contracts"]` | `cli is a thin HTTP client: it imports only @payo/contracts.` |
    | `apps/server/**` | relative-escape rule only | — |

- `payo/test/boundaries.test.ts`: the tests below, plus a header comment stating the
  known limit: `import.meta.resolve` and non-literal specifiers such as `import(x)` are
  not caught by Biome, which checks only literal dynamic `import("@payo/…")`. `tsc`
  rejects an undeclared package imported by name. It exits 0 on the
  `import.meta.resolve` form (see Deviations).

### Tests

Integration (spawns Biome), in `payo/test/boundaries.test.ts`, written before the
overrides (all "blocked" cases fail first). Helper `lint(file: string, source: string)`:
`mkdtemp`, copy `payo/biome.json` in, write `source` at `file`, `spawnSync` the Biome
binary from `payo/node_modules/.bin/biome` with `["lint", "--reporter=json", file]` and
`cwd` = temp dir, parse stdout, return the `noRestrictedImports` diagnostic messages,
remove the temp dir. Cases as one `it.each` table (`file`, `source`, expected
`blocked | allowed`):

| File | Source | Expect | Pins down |
|---|---|---|---|
| `packages/kernel/src/a.ts` | `import "@payo/git";` | blocked | kernel → adapter |
| `packages/kernel/src/a.ts` | `import "@payo/factory";` | blocked | kernel → module |
| `packages/kernel/src/a.ts` | `import type { X } from "@payo/git"; export type Y = X;` | blocked | type-only imports count |
| `packages/kernel/src/a.ts` | `export * from "@payo/git";` | blocked | re-exports count |
| `packages/kernel/src/a.ts` | `export const m = await import("@payo/git");` | blocked | dynamic import counts |
| `packages/kernel/src/a.ts` | `import "@payo/contracts";` | allowed | kernel → contracts |
| `packages/kernel/src/a.ts` | `import "../../../adapters/git/src/index.ts";` | blocked | relative escape |
| `packages/kernel/src/a/b/c.ts` | `import "../../x.ts";` | allowed | deep relative import inside a package |
| `packages/contracts/src/a.ts` | `import "@payo/kernel";` | blocked | contracts is a leaf |
| `packages/contracts/src/a.ts` | `import "zod";` | allowed | third-party untouched |
| `modules/factory/src/a.ts` | `import "@payo/pr-review";` | blocked | module → module |
| `modules/factory/src/a.ts` | `import "@payo/runner-fake";` | blocked | module → adapter |
| `modules/factory/src/a.ts` | `import "@payo/kernel";` | allowed | module → kernel |
| `adapters/runner-pi/src/a.ts` | `import "@payo/git";` | blocked | adapter → adapter |
| `adapters/runner-pi/src/a.ts` | `import "@payo/factory";` | blocked | adapter → module |
| `adapters/runner-pi/src/a.ts` | `import "@payo/kernel";` | allowed | adapter → kernel |
| `apps/cli/src/a.ts` | `import "@payo/kernel";` | blocked | cli stays thin |
| `apps/cli/src/a.ts` | `import "@payo/contracts";` | allowed | cli → contracts |
| `apps/server/src/a.ts` | `import "@payo/git"; import "@payo/factory";` | allowed | composition root |
| `apps/server/src/a.ts` | `import "../../../adapters/git/src/index.ts";` | blocked | relative escape applies to server too |

Each "blocked" case also asserts the layer's `message`, so a case blocked by the
wrong rule fails.

### Success criteria

**Automated**
- [x] `cd payo && pnpm check` exits 0 with all boundary cases green.

**Manual**
- [x] Add `import "@payo/git";` to `packages/kernel/src/index.ts` → `pnpm check` fails
  in Biome with `kernel imports only @payo/contracts.` Revert.
- [x] Add `import "@payo/git";` to `modules/factory/src/index.ts` without declaring it →
  fails in both Biome and `tsc` (cannot find module). Revert.

### What we're NOT doing

- No dependency-cruiser or custom import scanner.
- No rule against `import.meta.resolve` or non-literal specifiers (known limit,
  documented).
- No restricted-import rules for `apps/web` yet: `adapters/gh` falls under the
  `adapters/**` override when it exists; `apps/web` gets its own override in step 10
  (`apps/**` is not an include).
- Adding a `packages/*` directory means adding its override in the same PR. The test does
  not enumerate directories, so a new package with no override is not caught
  automatically.

## Phase 3: CI and docs

### Overview

Run `pnpm check` in CI on Node 24 and document it.

### Changes

- `.github/workflows/ci.yml`: new job beside `swarm-viewer`:
  ```yaml
  payo:
    name: payo check
    runs-on: ubuntu-latest
    permissions:
      contents: read
    defaults:
      run:
        working-directory: payo
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: payo/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: payo/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
  ```
- `README.md`:
  - Development: add a Payo block after the `uv` block:
    ```
    cd payo
    pnpm install
    pnpm check    # Biome, tsc --noEmit, Vitest; also enforces package dependency rules
    ```
    and change "CI runs these same checks." to cover both.
  - The Development file list (`README.md:200-206`): add `payo/`: TypeScript workspace for the Payo engine (scaffold
    only; see `docs/payo/engine-design.md`).
  - Docs: change the `docs/payo/` line from "(not implemented)" to "(workspace
    scaffold in `payo/`; engine not implemented)".

### Tests

None: CI config and docs. Verified by the CI run itself.

### Success criteria

**Automated**
- The `payo` job passes on the PR; the `ci` and `swarm-viewer` jobs still pass.
- `uv run ruff check .` and `uv run pytest -q` still pass locally (nothing in
  `payo/` is Python).

**Manual**
- Push a throwaway commit on the PR branch with `import "@payo/git";` in
  `packages/kernel/src/index.ts` → the `payo` job fails. Drop the commit.

### What we're NOT doing

- No Node 22 matrix (`node:sqlite` and type stripping need 24).
- No release, publish or Dependabot config.

## Deviations (implementation log)

- Phase 1: Biome's default formatter uses tabs; the JSON samples above use spaces. Kept
  the formatter defaults and ran `biome check --write`, so committed files use tabs.
- Phase 1: `biome.json` has no `linter.rules.recommended`. Biome 2.6.4 deprecates that
  field and enables recommended rules by default.
- Phase 1: package names are `@payo/server` (`apps/server`) and `@payo/cli` (`apps/cli`);
  `apps/server` depends on every package, including `@payo/cli`.
- Phase 3: the `payo` CI job, README and docs are done locally. The PR run and the
  throwaway-commit check are not run yet (no push without an explicit ask).
- Phase 2: the relative-escape group also contains `"../../*/**"`, so a relative import into
  a sibling package (for example `../../kernel/src/index.ts` from `packages/contracts`) is
  blocked. This was a review blocker: the directory-name group alone cannot see sibling
  directories. Trade-off: the glob also blocks a same-package import two levels up into a
  subdirectory (for example `src/a/b/c.ts` → `../../d/e.ts`). No current code does this, and
  the message would then read misleadingly. Revisit if step 2+ code needs it.
- Phase 2: the header of `payo/test/boundaries.test.ts` originally said tsc rejects an
  undeclared `import.meta.resolve("@payo/…")`. That was false: tsc exits 0 on it. The header
  now records it as a known limit that nothing catches.
- Open for the owner: `apps/server` depends on `@payo/cli` (plan line "every package
  above"). Kept as specified. The design doc does not mention it. Remove it, and regenerate
  the lockfile, if the edge is not wanted.
- Phase 2: the boundary test table has 29 rows, not 20: two named re-export rows, four
  relative-escape rows for the contracts/modules/adapters/cli layers, and three deeper
  3-up relative rows. All pass against the shipped config.
- Phase 2: the `import.meta.resolve` header now also covers non-literal specifiers, which
  Biome and tsc do not check.

## PR Strategy

One PR with all three phases: each is small, and the rules (phase 2) and CI
(phase 3) are the point of the step.
