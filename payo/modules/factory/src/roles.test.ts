import { createMemoryRunStore } from "@payo/kernel";
import { describe, expect, it } from "vitest";
import { lenses, roleSpec, snapshotRole } from "./roles.ts";

describe("factory role snapshots", () => {
	it("uses immutable skill content and resources in read-only specs", async () => {
		const store = createMemoryRunStore();
		const source = {
			path: "skills/create-plan/SKILL.md",
			sha: "abc123",
			content: "Original skill",
			resources: { "guide.md": "Original guide" },
		};
		const ref = await snapshotRole(store, source);
		source.content = "Changed";
		source.resources["guide.md"] = "Changed";
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
