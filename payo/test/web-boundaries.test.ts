import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../apps/web/src/", import.meta.url));

// A feature may depend only on shared code and these explicitly lower-level features.
const featureDependencies: Record<string, readonly string[]> = {
	connection: [],
	runs: [],
	settings: [],
	"plan-review": ["runs"],
	"run-workspace": ["runs", "plan-review"],
};

function boundaryError(
	importer: string,
	specifier: string,
): string | undefined {
	if (!specifier.startsWith(".") && !specifier.startsWith("@web/")) return;
	const target = specifier.startsWith("@web/")
		? resolve(sourceRoot, specifier.slice("@web/".length))
		: resolve(sourceRoot, dirname(importer), specifier);
	const destination = relative(sourceRoot, target).split(sep);
	if (destination[0] === "..") return "Imports must stay inside web/src.";
	const [layer, feature] = importer.split("/");
	const [targetLayer, targetFeature] = destination;
	if (layer === "shared" && targetLayer !== "shared")
		return "Shared code cannot import app or feature code.";
	if (layer === "features") {
		if (targetLayer === "shared") return;
		if (
			targetLayer === "features" &&
			feature &&
			targetFeature &&
			(feature === targetFeature ||
				featureDependencies[feature]?.includes(targetFeature))
		)
			return;
		return "Features may import only shared code or declared lower-level features.";
	}
}

function literalImports(source: string): string[] {
	const imports = source.matchAll(
		/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
	);
	return [...imports].flatMap((match) => match[1] ?? match[2] ?? []);
}

it.each([
	'import "@web/app/App.tsx";',
	'import type { Thing } from "@web/app/App.tsx";',
	'import {\n Thing,\n Other\n} from "@web/app/App.tsx";',
	'export { Thing } from "@web/app/App.tsx";',
	'export type { Thing } from "@web/app/App.tsx";',
	'export * from "@web/app/App.tsx";',
	'const app = import("@web/app/App.tsx");',
])("finds literal dependency: %s", (source) => {
	expect(literalImports(source)).toEqual(["@web/app/App.tsx"]);
});

it.each([
	["shared/ui/Button.tsx", "@web/features/runs/api.ts", false],
	["shared/api/client.ts", "../../app/App.tsx", false],
	["features/runs/api.ts", "@web/app/App.tsx", false],
	["features/runs/api.ts", "../plan-review/api.ts", false],
	["features/plan-review/api.ts", "../run-workspace/api.ts", false],
	[
		"features/run-workspace/RunWorkspace.tsx",
		"@web/features/plan-review/PlanReview.tsx",
		true,
	],
	["features/plan-review/PlanReview.tsx", "@web/features/runs/api.ts", true],
	["features/runs/api.ts", "@web/shared/api/client.ts", true],
	["features/runs/RunList.tsx", "./api.ts", true],
	["app/App.tsx", "@web/features/runs/RunList.tsx", true],
	["features/runs/api.ts", "../../../../server/src/main.ts", false],
] as const)("checks %s -> %s", (importer, specifier, allowed) => {
	expect(boundaryError(importer, specifier) === undefined).toBe(allowed);
});

it("keeps the web dependency graph directed from app to features to shared", () => {
	const violations: string[] = [];
	for (const entry of readdirSync(sourceRoot, {
		recursive: true,
		encoding: "utf8",
	})) {
		if (!/\.(ts|tsx)$/.test(entry)) continue;
		const importer = entry.split(sep).join("/");
		const [layer, feature] = importer.split("/");
		if (
			importer !== "main.tsx" &&
			(!["app", "features", "shared", "test"].includes(layer ?? "") ||
				(layer === "features" &&
					!Object.hasOwn(featureDependencies, feature ?? "")))
		)
			violations.push(
				`${importer}: place source in an owned app, feature, shared or test folder.`,
			);
		const source = readFileSync(resolve(sourceRoot, entry), "utf8");
		for (const specifier of literalImports(source)) {
			const error = boundaryError(importer, specifier);
			if (error) violations.push(`${importer} -> ${specifier}: ${error}`);
		}
	}
	expect(violations).toEqual([]);
});
