import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../modules/factory/src/", import.meta.url));
const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
	(file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);

function imports(source: string): string[] {
	return [
		...source.matchAll(
			/\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
		),
	].flatMap((match) => match[1] ?? match[2] ?? []);
}

it("keeps factory domain policy independent of application and infrastructure", () => {
	const domain = files.filter((file) => file.startsWith("domain/"));
	expect(domain.length).toBeGreaterThan(0);
	for (const file of domain) {
		const source = readFileSync(resolve(root, file), "utf8");
		for (const specifier of imports(source)) {
			const target = specifier.startsWith(".")
				? relative(root, resolve(root, dirname(file), specifier))
				: specifier;
			expect(
				target.startsWith("domain/") ||
					target === "@payo/contracts" ||
					target === "@payo/kernel",
				`${file} -> ${specifier}`,
			).toBe(true);
		}
		// Kernel is allowed only for domain state types, never its I/O helpers.
		for (const statement of source.matchAll(
			/\bimport\s+([^;]*?)\s+from\s+["']@payo\/kernel["']/g,
		))
			expect(statement[1]?.trim().startsWith("type "), file).toBe(true);
		expect(source, file).not.toMatch(
			/\bprocess\.|\bfetch\s*\(|\bWebSocket\s*\(|\bXMLHttpRequest\s*\(|\bDate\.now\(|\bnew Date\(/,
		);
	}
});

it("keeps publication orchestration behind injected ports", () => {
	for (const file of files.filter((file) =>
		file.startsWith("application/publication/"),
	)) {
		const source = readFileSync(resolve(root, file), "utf8");
		for (const specifier of imports(source))
			expect(specifier, `${file} -> ${specifier}`).not.toMatch(
				/^(?:node:|@payo\/(?:git|gh|runner-|checks-process|store-sqlite|jira-acli))|(?:^|\/)adapters\//,
			);
		expect(source, file).not.toMatch(
			/\bprocess\.|\bfetch\s*\(|\b(?:execFile|spawn|exec)\s*\(/,
		);
	}
});

it("keeps the factory implementation import graph acyclic", () => {
	const graph = new Map(
		files.map((file) => [
			file,
			imports(readFileSync(resolve(root, file), "utf8"))
				.filter((specifier) => specifier.startsWith("."))
				.map((specifier) =>
					relative(root, resolve(root, dirname(file), specifier)),
				),
		]),
	);
	const visited = new Set<string>();
	function visit(file: string, path: string[]): void {
		expect(path.includes(file), [...path, file].join(" -> ")).toBe(false);
		if (visited.has(file)) return;
		visited.add(file);
		for (const dependency of graph.get(file) ?? [])
			visit(dependency, [...path, file]);
	}
	for (const file of files) visit(file, []);
});

it("keeps factory code in owned layers with inward dependencies", () => {
	for (const file of files) {
		if (file === "index.ts") continue;
		const layer = file.split("/")[0];
		expect(["domain", "application", "infrastructure"], file).toContain(layer);
		if (layer === "infrastructure") continue;
		const source = readFileSync(resolve(root, file), "utf8");
		for (const specifier of imports(source).filter((value) =>
			value.startsWith("."),
		)) {
			const target = relative(root, resolve(root, dirname(file), specifier));
			expect(
				target.startsWith("domain/") ||
					(layer === "application" && target.startsWith("application/")),
				`${file} -> ${specifier}`,
			).toBe(true);
		}
		expect(source, file).not.toMatch(/NodeJS\.ErrnoException|["']ENOENT["']/);
	}
});

it("keeps domain tests beside domain behavior rather than application storage", () => {
	for (const file of readdirSync(resolve(root, "domain"), {
		recursive: true,
		encoding: "utf8",
	}).filter((file) => file.endsWith(".test.ts"))) {
		for (const specifier of imports(
			readFileSync(resolve(root, "domain", file), "utf8"),
		)) {
			if (!specifier.startsWith(".")) continue;
			const target = relative(
				root,
				resolve(root, "domain", dirname(file), specifier),
			);
			expect(target.startsWith("domain/"), `${file} -> ${specifier}`).toBe(
				true,
			);
		}
	}
});
