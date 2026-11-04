import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionCheckpoint, ExecutionRunConfig } from "@payo/contracts";
import {
	answer,
	approve,
	beginExecution,
	openExecution,
	openFactory,
	resume,
	start,
} from "@payo/factory";
import { createLimiter } from "@payo/kernel";
import { createSqliteRunStore } from "@payo/store-sqlite";
import { expect, it } from "vitest";
import {
	createFakeRunner,
	envelope,
	fakeWorkItems,
	fakeWorkspace,
} from "./factory-fixtures.ts";

const plan = {
	markdown: "# Agent plan\n## Phase 1 — One phase\n",
	prStrategy: [{ id: "pr", title: "One", phases: ["One phase"] }],
	openQuestions: [{ id: "q", question: "Why?" }],
};
const clean = () => [
	...Array.from({ length: 7 }, () => envelope({ findings: [] })),
	envelope({ verdicts: [] }),
];
async function setup(scripts = [envelope(plan), ...clean()]) {
	const dataDir = await mkdtemp(join(tmpdir(), "factory-sqlite-"));
	const store = await createSqliteRunStore({ dataDir });
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
	const config = { model: null, timeoutMs: 1000 };
	const input = {
		runId: "run",
		workItemRequest: { source: "jira" as const, key: "T" },
		repo: "repo",
		baseBranch: "main",
		roles: {
			planner: config,
			reviewer: config,
			verifier: config,
			reviser: config,
		},
		maxConcurrentAgents: 1,
		signal: new AbortController().signal,
	};
	const deps = {
		newId: () => crypto.randomUUID(),
		store,
		runner: createFakeRunner(scripts),
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
		roleSources,
	};
	return { deps, input, path: join(dataDir, "runs", "run", "plan.md") };
}

it("reopens and resumes a legacy Jira config and FetchTicket checkpoint", async () => {
	const { deps, input } = await setup();
	const role = { model: null, timeoutMs: 1_000 };
	const roleSource = {
		path: "skills/plan/SKILL.md",
		sha: "123456",
		content: "skill",
		resources: {},
	};
	const roleArtifact = await deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify(roleSource)),
		{ kind: "factory-role-source-v1", mediaType: "application/json" },
	);
	const roles = {
		planner: role,
		reviewer: role,
		verifier: role,
		reviser: role,
	};
	const roleArtifacts = {
		planner: roleArtifact,
		reviewer: roleArtifact,
		verifier: roleArtifact,
		reviser: roleArtifact,
	};
	const roleProvenance = {
		planner: { path: roleSource.path, sha: roleSource.sha },
		reviewer: { path: roleSource.path, sha: roleSource.sha },
		verifier: { path: roleSource.path, sha: roleSource.sha },
		reviser: { path: roleSource.path, sha: roleSource.sha },
	};
	const legacyCheckpoint = {
		revision: 1,
		stage: "FetchTicket",
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
	const checkpointArtifact = await deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify(legacyCheckpoint)),
		{ kind: "factory-checkpoint-v1", mediaType: "application/json" },
	);
	await deps.store.append(
		input.runId,
		[
			{
				type: "run.created",
				runId: input.runId,
				repo: input.repo,
				baseBranch: input.baseBranch,
				config: {
					factory: {
						ticketKey: "T",
						roles,
						maxConcurrentAgents: 1,
						roleArtifacts,
						lenses: ["architecture"],
						roleProvenance,
					},
				},
			},
			...Object.values(roleArtifacts).map((artifact) => ({
				type: "artifact.recorded" as const,
				artifact,
				attemptId: null,
			})),
			{
				type: "artifact.recorded",
				artifact: checkpointArtifact,
				attemptId: null,
			},
		],
		0,
	);
	await deps.store.close();
	deps.store = await createSqliteRunStore({ dataDir: deps.dataDir });
	const reopened = await openFactory(deps, input.runId);
	expect(reopened.checkpoint.stage).toBe("Escalated");
	await resume(reopened, { signal: input.signal });
	expect(reopened.checkpoint).toMatchObject({
		stage: "Approval",
		workItem: {
			origin: { source: "jira", key: "T", url: null },
			title: "Ticket",
		},
	});
	await deps.store.close();
});

it("persists prompt requests by artifact reference across SQLite reopen", async () => {
	const { deps, input } = await setup();
	const text = "  Build a strict todo service.\nKeep this exact.  ";
	deps.workItems = {
		async resolve(request) {
			if (request.source !== "prompt") throw new Error("expected prompt");
			return {
				origin: { source: "prompt" },
				title: "Direct prompt",
				description: request.text,
			};
		},
	};
	await start(deps, {
		...input,
		workItemRequest: { source: "prompt", text },
	});
	const created = (await deps.store.read("run")).find(
		(event) => event.type === "run.created",
	);
	if (created?.type !== "run.created") throw new Error("missing run.created");
	const config = created.config.factory as {
		workItemRequest: { source: "prompt"; artifact: { sha256: string } };
	};
	expect(config.workItemRequest.source).toBe("prompt");
	expect(JSON.stringify(created.config)).not.toContain(text);
	await deps.store.close();
	deps.store = await createSqliteRunStore({ dataDir: deps.dataDir });
	const recovered = new TextDecoder().decode(
		await deps.store.readArtifact(config.workItemRequest.artifact.sha256),
	);
	expect(recovered).toBe(text);
	await deps.store.close();
});

it("reopens edited approval and retains its original and final artifacts", async () => {
	const { deps, input, path } = await setup();
	let handle = await start(deps, input);
	const agentRef = handle.checkpoint.lastAgentPlan;
	if (!agentRef) throw new Error("missing agent plan");
	await writeFile(path, "# Human edit\n## Phase 1 — One phase\n");
	await answer(handle, { questionId: "q", text: "Because" });
	await deps.store.close();
	deps.store = await createSqliteRunStore({ dataDir: deps.dataDir });
	handle = await openFactory(deps, "run");
	expect(handle.checkpoint.answers).toEqual({ q: "Because" });
	await approve(handle);
	if (!handle.checkpoint.approvalMetric) throw new Error("missing metric");
	expect(await readFile(path, "utf8")).toContain("# Human edit\n");
	expect(await readFile(path, "utf8")).toContain("Because");
	const metric = JSON.parse(
		new TextDecoder().decode(
			await deps.store.readArtifact(handle.checkpoint.approvalMetric.sha256),
		),
	);
	const original = JSON.parse(
		new TextDecoder().decode(await deps.store.readArtifact(agentRef.sha256)),
	);
	const lines = original.plan.markdown.split("\n");
	lines.splice(metric.prefixLines, metric.removed.length, ...metric.added);
	expect(lines.join("\n")).toBe(await readFile(path, "utf8"));
	expect(
		[...handle.log.current().gates.values()].every(
			(gate) => gate.status !== "open",
		),
	).toBe(true);
	expect(
		[...handle.log.current().steps.values()].every(
			(step) => step.status !== "running",
		),
	).toBe(true);
	await deps.store.close();
});

it("recovers multiple interrupted review steps and refuses an unrelated gate", async () => {
	const { deps, input } = await setup([envelope(plan), ...clean(), ...clean()]);
	const handle = await start(deps, input);
	const gate = [...handle.log.current().gates.values()].find(
		(item) => item.status === "open",
	);
	if (!gate) throw new Error("missing approval gate");
	const interrupted = {
		...handle.checkpoint,
		revision: handle.checkpoint.revision + 1,
		stage: "PlanReview",
		inFlight: { stage: "PlanReview", stepIds: ["lens-a", "lens-b"] },
	};
	const ref = await deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify(interrupted)),
		{ kind: "factory-checkpoint-v1", mediaType: "application/json" },
	);
	await deps.store.append(
		"run",
		[
			{
				type: "gate.resolved",
				gateId: gate.gateId,
				command: "requestChanges",
				note: null,
			},
			{ type: "step.finished", stepId: gate.stepId, outcome: "succeeded" },
			{ type: "step.started", stepId: "lens-a", name: "review:a" },
			{ type: "step.started", stepId: "lens-b", name: "review:b" },
			{
				type: "attempt.started",
				attemptId: "attempt-a",
				stepId: "lens-a",
				role: "reviewer",
				runner: "fake",
				model: null,
				roleSpecSha: null,
				inputArtifacts: [],
			},
			{
				type: "attempt.started",
				attemptId: "attempt-b",
				stepId: "lens-b",
				role: "reviewer",
				runner: "fake",
				model: null,
				roleSpecSha: null,
				inputArtifacts: [],
			},
			{ type: "step.started", stepId: "other", name: "other" },
			{
				type: "gate.raised",
				gateId: "other",
				stepId: "other",
				kind: "other",
				allowedCommands: ["retry"],
				reason: "other",
			},
			{ type: "artifact.recorded", artifact: ref, attemptId: null },
		],
		handle.log.current().lastSeq,
	);
	await deps.store.close();
	deps.store = await createSqliteRunStore({ dataDir: deps.dataDir });
	const reopened = await openFactory(deps, "run");
	// A recovered run exposes its interrupted attempts and gates before resume closes them.
	expect(reopened.log.current().attempts.get("attempt-a")?.status).toBe(
		"interrupted",
	);
	expect(reopened.log.current().attempts.get("attempt-b")?.status).toBe(
		"interrupted",
	);
	expect(
		reopened.log.current().gates.get("interrupted:attempt-a")?.status,
	).toBe("open");
	expect(reopened.log.current().steps.get("lens-a")?.status).toBe("running");
	await expect(resume(reopened, { signal: input.signal })).rejects.toThrow(
		"unrelated open gate",
	);
	await deps.store.append(
		"run",
		[
			{ type: "gate.resolved", gateId: "other", command: "retry", note: null },
			{ type: "step.finished", stepId: "other", outcome: "failed" },
		],
		reopened.log.current().lastSeq,
	);
	const resumed = await openFactory(deps, "run");
	await resume(resumed, { signal: input.signal });
	expect(resumed.checkpoint.stage).toBe("Approval");
	expect(resumed.log.current().steps.get("lens-a")?.status).toBe("failed");
	expect(resumed.log.current().steps.get("lens-b")?.status).toBe("failed");
	expect(
		[...resumed.log.current().gates.values()]
			.filter((item) => item.status === "open")
			.map((item) => item.kind),
	).toEqual(["approval"]);
	await deps.store.close();
});

it("leaves approval open for a missing or ambiguous working copy", async () => {
	const { deps, input, path } = await setup();
	const handle = await start(deps, input);
	await answer(handle, { questionId: "q", text: "yes" });
	await unlink(path);
	await expect(approve(handle)).rejects.toThrow();
	await writeFile(path, "<!-- factory answers start --> broken");
	await expect(approve(handle)).rejects.toThrow("ambiguous");
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(
		[...handle.log.current().gates.values()].some(
			(gate) => gate.status === "open",
		),
	).toBe(true);
	await deps.store.close();
});

it("reopens an escalation and resumes only when requested", async () => {
	const { deps, input } = await setup([
		[{ kind: "throw", message: "failed" }],
		envelope(plan),
		...clean(),
	]);
	await start(deps, input);
	await deps.store.close();
	deps.store = await createSqliteRunStore({ dataDir: deps.dataDir });
	const handle = await openFactory(deps, "run");
	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(deps.runner.calls).toHaveLength(1);
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	await deps.store.close();
});

it("reopens an accepted phase receipt and gates before the next writer", async () => {
	const approvedPlan = {
		markdown:
			"# Plan\n\n## Phase 1\nFoundation.\nAcceptance: foundation works.\n\n## Phase 2\nIntegration.\nAcceptance: integration works.\n",
		prStrategy: [
			{
				id: "pr-multi",
				title: "Two phases",
				phases: ["Foundation", "Integration"],
			},
		],
		openQuestions: [{ id: "q", question: "Why?" }],
	};
	const { deps, input } = await setup([envelope(approvedPlan), ...clean()]);
	const source = await start(deps, input);
	await answer(source, { questionId: "q", text: "Independent phases." });
	await approve(source);
	const sourceEvents = await deps.store.read("run");

	const roleNames = [
		"preparer",
		"implementer",
		"scout",
		"reviewer",
		"verifier",
	];
	const roleArtifacts: Record<
		string,
		Awaited<ReturnType<typeof deps.store.putArtifact>>
	> = {};
	const roles: Record<string, { model: string | null; timeoutMs: number }> = {};
	const roleProvenance: Record<string, { path: string; sha: string }> = {};
	for (const role of roleNames) {
		const sourceRole = {
			path: `skills/${role}.md`,
			sha: `sha-${role}`,
			content: `${role} instructions`,
			resources: {},
		};
		roleArtifacts[role] = await deps.store.putArtifact(
			new TextEncoder().encode(JSON.stringify(sourceRole)),
			{ kind: "factory-role-source-v1", mediaType: "application/json" },
		);
		roles[role] = { model: null, timeoutMs: 1_000 };
		roleProvenance[role] = { path: sourceRole.path, sha: sourceRole.sha };
	}
	const execution = await beginExecution(
		{ store: deps.store, newId: () => crypto.randomUUID() },
		{
			sourceRunId: "run",
			prId: "pr-multi",
			baseCommit: "base-commit",
			checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1_000 }],
			roles,
			roleArtifacts,
			roleProvenance,
			maxConcurrentAgents: 2,
		},
	);
	const runId = execution.log.current().runId;
	const config = ExecutionRunConfig.parse(
		execution.log.current().config.factory,
	);
	const manifest = await deps.store.putArtifact(
		new TextEncoder().encode(
			JSON.stringify({
				pr: { id: "pr-multi", title: "Two phases" },
				phases: [
					{
						id: "phase-1",
						title: "Foundation",
						planExcerpt: "## Phase 1\nFoundation.",
						acceptanceCriteria: ["Acceptance: foundation works."],
					},
					{
						id: "phase-2",
						title: "Integration",
						planExcerpt: "## Phase 2\nIntegration.",
						acceptanceCriteria: ["Acceptance: integration works."],
					},
				],
				prerequisites: [],
				issues: [],
			}),
		),
		{ kind: "factory-execution-manifest-v1", mediaType: "application/json" },
	);
	const putEvidence = (kind: string) =>
		deps.store.putArtifact(new TextEncoder().encode("{}"), {
			kind,
			mediaType: "application/json",
		});
	const [report, checks, review] = await Promise.all([
		putEvidence("factory-execution-implementation-report-v1"),
		putEvidence("factory-execution-check-results-v1"),
		putEvidence("factory-execution-review-v1"),
	]);
	const receipt = await deps.store.putArtifact(
		new TextEncoder().encode(
			JSON.stringify({
				phaseId: "phase-1",
				phaseIndex: 0,
				planHash: config.plan.sha256,
				startCommit: "base-commit",
				resultCommit: "phase-one-commit",
				report,
				checks,
				review,
				summary: "Foundation complete",
				acceptedCriteria: ["Acceptance: foundation works."],
				deviations: [],
			}),
		),
		{
			kind: "factory-execution-phase-receipt-v1",
			mediaType: "application/json",
		},
	);
	const originalEvents = await deps.store.read(runId);
	const checkpointEvent = originalEvents.findLast(
		(event) =>
			event.type === "artifact.recorded" &&
			event.artifact.kind === "factory-execution-checkpoint-v1",
	);
	if (checkpointEvent?.type !== "artifact.recorded")
		throw new Error("initial execution checkpoint is missing");
	const initial = ExecutionCheckpoint.parse(
		JSON.parse(
			new TextDecoder().decode(
				await deps.store.readArtifact(checkpointEvent.artifact.sha256),
			),
		),
	);
	const next = ExecutionCheckpoint.parse({
		...initial,
		revision: initial.revision + 1,
		stage: "Implement",
		phaseIndex: 1,
		scope: "phase",
		manifest,
		workspace: {
			path: join(deps.dataDir, "worktrees", runId),
			branch: `payo/${runId}`,
			baseCommit: config.baseCommit,
			head: "phase-one-commit",
			fingerprint: "phase-one-snapshot",
			historyFingerprint: "phase-one-history",
		},
		receipts: [receipt],
	});
	const nextCheckpoint = await deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify(next)),
		{ kind: "factory-execution-checkpoint-v1", mediaType: "application/json" },
	);
	await deps.store.append(
		runId,
		[
			{ type: "artifact.recorded", artifact: manifest, attemptId: null },
			{ type: "artifact.recorded", artifact: receipt, attemptId: null },
			{ type: "artifact.recorded", artifact: nextCheckpoint, attemptId: null },
		],
		originalEvents.at(-1)?.seq ?? 0,
	);
	await deps.store.close();

	const reopenedStore = await createSqliteRunStore({ dataDir: deps.dataDir });
	try {
		const reopened = await openExecution(
			{ store: reopenedStore, newId: () => crypto.randomUUID() },
			runId,
		);
		expect(reopened.checkpoint).toMatchObject({
			stage: "Escalated",
			phaseIndex: 1,
			receipts: [receipt],
		});
		expect(reopened.log.current().attempts.size).toBe(0);
		expect(await reopenedStore.read("run")).toEqual(sourceEvents);
	} finally {
		await reopenedStore.close();
	}
});

it("does not advance when a completed planner's checkpoint batch fails", async () => {
	const { deps, input } = await setup([
		envelope(plan),
		envelope(plan),
		...clean(),
	]);
	const realStore = deps.store;
	let fail = true;
	deps.store = {
		...realStore,
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
				throw new Error("crash after artifact write");
			}
			return realStore.append(runId, events, seq);
		},
	};
	await expect(start(deps, input)).rejects.toThrow(
		"crash after artifact write",
	);
	await realStore.close();
	deps.store = await createSqliteRunStore({ dataDir: deps.dataDir });
	const handle = await openFactory(deps, "run");
	expect(handle.checkpoint).toMatchObject({ stage: "Escalated", plan: null });
	expect(deps.runner.calls).toHaveLength(1);
	await resume(handle, { signal: input.signal });
	expect(handle.checkpoint.stage).toBe("Approval");
	expect(
		deps.runner.calls.filter((call) => call.role === "planner"),
	).toHaveLength(2);
	await deps.store.close();
});
