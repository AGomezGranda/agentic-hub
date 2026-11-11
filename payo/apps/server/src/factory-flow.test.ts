import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acceptPlanUpdate,
	answer,
	approve,
	beginFactory,
	executeFactory,
	openFactory,
	QUALITY_EXPECTATIONS,
	readPlan,
	readPlanVersions,
	requestChanges,
	restorePlan,
	resume,
	start,
	updatePlan,
	writePlan,
} from "@payo/factory";
import { createLimiter, createMemoryRunStore, sha256Hex } from "@payo/kernel";
import type { FakeStep } from "@payo/runner-fake";
import { expect, it } from "vitest";
import {
	createFakeRunner,
	envelope,
	fakeWorkItems,
	fakeWorkspace,
} from "./factory-fixtures.ts";

const plan = {
	markdown: "# Plan\n## Phase 1 — One phase\n",
	prStrategy: [{ id: "pr", title: "One", phases: ["One phase"] }],
	openQuestions: [],
};
const clean = () => [
	...Array.from({ length: 7 }, () => envelope({ findings: [] })),
	envelope({ verdicts: [] }),
];

it("restores a saved version after preserving the edited working copy", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean(), ...clean()]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	const edited = "# Edited\n";
	await writeFile(path, edited);
	await restorePlan(handle, {
		version: 1,
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(edited)),
		signal: input.signal,
	});
	expect(handle.checkpoint).toMatchObject({
		stage: "Approval",
		cycle: 2,
		round: 1,
	});
	expect(await readFile(path, "utf8")).toBe(plan.markdown);
	expect((await readPlanVersions(handle)).map((v) => v.source)).toEqual([
		"agent",
		"human",
		"restore",
	]);
});

it("resumes a restore accepted before its saved result is installed", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean(), ...clean()]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	await writeFile(path, "# Edited\n");
	await acceptPlanUpdate(handle, {
		version: 1,
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode("# Edited\n")),
	});
	const reopened = await openFactory(deps, "run");
	await resume(reopened, { signal: input.signal });
	expect(reopened.checkpoint.stage).toBe("Approval");
	expect(await readFile(path, "utf8")).toBe(plan.markdown);
	expect((await readPlanVersions(reopened)).map((v) => v.source)).toEqual([
		"agent",
		"human",
		"restore",
	]);
});

it.each(["restore", "prompt"] as const)(
	"recovers a %s after installation but before its checkpoint",
	async (kind) => {
		const revised = { ...plan, markdown: "# Revised after crash\n" };
		const scripts =
			kind === "prompt"
				? [
						envelope(plan),
						...clean(),
						envelope({ plan: revised, unreconciledFindingIds: [] }),
						...clean(),
					]
				: [envelope(plan), ...clean(), ...clean()];
		const { deps, input } = await setup(scripts);
		const store = deps.store;
		let crash = false;
		deps.store = {
			...store,
			async append(runId, events, seq) {
				for (const event of events) {
					if (
						!crash ||
						event.type !== "artifact.recorded" ||
						event.artifact.kind !== "factory-checkpoint-v1"
					)
						continue;
					const checkpoint = JSON.parse(
						new TextDecoder().decode(
							await store.readArtifact(event.artifact.sha256),
						),
					);
					if (
						checkpoint.pendingPlanUpdate?.result &&
						checkpoint.plan?.sha256 ===
							checkpoint.pendingPlanUpdate.result.sha256
					) {
						crash = false;
						throw new Error("installation checkpoint interrupted");
					}
				}
				return store.append(runId, events, seq);
			},
		};
		const handle = await start(deps, input);
		const expected = {
			expectedVersion: 1,
			expectedWorkingCopyHash: sha256Hex(
				new TextEncoder().encode(plan.markdown),
			),
		};
		await acceptPlanUpdate(
			handle,
			kind === "prompt"
				? { ...expected, prompt: "Change the plan" }
				: { ...expected, version: 1 },
		);
		crash = true;
		await expect(
			executeFactory(handle, { signal: input.signal }),
		).rejects.toThrow("installation checkpoint interrupted");
		const reopened = await openFactory(deps, "run");
		await resume(reopened, { signal: input.signal });
		expect(reopened.checkpoint.stage).toBe("Approval");
		expect(
			await readFile(join(deps.dataDir, "runs", "run", "plan.md"), "utf8"),
		).toContain(kind === "prompt" ? "# Revised after crash" : "# Plan");
		expect(
			(await readPlanVersions(reopened)).map((item) => item.source),
		).toEqual(["agent", kind === "prompt" ? "agent" : "restore"]);
	},
);

it("preserves an external edit made after accepting a restore", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean(), ...clean()]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	await acceptPlanUpdate(handle, {
		version: 1,
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(plan.markdown)),
	});
	await writeFile(path, "# External change\n");
	await executeFactory(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(await readFile(path, "utf8")).toBe("# External change\n");
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(await readFile(path, "utf8")).toContain("# External change");
	expect((await readPlanVersions(handle)).map((v) => v.source)).toEqual([
		"agent",
		"restore",
		"human",
	]);
});

it("revises the current edited plan from a prompt and reviews the result", async () => {
	const revised = { ...plan, markdown: "# Revised\n" };
	const { deps, input, runner } = await setup([
		envelope(plan),
		...clean(),
		envelope({ plan: revised, unreconciledFindingIds: [] }),
		...clean(),
	]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	const edited = "# Human edit\n";
	await writeFile(path, edited);
	await updatePlan(handle, {
		prompt: "Improve it",
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(edited)),
		signal: input.signal,
	});
	expect(handle.checkpoint).toMatchObject({ stage: "Approval", round: 1 });
	const call = runner.calls.find((item) => item.role === "reviser");
	expect(call?.inputs.map((item) => item.name)).toEqual(
		expect.arrayContaining(["plan", "prompt"]),
	);
	expect((await readPlanVersions(handle)).map((v) => v.source)).toEqual([
		"agent",
		"human",
		"agent",
	]);
	expect(await readFile(path, "utf8")).toContain("# Revised");
});

it("retries an interrupted prompt with its original instructions", async () => {
	const revised = { ...plan, markdown: "# Resumed\n" };
	const { deps, input, runner } = await setup([
		envelope(plan),
		...clean(),
		envelope({ plan: revised, unreconciledFindingIds: [] }),
		...clean(),
	]);
	const handle = await start(deps, input);
	await acceptPlanUpdate(handle, {
		prompt: "Keep this prompt",
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(plan.markdown)),
	});
	const reopened = await openFactory(deps, "run");
	await resume(reopened, { signal: input.signal });
	const ref = runner.calls
		.find((call) => call.role === "reviser")
		?.inputs.find((item) => item.name === "prompt")?.ref;
	if (!ref) throw new Error("missing prompt input");
	expect(
		new TextDecoder().decode(await deps.store.readArtifact(ref.sha256)),
	).toBe("Keep this prompt");
	expect(reopened.checkpoint).toMatchObject({
		stage: "Approval",
		cycle: 2,
		round: 1,
		pendingPlanUpdate: null,
	});
});

it("preserves an edit made during a cancelled prompt revision", async () => {
	const { deps, input, runner } = await setup([
		envelope(plan),
		...clean(),
		[{ kind: "hang" }],
		...clean(),
	]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	const controller = new AbortController();
	const work = updatePlan(handle, {
		prompt: "Revise",
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(plan.markdown)),
		signal: controller.signal,
	});
	while (!runner.calls.some((call) => call.role === "reviser"))
		await new Promise((resolve) => setTimeout(resolve, 1));
	await writeFile(path, "# Edited during revision\n");
	controller.abort();
	await work;
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(await readFile(path, "utf8")).toBe("# Edited during revision\n");
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(await readFile(path, "utf8")).toContain("# Edited during revision");
});

it("preserves a working-file edit made during a restore review", async () => {
	const { deps, input } = await setup([
		envelope(plan),
		...clean(),
		...clean(),
		...clean(),
	]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	const runner = deps.runner;
	let edit = true;
	deps.runner = {
		...runner,
		async *run(spec, signal) {
			if (edit && spec.role === "reviewer") {
				edit = false;
				await writeFile(path, "# Changed during review\n");
			}
			yield* runner.run(spec, signal);
		},
	};
	await restorePlan(handle, {
		version: 1,
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(plan.markdown)),
		signal: input.signal,
	});
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(await readFile(path, "utf8")).toBe("# Changed during review\n");
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(await readFile(path, "utf8")).toContain("# Changed during review");
});

it("keeps answers recorded while a prompt update is escalated", async () => {
	const questionPlan = {
		...plan,
		openQuestions: [{ id: "q", question: "Why?" }],
	};
	const { deps, input } = await setup([
		envelope(questionPlan),
		...clean(),
		[{ kind: "throw", message: "failed" }],
		...clean(),
	]);
	const handle = await start(deps, input);
	await updatePlan(handle, {
		prompt: "Revise",
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(
			new TextEncoder().encode(questionPlan.markdown),
		),
		signal: input.signal,
	});
	expect(handle.checkpoint.stage).toBe("Escalated");
	await answer(handle, { questionId: "q", text: "Because" });
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(handle.checkpoint.answers).toEqual({ q: "Because" });
	expect(
		await readFile(join(deps.dataDir, "runs", "run", "plan.md"), "utf8"),
	).toContain("Because");
});

it("keeps an answer made after a restore installation conflict", async () => {
	const questionPlan = {
		...plan,
		openQuestions: [{ id: "q", question: "Why?" }],
	};
	const { deps, input } = await setup([
		envelope(questionPlan),
		...clean(),
		...clean(),
	]);
	const handle = await start(deps, input);
	await acceptPlanUpdate(handle, {
		version: 1,
		expectedVersion: 1,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(plan.markdown)),
	});
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	await writeFile(path, "# External change\n");
	await executeFactory(handle, { signal: input.signal });
	await answer(handle, { questionId: "q", text: "Because" });
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.answers).toEqual({ q: "Because" });
});

it("starts a new round for updates and restores from a high-round approval", async () => {
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
	const blocked = () => [
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
		...blocked(),
		revision,
		...blocked(),
		revision,
		...clean(),
		revision,
		...clean(),
		...clean(),
	]);
	const handle = await start(deps, input);
	expect(handle.checkpoint.round).toBe(3);
	let current = (await readPlanVersions(handle)).at(-1);
	if (!current) throw new Error("missing version");
	let working = await readFile(
		join(deps.dataDir, "runs", "run", "plan.md"),
		"utf8",
	);
	await updatePlan(handle, {
		prompt: "Change",
		expectedVersion: current.number,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(working)),
		signal: input.signal,
	});
	expect(handle.checkpoint).toMatchObject({ stage: "Approval", round: 1 });
	current = (await readPlanVersions(handle)).at(-1);
	if (!current) throw new Error("missing version");
	working = await readFile(
		join(deps.dataDir, "runs", "run", "plan.md"),
		"utf8",
	);
	await restorePlan(handle, {
		version: 1,
		expectedVersion: current.number,
		expectedWorkingCopyHash: sha256Hex(new TextEncoder().encode(working)),
		signal: input.signal,
	});
	expect(handle.checkpoint).toMatchObject({ stage: "Approval", round: 1 });
});

it("does not change a gate for invalid or stale updates", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	const handle = await start(deps, input);
	const before = await deps.store.read("run");
	const expectedWorkingCopyHash = sha256Hex(
		new TextEncoder().encode(plan.markdown),
	);
	await expect(
		acceptPlanUpdate(handle, {
			prompt: " ",
			expectedVersion: 1,
			expectedWorkingCopyHash,
		}),
	).rejects.toThrow("blank");
	await expect(
		acceptPlanUpdate(handle, {
			prompt: "change",
			expectedVersion: 2,
			expectedWorkingCopyHash,
		}),
	).rejects.toThrow("changed");
	await expect(
		acceptPlanUpdate(handle, {
			version: 99,
			expectedVersion: 1,
			expectedWorkingCopyHash,
		}),
	).rejects.toThrow("not found");
	expect(await deps.store.read("run")).toEqual(before);
});

it("snapshots edits and answers, then approves with retryable cleanup", async () => {
	const questionPlan = {
		...plan,
		openQuestions: [{ id: "q", question: "Why?" }],
	};
	const { deps, input } = await setup([envelope(questionPlan), ...clean()]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	await writeFile(path, "# Edited\n## Phase 1 — One phase\n");
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

it("does not overwrite an edit made while approval cleans up", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	const handle = await start(deps, input);
	const path = join(deps.dataDir, "runs", "run", "plan.md");
	deps.workspace.remove = async () => {
		await writeFile(path, "# Concurrent edit\n");
	};
	await approve(handle);
	expect(await readFile(path, "utf8")).toBe("# Concurrent edit\n");
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
	const dataDir = await mkdtemp(join(tmpdir(), "factory-"));
	const deps = {
		newId: (): string => crypto.randomUUID(),
		store: createMemoryRunStore(),
		runner,
		limiter: createLimiter(1),
		workItems: fakeWorkItems([
			{
				origin: { source: "jira", key: "T", url: null },
				title: "Ticket",
				description: "",
			},
		]),
		workspace: fakeWorkspace("/workspace"),
		dataDir,
		readPlan: (runId: string) => readPlan(dataDir, runId),
		writePlan: (runId: string, markdown: string) =>
			writePlan(dataDir, runId, markdown),
		roleSources,
	};
	const input = {
		runId: "run",
		workItemRequest: { source: "jira" as const, key: "T" },
		repo: "repo",
		baseBranch: "main",
		roles,
		maxConcurrentAgents: 1,
		signal: new AbortController().signal,
	};
	return { deps, input, runner };
}
it("resolves the Jira request and checkpoints the work item before planner input", async () => {
	const { deps, input, runner } = await setup([envelope(plan), ...clean()]);
	const requests: unknown[] = [];
	const resolve = deps.workItems.resolve;
	deps.workItems.resolve = async (request) => {
		requests.push(request);
		return resolve(request);
	};
	const handle = await start(deps, input);

	expect(requests).toEqual([{ source: "jira", key: "T" }]);
	expect(handle.checkpoint.workItem).toEqual({
		origin: { source: "jira", key: "T", url: null },
		title: "Ticket",
		description: "",
	});
	const planner = runner.calls[0];
	expect(planner?.inputs.map((item) => item.name)).toContain("work-item");
	const workItemInput = planner?.inputs.find(
		(item) => item.name === "work-item",
	);
	if (!workItemInput) throw new Error("missing work-item planner input");
	expect(
		JSON.parse(
			new TextDecoder().decode(
				await deps.store.readArtifact(workItemInput.ref.sha256),
			),
		),
	).toEqual(handle.checkpoint.workItem);
	const events = await deps.store.read(input.runId);
	const itemEvent = events.findIndex(
		(event) =>
			event.type === "artifact.recorded" &&
			event.artifact.kind === "factory-work-item-v1",
	);
	const plannerEvent = events.findIndex(
		(event) => event.type === "attempt.started" && event.role === "planner",
	);
	expect(itemEvent).toBeGreaterThanOrEqual(0);
	expect(itemEvent).toBeLessThan(plannerEvent);
});

it("begins at ResolveWorkItem without runner calls and executes the same handle to approval", async () => {
	const { deps, input, runner } = await setup([envelope(plan), ...clean()]);
	const { signal, ...startInput } = input;
	const handle = await beginFactory(deps, startInput);
	expect(handle.checkpoint.stage).toBe("ResolveWorkItem");
	expect(runner.calls).toHaveLength(0);
	expect(await deps.store.listRunIds()).toEqual(["run"]);

	await executeFactory(handle, { signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(runner.calls).toHaveLength(9);
	for (const call of runner.calls)
		expect(call.instructions).toContain(QUALITY_EXPECTATIONS);
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
	expect(runner.calls[1]?.roleSpecSha).toMatch(/^[0-9a-f]{64}$/);
	expect(runner.calls[1]?.roleSpecSha).not.toBe("changed-sha");
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

it("escalates a work-item resolution failure and resumes the same stage", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	deps.workItems.resolve = async () => {
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
	deps.workItems = fakeWorkItems([
		{
			origin: { source: "jira", key: "T", url: null },
			title: "Ticket",
			description: "",
		},
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

it("uses the supplied ID generator for workflow steps", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean()]);
	let next = 0;
	deps.newId = () => `injected-${++next}`;
	await start(deps, input);
	const events = await deps.store.read(input.runId);
	expect(
		events.some(
			(event) => event.type === "step.started" && event.stepId === "injected-1",
		),
	).toBe(true);
});
