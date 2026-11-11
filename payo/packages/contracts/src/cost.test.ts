import { describe, expect, it } from "vitest";
import { AttemptCost, CostSummary, RunCostTree, StepCost } from "./cost.ts";
import { WorkCostTree } from "./factory.ts";

const amount = (currency: string, basis: string, value: number) => ({
	currency,
	basis,
	amount: value,
});

const summary = (overrides: Record<string, unknown> = {}) => ({
	amounts: [amount("USD", "estimated", 1)],
	coverage: "complete",
	incompleteAttempts: 0,
	attempts: 1,
	...overrides,
});

const attempt = (overrides: Record<string, unknown> = {}) => ({
	attemptId: "a1",
	stepId: "s1",
	role: "reviewer",
	runner: "fake",
	model: null,
	roleSpecSha: null,
	inputArtifacts: [],
	status: "succeeded",
	usage: { tokensIn: 1, tokensOut: 2, cost: 1 },
	cost: summary(),
	...overrides,
});

const step = (overrides: Record<string, unknown> = {}) => ({
	stepId: "s1",
	name: "review",
	status: "succeeded",
	cost: summary(),
	attempts: [attempt()],
	...overrides,
});

const runTree = (overrides: Record<string, unknown> = {}) => ({
	runId: "r1",
	status: "ended",
	outcome: "approved",
	asOfSeq: 4,
	cost: summary(),
	steps: [step()],
	...overrides,
});

describe("CostSummary", () => {
	it("accepts a complete, partial, unknown and empty summary", () => {
		expect(CostSummary.safeParse(summary()).success).toBe(true);
		expect(
			CostSummary.safeParse(
				summary({
					coverage: "partial",
					incompleteAttempts: 1,
					attempts: 2,
				}),
			).success,
		).toBe(true);
		expect(
			CostSummary.safeParse(
				summary({
					amounts: [],
					coverage: "unknown",
					incompleteAttempts: 1,
				}),
			).success,
		).toBe(true);
		expect(
			CostSummary.safeParse({
				amounts: [],
				coverage: "complete",
				incompleteAttempts: 0,
				attempts: 0,
			}).success,
		).toBe(true);
	});

	it.each([
		[
			"complete with an incomplete attempt",
			summary({ coverage: "complete", incompleteAttempts: 1, attempts: 2 }),
		],
		[
			"complete with attempts but no amounts",
			summary({ amounts: [], coverage: "complete" }),
		],
		[
			"partial with no amounts",
			summary({
				amounts: [],
				coverage: "partial",
				incompleteAttempts: 1,
				attempts: 2,
			}),
		],
		[
			"unknown with no attempts",
			summary({ amounts: [], coverage: "unknown", attempts: 0 }),
		],
		[
			"unknown with amounts",
			summary({ coverage: "unknown", incompleteAttempts: 1, attempts: 2 }),
		],
		[
			"more incomplete attempts than attempts",
			summary({ incompleteAttempts: 2 }),
		],
	])("rejects %s", (_label, value) => {
		expect(CostSummary.safeParse(value).success).toBe(false);
	});

	it("rejects unsorted amounts and duplicate buckets", () => {
		expect(
			CostSummary.safeParse(
				summary({
					amounts: [
						amount("USD", "provider-reported", 1),
						amount("USD", "estimated", 2),
					],
				}),
			).success,
		).toBe(false);
		expect(
			CostSummary.safeParse(
				summary({
					amounts: [
						amount("USD", "estimated", 1),
						amount("USD", "estimated", 2),
					],
				}),
			).success,
		).toBe(false);
	});
});

describe("AttemptCost and StepCost", () => {
	it("accepts a valid attempt and step", () => {
		expect(AttemptCost.safeParse(attempt()).success).toBe(true);
		expect(StepCost.safeParse(step()).success).toBe(true);
	});

	it("rejects a step whose cost count disagrees with its attempts", () => {
		expect(
			StepCost.safeParse(
				step({ cost: summary({ attempts: 2, incompleteAttempts: 1 }) }),
			).success,
		).toBe(false);
		expect(
			StepCost.safeParse(
				step({
					cost: summary({ incompleteAttempts: 1 }),
					attempts: [attempt(), attempt({ attemptId: "a2" })],
				}),
			).success,
		).toBe(false);
	});
});

describe("RunCostTree", () => {
	it("accepts a valid tree", () => {
		expect(RunCostTree.safeParse(runTree()).success).toBe(true);
	});

	it("rejects a tree whose attempt counts disagree with its summary", () => {
		expect(
			RunCostTree.safeParse(
				runTree({ cost: summary({ attempts: 2, incompleteAttempts: 1 }) }),
			).success,
		).toBe(false);
	});

	it("rejects a tree whose incomplete counts disagree with its steps", () => {
		expect(
			RunCostTree.safeParse(
				runTree({
					cost: summary({ incompleteAttempts: 1, coverage: "partial" }),
					steps: [
						step({
							cost: summary({ incompleteAttempts: 0 }),
						}),
					],
				}),
			).success,
		).toBe(false);
	});
});

describe("WorkCostTree", () => {
	it("accepts planning with execution children", () => {
		expect(
			WorkCostTree.safeParse({
				sourceRunId: "r1",
				planning: runTree(),
				executions: [
					{
						prId: "pr-1",
						run: runTree({ runId: "e1", outcome: "completed" }),
					},
				],
				total: summary({ attempts: 2 }),
			}).success,
		).toBe(true);
	});

	it("rejects a missing planning tree", () => {
		expect(
			WorkCostTree.safeParse({
				sourceRunId: "r1",
				executions: [],
				total: summary(),
			}).success,
		).toBe(false);
	});
});
