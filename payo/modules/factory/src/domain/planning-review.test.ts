import { FactoryCheckpoint, PlanVersion } from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { decideReview } from "./planning.ts";

const finding = {
	id: "f",
	severity: "P1" as const,
	title: "Issue",
	path: null,
	line: null,
	evidence: "e",
	consequence: "c",
	suggestedFix: "fix",
};
const verdict = {
	sourceIds: ["f"],
	classification: "BLOCKER" as const,
	severity: "P1" as const,
	reason: "r",
	counterEvidence: null,
};

it("defaults pending updates for older checkpoints and exposes the restore rollback restriction", () => {
	const checkpoint = FactoryCheckpoint.parse({
		revision: 0,
		stage: "Plan",
		cycle: 1,
		round: 0,
		workItem: null,
		workspace: null,
		plan: null,
		lastAgentPlan: null,
		answers: {},
		review: null,
		approvalMetric: null,
		inFlight: null,
	});
	expect(checkpoint.pendingPlanUpdate).toBeNull();
	const legacy = PlanVersion.extend({
		source: PlanVersion.shape.source.exclude(["restore"]),
	});
	const record = {
		number: 1,
		source: "restore",
		markdown: {
			sha256: "a".repeat(64),
			size: 1,
			kind: "factory-plan-markdown",
			mediaType: "text/markdown",
		},
		plan: {
			markdown: "x",
			prStrategy: [{ id: "p", title: "P", phases: [] }],
			openQuestions: [],
		},
		answers: {},
	};
	expect(PlanVersion.safeParse(record).success).toBe(true);
	expect(legacy.safeParse(record).success).toBe(false);
});
describe("review decision", () => {
	it("revises blockers until the third round and escalates unchecked lenses", () => {
		expect(decideReview([finding], { verdicts: [verdict] }, [], 1)).toBe(
			"Revise",
		);
		expect(decideReview([finding], { verdicts: [verdict] }, [], 3)).toBe(
			"Escalated",
		);
		expect(decideReview([], { verdicts: [] }, ["security"], 1)).toBe(
			"Escalated",
		);
		expect(
			decideReview(
				[finding],
				{ verdicts: [{ ...verdict, severity: "P2" }] },
				[],
				1,
			),
		).toBe("Approval");
	});
	it("requires revision for verified design blockers and escalates missing coverage", () => {
		const design = {
			...finding,
			severity: "P1" as const,
			title: "Domain policy lives in an infrastructure adapter",
		};
		expect(
			decideReview(
				[design],
				{ verdicts: [{ ...verdict, severity: "P1" }] },
				[],
				1,
			),
		).toBe("Revise");
		expect(
			decideReview(
				[design],
				{ verdicts: [{ ...verdict, severity: "P2" }] },
				[],
				1,
			),
		).toBe("Approval");
		expect(decideReview([], { verdicts: [] }, ["architecture"], 1)).toBe(
			"Escalated",
		);
	});
	it("rejects incomplete, duplicate, unknown and unsupported invalid verdicts", () => {
		for (const verdicts of [
			[],
			[verdict, verdict],
			[{ ...verdict, sourceIds: ["other"] }],
			[{ ...verdict, classification: "INVALID" as const }],
		]) {
			expect(() => decideReview([finding], { verdicts }, [], 1)).toThrow();
		}
	});
});
