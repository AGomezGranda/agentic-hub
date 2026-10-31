import { describe, expect, it } from "vitest";
import { decideReview } from "./state.ts";

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

it("loads the last checkpoint from events rather than deduplicated artifacts", async () => {
	const { createMemoryRunStore, startRun, openRunLog } = await import(
		"@payo/kernel"
	);
	const { storeCheckpoint } = await import("./artifacts.ts");
	const { loadCheckpoint } = await import("./state.ts");
	const store = createMemoryRunStore();
	const log = openRunLog(
		store,
		await startRun(store, {
			runId: "r",
			repo: "r",
			baseBranch: "main",
			config: {},
		}),
	);
	const checkpoint = {
		revision: 1,
		stage: "Plan" as const,
		cycle: 1,
		round: 0,
		ticket: null,
		workspace: null,
		plan: null,
		lastAgentPlan: null,
		answers: {},
		review: null,
		approvalMetric: null,
		inFlight: null,
	};
	await log.write([await storeCheckpoint(store, checkpoint)]);
	await log.write([
		await storeCheckpoint(store, { ...checkpoint, revision: 2 }),
	]);
	expect((await loadCheckpoint(store, await store.read("r"))).revision).toBe(2);
});

it("preserves ordered plan versions when markdown is repeated", async () => {
	const { createMemoryRunStore, startRun, openRunLog } = await import(
		"@payo/kernel"
	);
	const { savePlanVersion, loadPlanVersions } = await import("./artifacts.ts");
	const store = createMemoryRunStore();
	const log = openRunLog(
		store,
		await startRun(store, {
			runId: "versions",
			repo: "repo",
			baseBranch: "main",
			config: {},
		}),
	);
	const plan = {
		markdown: "# Original\n",
		prStrategy: [{ id: "p", title: "One", phases: [] }],
		openQuestions: [],
	};
	for (const number of [1, 2]) {
		const events = await savePlanVersion(store, {
			number,
			source: "agent",
			plan,
			answers: {},
		});
		await log.write(events);
	}
	const versions = await loadPlanVersions(store, await store.read("versions"));
	expect(versions.map((v) => v.number)).toEqual([1, 2]);
	expect(versions[0]?.markdown.sha256).toBe(versions[1]?.markdown.sha256);
	const first = versions[0];
	if (!first) throw new Error("missing version");
	expect(
		new TextDecoder().decode(await store.readArtifact(first.markdown.sha256)),
	).toBe("# Original\n");
});

it("rejects checkpoint bytes that do not match their artifact reference", async () => {
	const { createMemoryRunStore, startRun, openRunLog } = await import(
		"@payo/kernel"
	);
	const { storeCheckpoint } = await import("./artifacts.ts");
	const { loadCheckpoint } = await import("./state.ts");
	const store = createMemoryRunStore();
	const log = openRunLog(
		store,
		await startRun(store, {
			runId: "r",
			repo: "r",
			baseBranch: "main",
			config: {},
		}),
	);
	const checkpoint = {
		revision: 1,
		stage: "Plan" as const,
		cycle: 1,
		round: 0,
		ticket: null,
		workspace: null,
		plan: null,
		lastAgentPlan: null,
		answers: {},
		review: null,
		approvalMetric: null,
		inFlight: null,
	};
	await log.write([await storeCheckpoint(store, checkpoint)]);
	const corrupt = {
		...store,
		async readArtifact() {
			return new TextEncoder().encode(
				JSON.stringify({ ...checkpoint, revision: 2 }),
			);
		},
	};
	await expect(
		loadCheckpoint(corrupt, await store.read("r")),
	).rejects.toThrow();
});
