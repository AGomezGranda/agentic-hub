import { createMemoryRunStore } from "@payo/kernel";
import { describe, expect, it } from "vitest";
import {
	architectureRubricPaths,
	codeQualityRubricPaths,
	lenses,
	planLensResourcePaths,
	roleSpec,
	snapshotRole,
} from "./roles.ts";

const rubricResources = Object.fromEntries([
	...planLensResourcePaths.map((path) => [path, `LENS ${path}`]),
	...architectureRubricPaths.map((path) => [path, `ARCH ${path}`]),
	...codeQualityRubricPaths.map((path) => [path, `QUALITY ${path}`]),
]);

const source = {
	path: "skills/create-plan/SKILL.md",
	sha: "abc123",
	content: "Original skill",
	resources: { ...rubricResources, "guide.md": "Original guide" },
	addendum: "SHARED DESIGN EXPECTATIONS",
};

async function spec(
	role: "planner" | "reviewer" | "verifier" | "reviser",
	lens?: keyof typeof lenses,
) {
	const store = createMemoryRunStore();
	const ref = await snapshotRole(store, source);
	return roleSpec(
		store,
		ref,
		role,
		"/workspace-without-skills",
		{ model: null, timeoutMs: 1000 },
		[],
		lens,
	);
}

describe("factory role snapshots", () => {
	it("uses immutable skill content and resources in read-only specs", async () => {
		const store = createMemoryRunStore();
		const legacy = {
			path: "skills/create-plan/SKILL.md",
			sha: "abc123",
			content: "Original skill",
			resources: { "guide.md": "Original guide" },
		};
		const ref = await snapshotRole(store, legacy);
		legacy.content = "Changed";
		legacy.resources["guide.md"] = "Changed";
		const spec = await roleSpec(
			store,
			ref,
			"planner",
			"/workspace-without-skills",
			{ model: null, timeoutMs: 1000 },
			[],
		);
		expect(spec.instructions).toContain("Original skill");
		expect(spec.instructions).toContain("Original guide");
		expect(spec.instructions).not.toContain("Changed");
		expect(spec).toMatchObject({
			tools: "read-only",
			roleSpecSha: "abc123",
			outputContract: "factory-plan-v1",
		});
		expect(spec.inputs).toContainEqual({ name: "role-source", ref });
	});
	it.each(["planner", "reviewer", "verifier", "reviser"] as const)(
		"renders the shared addendum for the %s role",
		async (role) => {
			const specResult = await spec(role);
			expect(specResult.instructions).toContain("SHARED DESIGN EXPECTATIONS");
			expect(specResult.roleSpecSha).not.toBe("abc123");
			expect(specResult.roleSpecSha).toMatch(/^[0-9a-f]{64}$/);
		},
	);
	it("includes only the rubrics relevant to each role and lens", async () => {
		const planner = await spec("planner");
		expect(planner.instructions).toContain("ARCH ");
		expect(planner.instructions).toContain("QUALITY ");
		expect(planner.instructions).not.toContain("LENS ");

		const architecture = await spec("reviewer", "architecture");
		expect(architecture.instructions).toContain("LENS ");
		expect(architecture.instructions).toContain("ARCH ");
		expect(architecture.instructions).not.toContain("QUALITY ");

		const quality = await spec("reviewer", "code-quality");
		expect(quality.instructions).toContain("LENS ");
		expect(quality.instructions).toContain("QUALITY ");
		expect(quality.instructions).not.toContain("ARCH ");

		const security = await spec("reviewer", "security");
		expect(security.instructions).toContain("LENS ");
		expect(security.instructions).not.toContain("ARCH ");
		expect(security.instructions).not.toContain("QUALITY ");

		const verifier = await spec("verifier");
		expect(verifier.instructions).toContain("LENS ");
		expect(verifier.instructions).toContain("ARCH ");
		expect(verifier.instructions).toContain("QUALITY ");
	});
	it("uses the seven plan review lenses", () => {
		expect(Object.keys(lenses)).toEqual([
			"architecture",
			"security",
			"test-coverage",
			"code-quality",
			"correctness",
			"simplicity",
			"compatibility",
		]);
	});
});
