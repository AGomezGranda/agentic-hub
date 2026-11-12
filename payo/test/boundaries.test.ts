// Package imports are enforced here; kernel-boundaries.test.ts also checks computed loading and the full graph.
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const payoRoot = fileURLToPath(new URL("..", import.meta.url));
const biomeBin = join(payoRoot, "node_modules/.bin/biome");

const RELATIVE_ESCAPE =
	"Import another Payo package by its @payo name, not a relative path.";
const KERNEL = "kernel imports only @payo/contracts.";
const MODULES = "Modules import only @payo/kernel and @payo/contracts.";
const ADAPTERS =
	"Adapters import only @payo/kernel and @payo/contracts; only apps/server wires adapters.";
const CLI =
	"cli imports only @payo/contracts and @payo/config for local bootstrap settings.";
const CONFIG = "config imports only @payo/contracts.";
const WEB = "web imports only @payo/contracts.";
const CONTRACTS = "contracts imports no other @payo package.";

type BoundaryCase = readonly [
	file: string,
	source: string,
	expected: string | undefined,
];

// file, source, expected message (undefined = allowed)
const cases: BoundaryCase[] = [
	["packages/kernel/src/a.ts", `import "@payo/git";`, KERNEL],
	["packages/kernel/src/a.ts", `import "@payo/factory";`, KERNEL],
	["packages/kernel/src/a.ts", `import "@payo/runner-fake";`, KERNEL],
	["packages/kernel/src/a.ts", `import "@payo/gh";`, KERNEL],
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
	["modules/factory/src/a.ts", `import "@payo/checks-process";`, MODULES],
	["modules/factory/src/a.ts", `import "@payo/runner-fake";`, MODULES],
	["modules/factory/src/a.ts", `import "@payo/kernel";`, undefined],
	["modules/factory/src/a.ts", `import "@payo/kernel/testing";`, MODULES],
	["adapters/runner-pi/src/a.ts", `import "@payo/git";`, ADAPTERS],
	["adapters/gh/src/a.ts", `import "@payo/factory";`, ADAPTERS],
	["adapters/gh/src/a.ts", `import "@payo/kernel";`, undefined],
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
	["apps/cli/src/a.ts", `import "@payo/gh";`, CLI],
	["apps/cli/src/a.ts", `import "@payo/server";`, CLI],
	["apps/cli/src/a.ts", `import "@payo/contracts";`, undefined],
	["apps/cli/src/a.ts", `import "@payo/config";`, undefined],
	["apps/cli/src/a.ts", `import "@payo/kernel/testing";`, CLI],
	["packages/config/src/a.ts", `import "@payo/contracts";`, undefined],
	["packages/config/src/a.ts", `import "@payo/kernel";`, CONFIG],
	["packages/config/src/a.ts", `import "zod";`, undefined],
	["apps/web/src/a.ts", `import "@payo/contracts";`, undefined],
	["apps/web/src/a.ts", `import "@payo/config";`, WEB],
	["apps/web/src/a.ts", `import "@payo/factory";`, WEB],
	["apps/web/src/a.ts", `import "@payo/gh";`, WEB],
	["apps/web/src/a.ts", `import "../../server/src/main.ts";`, RELATIVE_ESCAPE],
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
		`import "../../checks-process/src/index.ts";`,
		RELATIVE_ESCAPE,
	],
	[
		"adapters/runner-pi/src/a.ts",
		`import "../../git/src/index.ts";`,
		RELATIVE_ESCAPE,
	],
	["apps/cli/src/a.ts", `import "../../server/src/main.ts";`, RELATIVE_ESCAPE],
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
];

// A unique path per case keeps the directory-based Biome overrides intact.
const fixturePath = (index: number, file: string): string =>
	file.replace("/src/", `/src/case-${index}/`);

// Lints every fixture against a copy of the real biome.json in one Biome process.
function lintFixtures(cases: readonly BoundaryCase[]): Map<string, string[]> {
	const dir = mkdtempSync(join(tmpdir(), "payo-boundaries-"));
	try {
		copyFileSync(join(payoRoot, "biome.json"), join(dir, "biome.json"));
		const byPath = new Map<string, string[]>();
		cases.forEach(([file, source], index) => {
			const path = fixturePath(index, file);
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), source);
			byPath.set(path, []);
		});
		const result = spawnSync(biomeBin, ["lint", "--reporter=json", "."], {
			cwd: dir,
			encoding: "utf8",
		});
		// The json reporter prints an experimental-warning line before the document.
		const report = JSON.parse(
			result.stdout.slice(result.stdout.indexOf("{")),
		) as {
			diagnostics: Array<{
				category: string;
				message: { text?: string } | string;
				location: { path: string };
			}>;
		};
		for (const diagnostic of report.diagnostics) {
			if (diagnostic.category !== "lint/style/noRestrictedImports") continue;
			byPath
				.get(diagnostic.location.path)
				?.push(
					typeof diagnostic.message === "string"
						? diagnostic.message
						: (diagnostic.message.text ?? ""),
				);
		}
		return byPath;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("package dependency rules (Biome noRestrictedImports)", () => {
	let report: Map<string, string[]>;

	beforeAll(() => {
		report = lintFixtures(cases);
	});

	it.each(
		cases.map(([file, , expected], index) => ({ file, expected, index })),
	)("case $index: $file", ({ file, index, expected }) => {
		const messages = report.get(fixturePath(index, file)) ?? [];
		if (expected === undefined) {
			expect(messages).toEqual([]);
		} else {
			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain(expected);
		}
	});
});

it("keeps factory filesystem access in infrastructure", () => {
	const root = join(payoRoot, "modules/factory/src");
	for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
		if (
			!file.endsWith(".ts") ||
			file.endsWith(".test.ts") ||
			file.startsWith("infrastructure/")
		)
			continue;
		expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(
			/["'](?:node:)?fs(?:\/promises)?["']/,
		);
	}
});
