import { describe, expect, it } from "vitest";
import { decideImplementationReview } from "./domain/execution.ts";

const finding = (id: string, severity: "P0" | "P1" | "P2" = "P2") => ({
	id,
	severity,
	title: `Finding ${id}`,
	path: "src/domain.ts",
	line: 12,
	evidence: "The adapter imports the domain policy directly.",
	consequence: "The domain rule can no longer be tested independently.",
	suggestedFix: "Move policy behind the application boundary.",
});

const verdict = (
	sourceIds: string[],
	classification:
		| "BLOCKER"
		| "NON-BLOCKER"
		| "STALE"
		| "INVALID"
		| "SPECULATIVE",
	counterEvidence: string | null = null,
) => ({
	sourceIds,
	classification,
	severity: "P2" as const,
	reason: "Evidence checked against the diff.",
	counterEvidence,
});

describe("implementation review decisions", () => {
	it("repairs every verified in-scope blocker, including P2", () => {
		expect(
			decideImplementationReview(
				[finding("architecture-1", "P2")],
				{ verdicts: [verdict(["architecture-1"], "BLOCKER")] },
				[],
				1,
			),
		).toMatchObject({ decision: "Repair", blockerIds: ["architecture-1"] });
	});

	it("does not turn speculative preferences or out-of-scope findings into repairs", () => {
		const findings = [finding("preference"), finding("out-of-scope")];
		expect(
			decideImplementationReview(
				findings,
				{
					verdicts: [
						verdict(["preference"], "SPECULATIVE"),
						verdict(["out-of-scope"], "NON-BLOCKER"),
					],
				},
				[],
				1,
			),
		).toMatchObject({ decision: "Accepted", blockerIds: [] });
	});

	it("fails closed on missing, duplicate, and unknown verdict coverage", () => {
		const one = finding("one");
		expect(
			decideImplementationReview([one], { verdicts: [] }, [], 1).decision,
		).toBe("Escalated");
		expect(
			decideImplementationReview(
				[one],
				{
					verdicts: [verdict(["one"], "INVALID"), verdict(["one"], "BLOCKER")],
				},
				[],
				1,
			).decision,
		).toBe("Escalated");
		expect(
			decideImplementationReview(
				[one],
				{ verdicts: [verdict(["unknown"], "BLOCKER")] },
				[],
				1,
			).decision,
		).toBe("Escalated");
	});

	it("requires counter-evidence for invalid claims and escalates unchecked lenses or plan issues", () => {
		const one = finding("one");
		expect(
			decideImplementationReview(
				[one],
				{ verdicts: [verdict(["one"], "INVALID")] },
				[],
				1,
			).decision,
		).toBe("Escalated");
		expect(
			decideImplementationReview([], { verdicts: [] }, ["architecture"], 1)
				.decision,
		).toBe("Escalated");
		expect(
			decideImplementationReview([], { verdicts: [] }, [], 1, ["plan conflict"])
				.decision,
		).toBe("Escalated");
	});

	it("escalates blockers when the phase repair budget is exhausted", () => {
		expect(
			decideImplementationReview(
				[finding("one")],
				{ verdicts: [verdict(["one"], "BLOCKER")] },
				[],
				3,
			),
		).toMatchObject({ decision: "Escalated", blockerIds: ["one"] });
	});
});
