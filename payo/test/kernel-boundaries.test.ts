import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const kernel = "packages/kernel/src/";
const files = ["packages", "modules", "adapters", "apps"].flatMap((group) =>
	readdirSync(resolve(root, group), { recursive: true, encoding: "utf8" })
		.filter(
			(file) =>
				/\/src\/.*\.tsx?$/.test(`/${file}`) &&
				!/\.test\.tsx?$/.test(file) &&
				!file.includes("node_modules/") &&
				!file.includes("/dist/"),
		)
		.map((file) => `${group}/${file}`),
);
const sources = new Map(
	files.map((file) => [file, readFileSync(resolve(root, file), "utf8")]),
);

// shortcut: literal imports are scanned syntactically; add symbol resolution if alias-based loading is introduced.
function imports(source: string): string[] {
	return [
		...source.matchAll(
			/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
		),
	].flatMap((match) => match[1] ?? match[2] ?? []);
}

it("keeps kernel code in owned layers with inward dependencies", () => {
	for (const [file, source] of sources) {
		if (
			!file.startsWith(kernel) ||
			file === `${kernel}index.ts` ||
			file === `${kernel}testing.ts`
		)
			continue;
		const layer = file.slice(kernel.length).split("/")[0];
		expect(["domain", "application", "adapters"], file).toContain(layer);
		if (layer === "adapters") continue;
		for (const specifier of imports(source)) {
			if (!specifier.startsWith(".")) {
				// Hashing and deep equality are deterministic standard-library functions.
				expect(
					["@payo/contracts", "node:crypto", "node:util"],
					`${file} -> ${specifier}`,
				).toContain(specifier);
				continue;
			}
			const target = relative(
				resolve(root, kernel),
				resolve(root, dirname(file), specifier),
			);
			expect(
				target.startsWith("domain/") ||
					(layer === "application" && target.startsWith("application/")),
				`${file} -> ${specifier}`,
			).toBe(true);
		}
	}
});

// Biome's GritQL search matches syntax nodes, so comments and strings are excluded.
const effects =
	"or { `setTimeout($args)`, `setInterval($args)`, `setImmediate($args)`, `AbortSignal.timeout($args)`, `Date.now()`, `performance.now()`, `Date($args)`, `new Date($args)`, `Math.random()`, `randomUUID($args)`, `randomBytes($args)`, `randomInt($args)`, `crypto.randomUUID($args)`, `crypto.getRandomValues($args)`, `process.$member`, `fetch($args)`, `new WebSocket($args)`, `new XMLHttpRequest($args)` }";
function effectMatches(paths: string[]) {
	const result = spawnSync(
		resolve(root, "node_modules/.bin/biome"),
		["search", effects, ...paths, "--reporter=json", "--max-diagnostics=none"],
		{ cwd: root, encoding: "utf8" },
	);
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return (
		JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
			summary: { matches: number };
		}
	).summary.matches;
}
it("keeps kernel and factory core effects behind injected ports", () => {
	const core = files.filter(
		(file) =>
			file.startsWith(`${kernel}domain/`) ||
			file.startsWith(`${kernel}application/`) ||
			(file.startsWith("modules/factory/src/") &&
				!file.includes("/infrastructure/")),
	);
	expect(effectMatches(core)).toBe(0);
	for (const file of core)
		for (const specifier of imports(sources.get(file) ?? ""))
			expect(specifier, file).not.toMatch(
				/^(?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads|timers)(?:\/|$)/,
			);
	// Ensure the query still recognizes the concrete scheduling adapter.
	expect(effectMatches([`${kernel}adapters/scheduler.ts`])).toBe(2);
	expect(effectMatches([`${kernel}adapters/memory-store.ts`])).toBe(1);
});

it("rejects computed loading and keeps concrete server construction at the edge", () => {
	const wiring = new Set([
		"composition.ts",
		"adapters.ts",
		"main.ts",
		"doctor.ts",
		"factory-fixtures.ts",
	]);
	for (const [file, source] of sources) {
		for (const call of source.matchAll(
			/\b(?:import|require|import\.meta\.resolve)\s*\(\s*([^)]*)\)/g,
		))
			expect(call[1]?.trim(), file).toMatch(/^["'][^"']+["']\s*$/);
		if (
			!file.startsWith("apps/server/src/") ||
			wiring.has(file.slice("apps/server/src/".length))
		)
			continue;
		// Type-only integration types and pure Git read helpers may live outside wiring.
		for (const statement of source.matchAll(
			/\bimport\s+([^;]*?)\s+from\s+["']@payo\/(?:git|gh|runner-[^"']+|checks-process|store-sqlite|jira-acli)["']/g,
		))
			expect(statement[1], file).not.toMatch(/\bcreate[A-Z]/);
	}
});

it("keeps the whole Payo literal import graph acyclic", () => {
	const packages = new Map<string, string>();
	for (const group of ["packages", "modules", "adapters", "apps"])
		for (const folder of readdirSync(resolve(root, group))) {
			const manifestPath = resolve(root, group, folder, "package.json");
			// Every immediate package directory is required to declare its public exports.
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				name: string;
				exports?: Record<string, string>;
			};
			for (const [entry, target] of Object.entries(manifest.exports ?? {}))
				packages.set(
					manifest.name + (entry === "." ? "" : entry.slice(1)),
					relative(root, resolve(dirname(manifestPath), target)),
				);
		}
	const graph = new Map(
		[...sources].map(([file, source]) => [
			file,
			imports(source).flatMap((specifier) => {
				const target = specifier.startsWith(".")
					? relative(root, resolve(root, dirname(file), specifier))
					: specifier.startsWith("@web/")
						? `apps/web/src/${specifier.slice(5)}`
						: packages.get(specifier);
				if (!target || /\.(?:css|woff2?|svg|png)$/.test(target)) return [];
				const resolved = [
					target,
					`${target}.ts`,
					`${target}.tsx`,
					`${target}/index.ts`,
				].find((candidate) => sources.has(candidate));
				expect(resolved, `${file} -> ${specifier}`).toBeDefined();
				return resolved ? [resolved] : [];
			}),
		]),
	);
	const visited = new Set<string>();
	const visiting = new Set<string>();
	function visit(file: string, path: string[]): void {
		expect(visiting.has(file), [...path, file].join(" -> ")).toBe(false);
		if (visited.has(file)) return;
		visiting.add(file);
		for (const dependency of graph.get(file) ?? [])
			visit(dependency, [...path, file]);
		visiting.delete(file);
		visited.add(file);
	}
	for (const file of files) visit(file, []);
});
