import { expect, it } from "vitest";
import { approvalDiff } from "./metrics.ts";

it.each([
	["a\nb\n", "a\nb\n"],
	["a\nb", "a\nx\nb"],
	["a\nx\nb", "a\nb"],
	["a\n", "a"],
	["a\nb\nc\nd", "a\nx\nc\ny"],
])("reconstructs approved bytes from %j to %j", (original, approved) => {
	const diff = approvalDiff(original, approved);
	const lines = original.split("\n");
	lines.splice(diff.prefixLines, diff.removed.length, ...diff.added);
	expect(lines.join("\n")).toBe(approved);
	expect(diff.changed).toBe(original !== approved);
});
