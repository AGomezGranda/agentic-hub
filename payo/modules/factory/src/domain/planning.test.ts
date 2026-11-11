import type { RunState } from "@payo/kernel";
import { describe, expect, it } from "vitest";
import { assertPlanApprovable } from "./planning.ts";

describe("plan approval policy", () => {
	const state: Pick<RunState, "steps" | "attempts"> = {
		steps: new Map(),
		attempts: new Map(),
	};
	const plan = {
		markdown: "## Phase 1\nImplement the change.",
		prStrategy: [{ id: "pr-1", title: "Change", phases: ["Phase 1"] }],
		openQuestions: [{ id: "q", question: "Which behavior?" }],
	};

	it("requires answers and an executable working plan", () => {
		expect(() =>
			assertPlanApprovable(state, "gate", plan, {}, plan.markdown),
		).toThrow("unanswered questions");
		expect(() =>
			assertPlanApprovable(state, "gate", plan, { q: "   " }, plan.markdown),
		).toThrow("unanswered questions");
		expect(() =>
			assertPlanApprovable(
				state,
				"gate",
				plan,
				{ q: "Keep it" },
				"# Missing phase",
			),
		).toThrow();
		expect(() =>
			assertPlanApprovable(
				state,
				"gate",
				plan,
				{ q: "Keep it" },
				plan.markdown,
			),
		).not.toThrow();
	});
});
