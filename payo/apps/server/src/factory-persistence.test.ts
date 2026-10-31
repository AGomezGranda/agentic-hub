import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, approve, openFactory, resume, start } from "@payo/factory";
import { createLimiter } from "@payo/kernel";
import { createSqliteRunStore } from "@payo/store-sqlite";
import { expect, it } from "vitest";
import {
	createFakeRunner,
	envelope,
	fakeTickets,
	fakeWorkspace,
} from "./factory-fixtures.ts";

const plan = {
	markdown: "# Agent plan\n",
	prStrategy: [{ id: "pr", title: "One", phases: [] }],
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
		ticketKey: "T",
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
		store,
		runner: createFakeRunner(scripts),
		limiter: createLimiter(1),
		tickets: fakeTickets([
			{ key: "T", title: "Ticket", description: "", url: null },
		]),
		workspace: fakeWorkspace("/workspace"),
		dataDir,
		roleSources,
	};
	return { deps, input, path: join(dataDir, "runs", "run", "plan.md") };
}

it("reopens edited approval and retains its original and final artifacts", async () => {
	const { deps, input, path } = await setup();
	let handle = await start(deps, input);
	const agentRef = handle.checkpoint.lastAgentPlan;
	if (!agentRef) throw new Error("missing agent plan");
	await writeFile(path, "# Human edit\n");
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
