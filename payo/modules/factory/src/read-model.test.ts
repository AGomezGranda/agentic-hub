import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@payo/contracts";
import {
	type AgentRunner,
	createLimiter,
	createMemoryRunStore,
	type MemoryBacking,
} from "@payo/kernel";
import { expect, it } from "vitest";
import { beginFactory, executeFactory, start } from "./commands.ts";
import { readRunReview } from "./read-model.ts";

const plan = {
	markdown: "# Snapshot plan\n",
	prStrategy: [{ id: "pr", title: "One", phases: [] }],
	openQuestions: [{ id: "q1", question: "Why this approach?" }],
};
const finding = {
	id: "security-1",
	severity: "P1",
	title: "Check the boundary",
	path: "src/app.ts",
	line: 4,
	evidence: "The input is trusted.",
	consequence: "Untrusted text could execute.",
	suggestedFix: "Validate input.",
};
const finalReviewScripts = [
	envelope(plan),
	envelope({ findings: [finding] }),
	...Array.from({ length: 6 }, () => envelope({ findings: [] })),
	envelope({
		verdicts: [
			{
				sourceIds: [finding.id],
				classification: "NON-BLOCKER",
				severity: "P1",
				reason: "Outside this slice.",
				counterEvidence: null,
			},
		],
	}),
];

type FakeStep =
	| { kind: "emit"; event: AgentEvent }
	| { kind: "throw"; message: string }
	| { kind: "hang" };

function envelope(value: unknown): FakeStep[] {
	return [
		{ kind: "emit", event: { type: "result", text: JSON.stringify(value) } },
	];
}

function createFakeRunner(scripts: readonly FakeStep[][]): AgentRunner {
	let session = 0;
	return {
		id: "fake",
		async *run(_spec, signal) {
			const script = scripts[session++];
			if (!script) throw new Error("missing fake script");
			for (const step of script) {
				if (step.kind === "throw") throw new Error(step.message);
				if (step.kind === "hang") {
					await new Promise<void>((resolve) => {
						if (signal.aborted) resolve();
						else
							signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return;
				}
				yield step.event;
			}
		},
	};
}

async function setup(scripts: readonly FakeStep[][], execute = true) {
	const backing: MemoryBacking = { events: new Map(), artifacts: new Map() };
	const store = createMemoryRunStore(backing);
	const dataDir = await mkdtemp(join(tmpdir(), "factory-read-model-"));
	const source = {
		path: "skills/plan/SKILL.md",
		sha: "source-sha",
		content: "role",
		resources: {},
	};
	const deps = {
		store,
		runner: createFakeRunner(scripts),
		limiter: createLimiter(1),
		workItems: {
			async resolve(request: { source: string; key?: string }) {
				if (request.source !== "jira" || request.key !== "T")
					throw new Error("unexpected work item");
				return {
					origin: { source: "jira" as const, key: "T", url: null },
					title: "Ticket",
					description: "",
				};
			},
		},
		workspace: {
			async create(runId: string) {
				return `/workspace/${runId}`;
			},
			async remove() {},
		},
		dataDir,
		roleSources: {
			planner: source,
			reviewer: source,
			verifier: source,
			reviser: source,
		},
	};
	const input = {
		runId: "run",
		workItemRequest: { source: "jira" as const, key: "T" },
		repo: "/repo",
		baseBranch: "main",
		roles: {
			planner: { model: null, timeoutMs: 1000 },
			reviewer: { model: null, timeoutMs: 1000 },
			verifier: { model: null, timeoutMs: 1000 },
			reviser: { model: null, timeoutMs: 1000 },
		},
		maxConcurrentAgents: 1,
	};
	const handle = execute
		? await start(deps, { ...input, signal: new AbortController().signal })
		: await beginFactory(deps, input);
	return { handle, backing, dataDir, deps };
}

it("uses the latest validated snapshot before an approval or escalation gate", async () => {
	const scripts = [
		envelope(plan),
		...Array.from({ length: 7 }, () => envelope({ findings: [] })),
		[{ kind: "hang" as const }],
	];
	const { handle, dataDir, deps } = await setup(scripts, false);
	const controller = new AbortController();
	const execution = executeFactory(handle, { signal: controller.signal });
	try {
		const deadline = Date.now() + 5000;
		let reviewSaved = false;
		while (Date.now() < deadline) {
			const events = await deps.store.read("run");
			reviewSaved = events.some(
				(event) =>
					event.type === "artifact.recorded" &&
					event.artifact.kind === "factory-review-input-v1",
			);
			if (reviewSaved) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(reviewSaved).toBe(true);
		const planPath = join(dataDir, "runs", "run", "plan.md");
		await mkdir(join(dataDir, "runs", "run"), { recursive: true });
		await writeFile(planPath, "# Not yet reviewed\n");

		const result = await readRunReview(handle);
		expect(result.plan).toEqual({
			available: true,
			markdown: plan.markdown,
			editorPath: null,
			questions: plan.openQuestions,
		});
	} finally {
		controller.abort();
		await execution.catch(() => {});
	}
});

it("projects the checked working plan, answers, and validated review findings", async () => {
	const { handle, dataDir } = await setup(finalReviewScripts);
	const planPath = join(dataDir, "runs", "run", "plan.md");
	await writeFile(planPath, "# External edit\n");

	const result = await readRunReview(handle);
	expect(result.plan).toEqual({
		available: true,
		markdown: "# External edit\n",
		editorPath: planPath,
		questions: plan.openQuestions,
	});
	expect(result.answers).toEqual({});
	expect(result.review).toEqual({
		available: true,
		findings: [finding],
		uncheckedLenses: [],
		verdicts: [
			{
				sourceIds: [finding.id],
				classification: "NON-BLOCKER",
				severity: "P1",
				reason: "Outside this slice.",
				counterEvidence: null,
			},
		],
		provenance: "unknown",
	});
});

it("returns unchecked lenses and null verdicts for an input-only review artifact", async () => {
	const scripts = [
		envelope(plan),
		[{ kind: "throw" as const, message: "review unavailable" }],
		[{ kind: "throw" as const, message: "review unavailable" }],
		...Array.from({ length: 6 }, () => envelope({ findings: [] })),
		[
			{
				kind: "emit" as const,
				event: { type: "error" as const, message: "verifier unavailable" },
			},
		],
		[
			{
				kind: "emit" as const,
				event: { type: "error" as const, message: "verifier unavailable" },
			},
		],
	];
	const { handle } = await setup(scripts);
	const result = await readRunReview(handle);

	expect(handle.checkpoint.stage).toBe("Escalated");
	expect(result.review).toMatchObject({
		available: true,
		findings: [],
		verdicts: null,
		provenance: "unknown",
	});
	if (!result.review.available) throw new Error("review should be available");
	expect(result.review.uncheckedLenses.length).toBeGreaterThan(0);
});

it("does not fall back to a plan snapshot when the gate file is missing or unsafe", async () => {
	const { handle, dataDir } = await setup(finalReviewScripts);
	const planPath = join(dataDir, "runs", "run", "plan.md");
	await unlink(planPath);
	expect((await readRunReview(handle)).plan).toEqual({
		available: false,
		reason: "missing",
	});

	await symlink("/etc/passwd", planPath);
	expect((await readRunReview(handle)).plan).toEqual({
		available: false,
		reason: "unsafe",
	});
});

it("reports missing and corrupt review artifacts without exposing storage details", async () => {
	const missing = await setup(finalReviewScripts);
	const missingRef = missing.handle.checkpoint.review;
	if (!missingRef) throw new Error("expected review reference");
	missing.backing.artifacts.delete(missingRef.sha256);
	expect((await readRunReview(missing.handle)).review).toEqual({
		available: false,
		reason: "missing",
	});

	const corrupt = await setup(finalReviewScripts);
	const corruptRef = corrupt.handle.checkpoint.review;
	if (!corruptRef) throw new Error("expected review reference");
	corrupt.backing.artifacts.set(
		corruptRef.sha256,
		new TextEncoder().encode("{}"),
	);
	expect((await readRunReview(corrupt.handle)).review).toEqual({
		available: false,
		reason: "invalid",
	});
});

it("reports missing or checksum-invalid plan artifacts as unavailable", async () => {
	const { handle, backing } = await setup(finalReviewScripts);
	const ref = handle.checkpoint.plan;
	if (!ref) throw new Error("expected plan reference");
	backing.artifacts.delete(ref.sha256);
	expect((await readRunReview(handle)).plan).toEqual({
		available: false,
		reason: "missing",
	});

	const reopened = await setup(finalReviewScripts);
	const reopenedRef = reopened.handle.checkpoint.plan;
	if (!reopenedRef) throw new Error("expected plan reference");
	const bytes = reopened.backing.artifacts.get(reopenedRef.sha256);
	if (!bytes) throw new Error("expected plan artifact bytes");
	reopened.backing.artifacts.set(
		reopenedRef.sha256,
		new TextEncoder().encode("{}"),
	);
	expect((await readRunReview(reopened.handle)).plan).toEqual({
		available: false,
		reason: "invalid",
	});
});
