import { describe, expect, it } from "vitest";
import {
	assertAcceptanceEvidence,
	implementationReportDecision,
	repairContinuation,
} from "./execution.ts";

const artifact = {
	sha256: "a".repeat(64),
	size: 1,
	kind: "evidence",
	mediaType: "application/json",
};

describe("execution outcome policy", () => {
	it("continues only after every blocker is resolved and no plan issue remains", () => {
		expect(repairContinuation([], [])).toEqual({ stage: "Check" });
		expect(repairContinuation([], ["a"])).toEqual({
			stage: "Escalated",
			reason: "repair left blockers unresolved: a",
			detail: "repair-unresolved",
		});
		expect(repairContinuation(["conflict"], ["a"])).toEqual({
			stage: "Escalated",
			reason: "repair reports approved-plan issues: conflict",
			detail: "repair-plan-issue",
		});
	});
	const final = {
		checks: artifact,
		review: artifact,
		manifest: artifact,
		diff: artifact,
	};
	it("accepts complete final evidence", () => {
		expect(() => assertAcceptanceEvidence("final", final)).not.toThrow();
	});
	it.each(["checks", "review", "manifest", "diff"] as const)(
		"requires %s for final acceptance",
		(field) => {
			expect(() =>
				assertAcceptanceEvidence("final", { ...final, [field]: null }),
			).toThrow("final PR acceptance is missing check or review evidence");
		},
	);
	it.each(["workspace", "report"] as const)(
		"also requires %s for phase acceptance",
		(field) => {
			const workspace = {
				path: "/repo",
				branch: "feature",
				baseCommit: "a",
				head: "a",
				fingerprint: "a",
				historyFingerprint: "a",
			};
			expect(() =>
				assertAcceptanceEvidence("phase", {
					...final,
					workspace,
					report: artifact,
					[field]: null,
				}),
			).toThrow("phase acceptance is missing report or review evidence");
		},
	);
});

it("reconciles an incomplete implementation once, then escalates without losing its reasons", () => {
	const incomplete = {
		completedCriteria: ["first"],
		planIssues: ["unclear API"],
	};
	const reason =
		"implementer reported plan issues: unclear API\nimplementation did not report all acceptance criteria: second";
	expect(
		implementationReportDecision(["first", "second"], incomplete, false),
	).toEqual({ decision: "Reconcile", reason });
	expect(
		implementationReportDecision(["first", "second"], incomplete, true),
	).toEqual({ decision: "Escalated", reason });
	expect(
		implementationReportDecision(
			["first"],
			{ completedCriteria: ["first"], planIssues: [] },
			true,
		),
	).toEqual({ decision: "Check" });
	expect(
		implementationReportDecision(
			["first"],
			{ completedCriteria: ["first"], planIssues: ["conflict"] },
			false,
		).decision,
	).toBe("Reconcile");
	expect(
		implementationReportDecision(
			["first"],
			{ completedCriteria: [], planIssues: [] },
			false,
		).decision,
	).toBe("Reconcile");
});
