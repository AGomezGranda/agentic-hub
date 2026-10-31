import { describe, expect, it } from "vitest";
import {
	FactoryCheckpoint,
	FactoryRunConfig,
	PlanOutput,
	ReviewOutput,
	VerifiedOutput,
} from "./factory.ts";

const plan = {
	markdown: "# Plan",
	prStrategy: [{ id: "pr", title: "First", phases: ["build"] }],
	openQuestions: [{ id: "q", question: "Why?" }],
};
const finding = {
	id: "f",
	severity: "P1",
	title: "Issue",
	path: "a.ts",
	line: 1,
	evidence: "e",
	consequence: "c",
	suggestedFix: "fix",
};

describe("factory contracts", () => {
	it("validates plans and rejects empty content and duplicate identifiers", () => {
		expect(PlanOutput.safeParse(plan).success).toBe(true);
		for (const invalid of [
			{ ...plan, markdown: "" },
			{ ...plan, prStrategy: [] },
			{ ...plan, prStrategy: [plan.prStrategy[0], plan.prStrategy[0]] },
			{
				...plan,
				openQuestions: [plan.openQuestions[0], plan.openQuestions[0]],
			},
		])
			expect(PlanOutput.safeParse(invalid).success).toBe(false);
	});
	it("validates findings and verdict classifications", () => {
		expect(ReviewOutput.safeParse({ findings: [finding] }).success).toBe(true);
		expect(
			ReviewOutput.safeParse({ findings: [finding, finding] }).success,
		).toBe(false);
		expect(
			ReviewOutput.safeParse({ findings: [{ ...finding, severity: "P4" }] })
				.success,
		).toBe(false);
		expect(
			VerifiedOutput.safeParse({
				verdicts: [
					{
						sourceIds: ["f"],
						classification: "BLOCKER",
						severity: "P1",
						reason: "r",
						counterEvidence: null,
					},
				],
			}).success,
		).toBe(true);
		expect(
			VerifiedOutput.safeParse({
				verdicts: [
					{
						sourceIds: ["f"],
						classification: "OTHER",
						severity: "P1",
						reason: "r",
						counterEvidence: null,
					},
				],
			}).success,
		).toBe(false);
	});
	it("rejects malformed checkpoints", () => {
		expect(
			FactoryCheckpoint.safeParse({ revision: -1, stage: "unknown" }).success,
		).toBe(false);
	});
	it("validates persisted factory run configuration", () => {
		const role = { model: null, timeoutMs: 1_000 };
		const artifact = {
			sha256: "a".repeat(64),
			size: 10,
			kind: "factory-role-source-v1",
			mediaType: "application/json",
		};
		const config = {
			ticketKey: "ABC-123",
			roles: {
				planner: role,
				reviewer: role,
				verifier: role,
				reviser: role,
			},
			maxConcurrentAgents: 4,
			roleArtifacts: {
				planner: artifact,
				reviewer: artifact,
				verifier: artifact,
				reviser: artifact,
			},
			lenses: ["architecture"],
			roleProvenance: {
				planner: { path: "roles/planner.md", sha: "abc" },
				reviewer: { path: "roles/reviewer.md", sha: "abc" },
				verifier: { path: "roles/verifier.md", sha: "abc" },
				reviser: { path: "roles/reviser.md", sha: "abc" },
			},
		};
		expect(FactoryRunConfig.safeParse(config).success).toBe(true);
		expect(
			FactoryRunConfig.safeParse({
				...config,
				roles: { ...config.roles, planner: { ...role, timeoutMs: 0 } },
			}).success,
		).toBe(false);
	});
});

it("accepts ticket and revision envelopes and validates checkpoint fields", async () => {
	const { Ticket, RevisionOutput } = await import("./factory.ts");
	expect(
		Ticket.safeParse({
			key: "T-1",
			title: "Ticket",
			description: "",
			url: null,
		}).success,
	).toBe(true);
	expect(
		RevisionOutput.safeParse({ plan, unreconciledFindingIds: [] }).success,
	).toBe(true);
	const checkpoint = {
		revision: 1,
		stage: "Plan",
		cycle: 1,
		round: 0,
		ticket: null,
		workspace: null,
		plan: null,
		lastAgentPlan: null,
		answers: {},
		review: null,
		approvalMetric: null,
		inFlight: { stage: "Plan", stepIds: ["step"] },
	};
	expect(FactoryCheckpoint.safeParse(checkpoint).success).toBe(true);
	for (const invalid of [
		{ ...checkpoint, revision: -1 },
		{ ...checkpoint, cycle: -1 },
		{ ...checkpoint, round: -1 },
		{ ...checkpoint, inFlight: { stage: "Plan", stepIds: [] } },
		{ ...checkpoint, plan: { sha256: "bad" } },
	])
		expect(FactoryCheckpoint.safeParse(invalid).success).toBe(false);
});
