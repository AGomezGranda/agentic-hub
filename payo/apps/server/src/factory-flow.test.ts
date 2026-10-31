import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	answer,
	approve,
	beginFactory,
	executeFactory,
	openFactory,
	requestChanges,
	resume,
	start,
} from "@payo/factory";
import { createLimiter, createMemoryRunStore } from "@payo/kernel";
import type { FakeStep } from "@payo/runner-fake";
import { expect, it } from "vitest";
import {
	createFakeRunner,
	envelope,
	fakeTickets,
	fakeWorkspace,
} from "./factory-fixtures.ts";

const plan = {
	markdown: "# Plan\n",
	prStrategy: [{ id: "pr", title: "One", phases: [] }],
	openQuestions: [],
};
const clean = () => [
	...Array.from({ length: 7 }, () => envelope({ findings: [] })),
	envelope({ verdicts: [] }),
];

it("snapshots edits and answers, then approves with retryable cleanup", async () => {
	const questionPlan = {
		...plan,
		openQuestions: [{ id: "q", question: "Why?" }],
	};
	const { deps, input } = await setup([envelope(questionPlan), ...clean()]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	await writeFile(path, "# Edited\n");
	await expect(approve(handle)).rejects.toThrow("unanswered");
	await expect(
		answer(handle, { questionId: "missing", text: "yes" }),
	).rejects.toThrow();
	await expect(
		answer(handle, { questionId: "q", text: " " }),
	).rejects.toThrow();
	await answer(handle, { questionId: "q", text: "first" });
	await answer(handle, { questionId: "q", text: "second" });
	expect(await readFile(path, "utf8")).toContain("# Edited\n");
	expect(await readFile(path, "utf8")).not.toContain("first");
	let fail = true;
	deps.workspace.remove = async () => {
		if (fail) {
			fail = false;
			throw new Error("cleanup");
		}
	};
	await expect(approve(handle)).rejects.toThrow("cleanup");
	expect(handle.checkpoint.stage).toBe("Approval");
	await approve(handle);
	expect(handle.checkpoint.stage).toBe("Approved");
	expect(handle.log.current().status).toBe("ended");
	await expect(
		answer(handle, { questionId: "q", text: "again" }),
	).rejects.toThrow();
});

it("exposes detached, read-only handle snapshots", async () => {
	const questionPlan = {
		...plan,
		openQuestions: [{ id: "required", question: "Why?" }],
	};
	const { deps, input } = await setup([envelope(questionPlan), ...clean()]);
	const handle = await start(deps, input);
	const checkpoint = handle.checkpoint as unknown as {
		answers: Record<string, string>;
	};
	checkpoint.answers.required = "not committed through answer";
	const state = handle.log.current();
	(state.gates as Map<string, unknown>).clear();

	expect(handle.checkpoint.answers).toEqual({});
	await expect(approve(handle)).rejects.toThrow("unanswered questions");
	expect(handle.log.current().gates.size).toBe(1);
	expect("write" in handle.log).toBe(false);
});

it("does not remove the workspace while an unrelated step is running", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	const handle = await start(deps, input);
	let removed = false;
	deps.workspace.remove = async () => {
		removed = true;
	};
	await deps.store.append(
		input.runId,
		[{ type: "step.started", stepId: "other", name: "other" }],
		handle.log.current().lastSeq,
	);
	const reopened = await openFactory(deps, input.runId);
	await expect(approve(reopened)).rejects.toThrow();
	expect(removed).toBe(false);
});

it("requestChanges reviews the edited snapshot in a new cycle", async () => {
	const { deps, input, runner } = await setup([
		envelope(plan),
		...clean(),
		...clean(),
	]);
	const handle = await start(deps, input);
	await writeFile(
		join(deps.dataDir, "runs", "run", "plan.md"),
		"# Edit for review\n",
	);
	await requestChanges(handle, { signal: input.signal });
	expect(handle.checkpoint).toMatchObject({
		stage: "Approval",
		cycle: 2,
		round: 1,
	});
	expect(runner.calls.filter((call) => call.role === "reviewer")).toHaveLength(
		14,
	);
	expect(
		await readFile(join(deps.dataDir, "runs", "run", "plan.md"), "utf8"),
	).toContain("# Edit for review");
});

it("requires answers to new questions introduced by a revision", async () => {
	const questionPlan = {
		...plan,
		openQuestions: [{ id: "old", question: "Old?" }],
	};
	const finding = {
		id: "f",
		severity: "P1",
		title: "Bug",
		path: null,
		line: null,
		evidence: "e",
		consequence: "c",
		suggestedFix: "fix",
	};
	const { deps, input } = await setup([
		envelope(questionPlan),
		...clean(),
		envelope({ findings: [finding] }),
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
		envelope({
			verdicts: [
				{
					sourceIds: ["f"],
					classification: "BLOCKER",
					severity: "P1",
					reason: "confirmed",
					counterEvidence: null,
				},
			],
		}),
		envelope({
			plan: {
				...plan,
				openQuestions: [
					...questionPlan.openQuestions,
					{ id: "new", question: "New?" },
				],
			},
			unreconciledFindingIds: [],
		}),
		...clean(),
	]);
	const handle = await start(deps, input);
	await answer(handle, { questionId: "old", text: "yes" });
	await requestChanges(handle, { signal: input.signal });
	await expect(approve(handle)).rejects.toThrow("unanswered");
	await answer(handle, { questionId: "new", text: "also yes" });
	await approve(handle);
	expect(handle.checkpoint.answers).toEqual({ old: "yes", new: "also yes" });
});
async function setup(scripts: FakeStep[][]) {
	const runner = createFakeRunner(scripts);
	const source = {
		path: "skills/plan/SKILL.md",
		sha: "123456",
		content: "skill",
		resources: {},
	};
	const roleSources = {
		planner: source,
		reviewer: source,
		verifier: source,
		reviser: source,
	};
	const roles = {
		planner: { model: null, timeoutMs: 1000 },
		reviewer: { model: null, timeoutMs: 1000 },
		verifier: { model: null, timeoutMs: 1000 },
		reviser: { model: null, timeoutMs: 1000 },
	};
	const deps = {
		store: createMemoryRunStore(),
		runner,
		limiter: createLimiter(1),
		tickets: fakeTickets([
			{ key: "T", title: "Ticket", description: "", url: null },
		]),
		workspace: fakeWorkspace("/workspace"),
		dataDir: await mkdtemp(join(tmpdir(), "factory-")),
		roleSources,
	};
	const input = {
		runId: "run",
		ticketKey: "T",
		repo: "repo",
		baseBranch: "main",
		roles,
		maxConcurrentAgents: 1,
		signal: new AbortController().signal,
	};
	return { deps, input, runner };
}
it("begins at FetchTicket without runner calls and executes the same handle to approval", async () => {
	const { deps, input, runner } = await setup([envelope(plan), ...clean()]);
	const { signal, ...startInput } = input;
	const handle = await beginFactory(deps, startInput);
	expect(handle.checkpoint.stage).toBe("FetchTicket");
	expect(runner.calls).toHaveLength(0);
	expect(await deps.store.listRunIds()).toEqual(["run"]);

	await executeFactory(handle, { signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(runner.calls).toHaveLength(9);
});

it("runs a clean plan and seven reviews to approval, and reopens without agents", async () => {
	const { deps, input, runner } = await setup([envelope(plan), ...clean()]);
	const handle = await start(deps, input);
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(runner.calls).toHaveLength(9);
	const opened = await openFactory(deps, "run");
	expect(opened.checkpoint.stage).toBe("Approval");
	expect(runner.calls).toHaveLength(9);
});

it("preserves edited working copy when a resumed review fails again", async () => {
	const badReview = () => [
		[
			{
				kind: "emit" as const,
				event: { type: "error" as const, message: "failed" },
			},
		],
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
		envelope({ verdicts: [] }),
	];
	const { deps, input } = await setup([
		envelope(plan),
		...badReview(),
		...badReview(),
	]);
	const first = await start(deps, input);
	expect(first.checkpoint.stage).toBe("Escalated");
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	await writeFile(path, "# Human edit\n");
	const reopened = await openFactory(deps, "run");
	const resumed = await resume(reopened, { signal: input.signal });
	expect(resumed.checkpoint.stage).toBe("Escalated");
	expect(await readFile(path, "utf8")).toContain("# Human edit\n");
	expect(await readFile(path, "utf8")).toContain(
		"<!-- factory answers start -->",
	);
	expect(resumed.checkpoint.cycle).toBe(2);
});

it("escalates a runner exception and resumes with a fresh planner attempt", async () => {
	const { deps, input, runner } = await setup([
		[{ kind: "throw", message: "runner failed" }],
		envelope(plan),
		...clean(),
	]);
	const handle = await start(deps, input);
	expect(handle.checkpoint.stage).toBe("Escalated");
	deps.roleSources.planner.content = "changed later";
	deps.roleSources.planner.sha = "changed-sha";
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(runner.calls.filter((call) => call.role === "planner")).toHaveLength(
		2,
	);
	expect(runner.calls[1]?.instructions).toContain("skill");
	expect(runner.calls[1]?.instructions).not.toContain("changed later");
	expect(runner.calls[1]?.roleSpecSha).toBe("123456");
});

it("escalates after three blocking rounds and records each decision", async () => {
	const finding = {
		id: "f",
		severity: "P1",
		title: "Bug",
		path: null,
		line: null,
		evidence: "e",
		consequence: "c",
		suggestedFix: "fix",
	};
	const round = () => [
		envelope({ findings: [finding] }),
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
		envelope({
			verdicts: [
				{
					sourceIds: ["f"],
					classification: "BLOCKER",
					severity: "P1",
					reason: "confirmed",
					counterEvidence: null,
				},
			],
		}),
	];
	const revision = envelope({ plan, unreconciledFindingIds: [] });
	const { deps, input } = await setup([
		envelope(plan),
		...round(),
		revision,
		...round(),
		revision,
		...round(),
	]);
	const handle = await start(deps, input);
	expect(handle.checkpoint).toMatchObject({
		stage: "Escalated",
		cycle: 1,
		round: 3,
	});
	const reviews = (await deps.store.read("run")).filter(
		(event) =>
			event.type === "artifact.recorded" &&
			event.artifact.kind === "factory-review-v1",
	);
	expect(reviews).toHaveLength(3);
	for (const event of reviews) {
		if (event.type !== "artifact.recorded") throw new Error("missing review");
		const review = JSON.parse(
			new TextDecoder().decode(
				await deps.store.readArtifact(event.artifact.sha256),
			),
		);
		expect(review).toMatchObject({
			unchecked: [],
			verdicts: {
				verdicts: [
					{ sourceIds: ["f"], classification: "BLOCKER", severity: "P1" },
				],
			},
		});
	}
});

it("retries malformed verifier references before escalating", async () => {
	const bad = envelope({
		verdicts: [
			{
				sourceIds: ["missing"],
				classification: "BLOCKER",
				severity: "P1",
				reason: "bad",
				counterEvidence: null,
			},
		],
	});
	const { deps, input, runner } = await setup([
		envelope(plan),
		...Array.from({ length: 7 }, () => envelope({ findings: [] })),
		bad,
		bad,
	]);
	const handle = await start(deps, input);
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(runner.calls.filter((call) => call.role === "verifier")).toHaveLength(
		2,
	);
});

it("rejects revision references to unknown findings", async () => {
	const finding = {
		id: "f",
		severity: "P1",
		title: "Bug",
		path: null,
		line: null,
		evidence: "e",
		consequence: "c",
		suggestedFix: "fix",
	};
	const verdicts = [
		{
			sourceIds: ["f"],
			classification: "BLOCKER",
			severity: "P1",
			reason: "confirmed",
			counterEvidence: null,
		},
	];
	const bad = envelope({ plan, unreconciledFindingIds: ["unknown"] });
	const { deps, input, runner } = await setup([
		envelope(plan),
		envelope({ findings: [finding] }),
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
		envelope({ verdicts }),
		bad,
		bad,
	]);
	const handle = await start(deps, input);
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(runner.calls.filter((call) => call.role === "reviser")).toHaveLength(
		2,
	);
});

it("revises a blocker and then reaches approval", async () => {
	const finding = {
		id: "f",
		severity: "P1",
		title: "Bug",
		path: null,
		line: null,
		evidence: "e",
		consequence: "c",
		suggestedFix: "fix",
	};
	const verdicts = [
		{
			sourceIds: ["f"],
			classification: "BLOCKER",
			severity: "P1",
			reason: "confirmed",
			counterEvidence: null,
		},
	];
	const { deps, input } = await setup([
		envelope(plan),
		envelope({ findings: [finding] }),
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
		envelope({ verdicts }),
		envelope({
			plan: { ...plan, markdown: "# Revised\n" },
			unreconciledFindingIds: [],
		}),
		...clean(),
	]);
	const handle = await start(deps, input);
	expect(handle.checkpoint).toMatchObject({ stage: "Approval", round: 2 });
	expect(
		await readFile(join(deps.dataDir, "runs", "run", "plan.md"), "utf8"),
	).toBe("# Revised\n");
});

it("allows a non-blocking finding and escalates an unreconciled revision", async () => {
	const finding = {
		id: "f",
		severity: "P2",
		title: "Issue",
		path: null,
		line: null,
		evidence: "e",
		consequence: "c",
		suggestedFix: "fix",
	};
	const reports = () => [
		envelope({ findings: [finding] }),
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
	];
	const verdict = (classification: string, severity: string) =>
		envelope({
			verdicts: [
				{
					sourceIds: ["f"],
					classification,
					severity,
					reason: "reviewed",
					counterEvidence: null,
				},
			],
		});
	const first = await setup([
		envelope(plan),
		...reports(),
		verdict("NON-BLOCKER", "P2"),
	]);
	expect((await start(first.deps, first.input)).checkpoint.stage).toBe(
		"Approval",
	);
	const second = await setup([
		envelope(plan),
		...reports(),
		verdict("BLOCKER", "P1"),
		envelope({ plan, unreconciledFindingIds: ["f"] }),
	]);
	const handle = await start(second.deps, second.input);
	expect(handle.checkpoint).toMatchObject({ stage: "Escalated", round: 1 });
	expect(
		second.runner.calls.filter((call) => call.role === "reviewer"),
	).toHaveLength(7);
});

it("pauses on cancellation and rejects concurrent commands", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	const aborted = new AbortController();
	aborted.abort();
	const handle = await start(deps, { ...input, signal: aborted.signal });
	expect(handle.checkpoint.stage).toBe("Escalated");
	const pending = resume(handle, { signal: input.signal });
	await expect(resume(handle, { signal: input.signal })).rejects.toThrow(
		"busy",
	);
	await pending;
	expect(handle.checkpoint.stage).toBe("Approval");
});

it("does not clear an unrelated gate during resume", async () => {
	const { deps, input } = await setup([[{ kind: "throw", message: "failed" }]]);
	const handle = await start(deps, input);
	await deps.store.append(
		input.runId,
		[
			{ type: "step.started", stepId: "unrelated", name: "other" },
			{
				type: "gate.raised",
				gateId: "other",
				stepId: "unrelated",
				kind: "factory-escalation",
				allowedCommands: ["resume"],
				reason: "other",
			},
		],
		handle.log.current().lastSeq,
	);
	const reopened = await openFactory(deps, input.runId);
	await expect(resume(reopened, { signal: input.signal })).rejects.toThrow(
		"unrelated open gate",
	);
	expect(reopened.log.current().gates.get("other")?.status).toBe("open");
});

it("requires explicit resume after a successful planner step loses its checkpoint", async () => {
	const { deps, input, runner } = await setup([
		envelope(plan),
		envelope(plan),
		...clean(),
	]);
	const store = deps.store;
	let fail = true;
	deps.store = {
		...store,
		async append(runId, events, seq) {
			if (
				fail &&
				events.some(
					(event) =>
						event.type === "artifact.recorded" &&
						event.artifact.kind === "factory-plan-version-v1",
				)
			) {
				fail = false;
				throw new Error("simulated crash");
			}
			return store.append(runId, events, seq);
		},
	};
	await expect(start(deps, input)).rejects.toThrow("simulated crash");
	const handle = await openFactory(deps, "run");
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(runner.calls).toHaveLength(1);
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(runner.calls.filter((call) => call.role === "planner")).toHaveLength(
		2,
	);
});

it("gates a run that crashed after a transition before the next marker", async () => {
	const { deps, input, runner } = await setup([envelope(plan), ...clean()]);
	const store = deps.store;
	let crashed = false;
	deps.store = {
		...store,
		async append(runId, events, seq) {
			if (!crashed) {
				for (const event of events) {
					if (
						event.type !== "artifact.recorded" ||
						event.artifact.kind !== "factory-checkpoint-v1"
					)
						continue;
					const checkpoint = JSON.parse(
						new TextDecoder().decode(
							await store.readArtifact(event.artifact.sha256),
						),
					);
					if (checkpoint.stage === "Plan" && checkpoint.inFlight) {
						crashed = true;
						throw new Error("crash before marker");
					}
				}
			}
			return store.append(runId, events, seq);
		},
	};
	await expect(start(deps, input)).rejects.toThrow("crash before marker");
	expect(runner.calls).toHaveLength(0);
	const handle = await openFactory(deps, "run");
	expect(handle.checkpoint).toMatchObject({
		stage: "Escalated",
		inFlight: { stage: "Plan" },
	});
	expect(
		[...handle.log.current().gates.values()].filter(
			(gate) => gate.status === "open",
		),
	).toHaveLength(1);
	expect(runner.calls).toHaveLength(0);
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(runner.calls.filter((call) => call.role === "planner")).toHaveLength(
		1,
	);
});

it("escalates a ticket fetch failure and resumes the same stage", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	deps.tickets.get = async () => {
		throw new Error("ticket unavailable");
	};
	const handle = await start(deps, input);
	expect(handle.checkpoint.stage).toBe("Escalated");
	const gate = [...handle.log.current().gates.values()].find(
		(item) => item.status === "open",
	);
	expect(gate).toMatchObject({
		kind: "factory-escalation",
		reason: "run run: ticket unavailable",
	});
	deps.tickets = fakeTickets([
		{ key: "T", title: "Ticket", description: "", url: null },
	]);
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
});

it("escalates a workspace creation failure and resumes the same stage", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	deps.workspace.create = async () => {
		throw new Error("workspace unavailable");
	};
	const handle = await start(deps, input);
	expect(handle.checkpoint.stage).toBe("Escalated");
	const gate = [...handle.log.current().gates.values()].find(
		(item) => item.status === "open",
	);
	expect(gate).toMatchObject({
		kind: "factory-escalation",
		reason: "run run: workspace unavailable",
	});
	deps.workspace = fakeWorkspace("/workspace");
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
});
