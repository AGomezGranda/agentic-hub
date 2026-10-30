// Known limit: Biome and tsc do not check non-literal specifiers (`import(x)`, `import.meta.resolve(x)`),
// and tsc accepts `import.meta.resolve("@payo/…")` even when undeclared. Not mitigated here.
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const payoRoot = fileURLToPath(new URL("..", import.meta.url));
const biomeBin = join(payoRoot, "node_modules/.bin/biome");

const RELATIVE_ESCAPE =
	"Import another Payo package by its @payo name, not a relative path.";
const KERNEL = "kernel imports only @payo/contracts.";
const MODULES = "Modules import only @payo/kernel and @payo/contracts.";
const ADAPTERS =
	"Adapters import only @payo/kernel and @payo/contracts; only apps/server wires adapters.";
const CLI = "cli is a thin HTTP client: it imports only @payo/contracts.";
const CONTRACTS = "contracts imports no other @payo package.";

// Lints one fixture file against a copy of the real biome.json, in a temp dir.
function restrictedImportMessages(file: string, source: string): string[] {
	const dir = mkdtempSync(join(tmpdir(), "payo-boundaries-"));
	try {
		copyFileSync(join(payoRoot, "biome.json"), join(dir, "biome.json"));
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), source);
		const result = spawnSync(biomeBin, ["lint", "--reporter=json", file], {
			cwd: dir,
			encoding: "utf8",
		});
		// The json reporter prints an experimental-warning line before the document.
		const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
		return report.diagnostics
			.filter(
				(d: { category: string }) =>
					d.category === "lint/style/noRestrictedImports",
			)
			.map((d: { message: { text?: string } | string }) =>
				typeof d.message === "string" ? d.message : (d.message.text ?? ""),
			);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("package dependency rules (Biome noRestrictedImports)", () => {
	it.each([
		// file, source, expected message (undefined = allowed)
		["packages/kernel/src/a.ts", `import "@payo/git";`, KERNEL],
		["packages/kernel/src/a.ts", `import "@payo/factory";`, KERNEL],
		["packages/kernel/src/a.ts", `import "@payo/runner-fake";`, KERNEL],
		[
			"packages/kernel/src/a.ts",
			`import type { X } from "@payo/git"; export type Y = X;`,
			KERNEL,
		],
		["packages/kernel/src/a.ts", `export * from "@payo/git";`, KERNEL],
		["packages/kernel/src/a.ts", `export { X } from "@payo/git";`, KERNEL],
		["packages/kernel/src/a.ts", `export type { X } from "@payo/git";`, KERNEL],
		[
			"packages/kernel/src/a.ts",
			`export const m = await import("@payo/git");`,
			KERNEL,
		],
		["packages/kernel/src/a.ts", `import "@payo/contracts";`, undefined],
		[
			"packages/kernel/src/a.ts",
			`import "../../../adapters/git/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		["packages/kernel/src/a/b/c.ts", `import "../../x.ts";`, undefined],
		["packages/contracts/src/a.ts", `import "@payo/kernel";`, CONTRACTS],
		["packages/contracts/src/a.ts", `import "zod";`, undefined],
		["modules/factory/src/a.ts", `import "@payo/pr-review";`, MODULES],
		["modules/factory/src/a.ts", `import "@payo/runner-fake";`, MODULES],
		["modules/factory/src/a.ts", `import "@payo/kernel";`, undefined],
		["modules/factory/src/a.ts", `import "@payo/kernel/testing";`, MODULES],
		["adapters/runner-pi/src/a.ts", `import "@payo/git";`, ADAPTERS],
		["adapters/runner-pi/src/a.ts", `import "@payo/factory";`, ADAPTERS],
		["adapters/runner-pi/src/a.ts", `import "@payo/kernel";`, undefined],
		[
			"adapters/store-sqlite/src/a.test.ts",
			`import "@payo/kernel/testing";`,
			undefined,
		],
		["adapters/store-sqlite/src/a.test.ts", `import "@payo/git";`, ADAPTERS],
		[
			"adapters/store-sqlite/src/a.test.ts",
			`import "../../../apps/server/src/main.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"adapters/store-sqlite/src/a.ts",
			`import "@payo/kernel/testing";`,
			ADAPTERS,
		],
		["apps/cli/src/a.ts", `import "@payo/kernel";`, CLI],
		["apps/cli/src/a.ts", `import "@payo/contracts";`, undefined],
		["apps/cli/src/a.ts", `import "@payo/kernel/testing";`, CLI],
		[
			"apps/server/src/a.ts",
			`import "@payo/git"; import "@payo/factory";`,
			undefined,
		],
		[
			"apps/server/src/a.ts",
			`import "../../../adapters/git/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"packages/contracts/src/a.ts",
			`import "../../kernel/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"modules/factory/src/a.ts",
			`import "../../pr-review/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"adapters/runner-pi/src/a.ts",
			`import "../../git/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"apps/cli/src/a.ts",
			`import "../../server/src/main.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"apps/cli/src/a.ts",
			`import "../../../modules/factory/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"modules/factory/src/a.ts",
			`import "../../../adapters/git/src/index.ts";`,
			RELATIVE_ESCAPE,
		],
		[
			"adapters/runner-pi/src/a.ts",
			`import "../../../apps/server/src/main.ts";`,
			RELATIVE_ESCAPE,
		],
	])("%s: %s", (file, source, expected) => {
		const messages = restrictedImportMessages(file, source);
		if (expected === undefined) {
			expect(messages).toEqual([]);
		} else {
			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain(expected);
		}
	});
});
