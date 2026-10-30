import { describe, expect, it } from "vitest";
import { renderInstructions } from "./instructions.ts";

describe("renderInstructions", () => {
	it("returns only the path sentence when there are no overrides", () => {
		expect(renderInstructions("skills/review/SKILL.md", [])).toBe(
			"Follow the skill at skills/review/SKILL.md.",
		);
	});

	it("appends each override in order, separated by blank lines", () => {
		expect(
			renderInstructions("skills/review/SKILL.md", ["First.", "Second."]),
		).toBe("Follow the skill at skills/review/SKILL.md.\n\nFirst.\n\nSecond.");
	});
});
