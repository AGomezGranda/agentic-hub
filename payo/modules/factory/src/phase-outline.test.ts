import { expect, it } from "vitest";
import { resolveImplementation } from "./phase-outline.ts";

const pr = (id: string, ...phases: string[]) => ({ id, title: id, phases });

it("resolves shorthand and ranges in strategy order to verbatim headings", () => {
	const markdown = [
		"~~~markdown",
		"## Phase 1: Example",
		"~~~",
		"### Phase 0 — Begin",
		"## Phase 1: Contracts",
		"#### Phase 2 - Wire APIs",
		"## Phase 3a — Release",
	].join("\n");
	const result = resolveImplementation(markdown, [
		pr("one", "Phases 0–1"),
		pr("two", "phase 2: Wire APIs", "Release"),
	]);
	expect(result.map((p) => p.issues)).toEqual([[], []]);
	expect(result.flatMap((p) => p.phases)).toEqual([
		{ title: "Phase 0 — Begin", line: 4 },
		{ title: "Phase 1: Contracts", line: 5 },
		{ title: "Phase 2 - Wire APIs", line: 6 },
		{ title: "Phase 3a — Release", line: 7 },
	]);
});

it("reports missing, ambiguous, duplicate and unassigned work", () => {
	const markdown = "## Phase 1: Setup\n## Phase 2: Setup\n## Phase 3: Ship";
	const result = resolveImplementation(markdown, [
		pr("one", "Phase 1"),
		pr("two", "Phase 1", "Setup", "Phase 9"),
		pr("three"),
	]);
	expect(result[0]?.issues.join(" ")).toMatch(/assigned.*two/i);
	expect(result[1]?.issues.join(" ")).toMatch(/ambiguous.*Setup/i);
	expect(result[1]?.issues.join(" ")).toContain("Phase 1: Setup (line 1)");
	expect(result[1]?.issues.join(" ")).toContain("Phase 2: Setup (line 2)");
	expect(result[1]?.issues.join(" ")).toMatch(/unresolved.*Phase 9/i);
	expect(result[2]?.issues.join(" ")).toMatch(/no phases/i);
	expect(result[0]?.issues.join(" ")).toMatch(/unassigned.*Phase 3/i);
});

it("matches an existing plan's exact prose reference when unique", () => {
	expect(
		resolveImplementation("Build the widget and test it.", [
			pr("one", "Build the widget"),
		])[0],
	).toMatchObject({
		phases: [{ title: "Build the widget", line: 1 }],
		issues: [],
	});
	expect(
		resolveImplementation("## Phase 1\nFoundation.\n", [
			pr("one", "Foundation"),
		])[0],
	).toMatchObject({ phases: [{ title: "Phase 1", line: 1 }], issues: [] });
});

it("refuses an incomplete range and contradictory numbered title", () => {
	const result = resolveImplementation("## Phase 1: One\n## Phase 3: Three", [
		pr("one", "Phases 1–3", "Phase 1: Three"),
	]);
	expect(result[0]?.issues.filter((i) => /unresolved/i.test(i))).toHaveLength(
		2,
	);
});

it("ignores strategy recaps and prose outside the phase", () => {
	const markdown = [
		"# Plan",
		"Unrelated task",
		"## Phase 1 — Foundation",
		"Do the work.",
		"## PR Strategy",
		"### Phase 1",
		"Unrelated task",
		"Do the work.",
	].join("\n");
	const result = resolveImplementation(markdown, [
		pr("one", "Do the work."),
		pr("two", "Unrelated task"),
	]);
	expect(result[0]).toMatchObject({
		phases: [{ title: "Phase 1 — Foundation", line: 3 }],
		issues: [],
	});
	expect(result[1]?.issues).toEqual([
		"Unresolved phase reference “Unrelated task”.",
	]);
});

it("prefers a matching unnumbered heading and ignores generated answers", () => {
	const markdown = [
		"# Plan",
		"Build tools come first.",
		"### Build tools",
		"Acceptance: good.",
		"<!-- factory answers start -->",
		"### Phase 9: Surprise",
		"Only mentioned here",
		"<!-- factory answers end -->",
		"## Delivery",
	].join("\n");
	const result = resolveImplementation(markdown, [
		pr("one", "build tools", "Delivery"),
		pr("two", "Only mentioned here"),
	]);
	expect(result[0]).toMatchObject({
		phases: [
			{ title: "Build tools", line: 3 },
			{ title: "Delivery", line: 9 },
		],
		issues: [],
	});
	expect(result[1]?.issues).toEqual([
		"Unresolved phase reference “Only mentioned here”.",
	]);
});
