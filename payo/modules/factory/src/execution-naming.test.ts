import type { WorkItem } from "@payo/contracts";
import { commit, createMemoryRunStore, startRun } from "@payo/kernel";
import { expect, it, vi } from "vitest";
import { savePlanVersion, storeCheckpoint } from "./artifacts.ts";
import {
	beginExecution,
	previewExecutionNaming,
	validatePublicationPolicy,
} from "./index.ts";

async function fixture(
	options: { approved?: boolean; title?: string; description?: string } = {},
) {
	const store = createMemoryRunStore();
	const role = { model: null, timeoutMs: 1000 };
	const artifact = {
		sha256: "a".repeat(64),
		size: 1,
		kind: "role",
		mediaType: "text/plain",
	};
	const provenance = { path: "role", sha: "sha" };
	const state = await startRun(store, {
		runId: "source",
		repo: "/repo",
		baseBranch: "main",
		config: {
			factory: {
				roles: { planner: role, reviewer: role, verifier: role, reviser: role },
				roleArtifacts: {
					planner: artifact,
					reviewer: artifact,
					verifier: artifact,
					reviser: artifact,
				},
				roleProvenance: {
					planner: provenance,
					reviewer: provenance,
					verifier: provenance,
					reviser: provenance,
				},
				lenses: ["architecture"],
				maxConcurrentAgents: 1,
				workItemRequest: {
					source: "prompt",
					artifact: {
						sha256: "a".repeat(64),
						size: 1,
						kind: "prompt",
						mediaType: "text/plain",
					},
				},
			},
		},
	});
	const saved = await savePlanVersion(store, {
		number: 1,
		source: "human",
		answers: {},
		plan: {
			markdown: "# Plan\n\n## Phase 1\nAdd a thing.\n\nAcceptance: works.",
			prStrategy: [
				{
					id: "pr-1",
					title: options.title ?? "Create todo entity",
					phases: ["Phase 1"],
				},
			],
			openQuestions: [],
		},
	});
	const ref = saved[1];
	if (ref?.type !== "artifact.recorded") throw new Error("missing plan");
	const workItem: WorkItem = {
		origin: { source: "prompt" },
		title: "Unrelated title",
		description: options.description ?? "Implement A2_B-003; repeat A2_B-003",
	};
	await commit(store, state, [
		...saved,
		await storeCheckpoint(store, {
			revision: 0,
			stage: "Approved",
			cycle: 1,
			round: 0,
			workItem,
			workspace: null,
			plan: ref.artifact,
			lastAgentPlan: ref.artifact,
			answers: {},
			review: null,
			approvalMetric: null,
			inFlight: null,
		}),
		...(options.approved === false
			? []
			: [{ type: "run.ended" as const, outcome: "approved" }]),
	]);
	let base = "base-one";
	const resolveBase = vi.fn(async () => base);
	const deps = { store, workspace: { resolveBase } };
	const preview = (
		request = { prId: "pr-1" },
		policy = validatePublicationPolicy({}),
	) =>
		previewExecutionNaming(
			deps,
			"source",
			request,
			policy,
			new AbortController().signal,
		);
	return {
		store,
		preview,
		resolveBase,
		moveBase: () => {
			base = "base-two";
		},
	};
}

it("previews persisted source artifacts without creating an execution or workspace", async () => {
	const f = await fixture();
	const before = await f.store.read("source");
	const result = await f.preview();
	expect(result).toMatchObject({
		candidates: ["A2_B-003"],
		ticketId: "A2_B-003",
		slug: "create-todo-entity",
		branch: "A2_B-003/create-todo-entity",
		commitSubject: "[A2_B-003] Phase 1",
		prTitle: "[A2_B-003] Create todo entity",
		errors: {},
		previewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(await f.store.listRunIds()).toEqual(["source"]);
	expect(await f.store.read("source")).toEqual(before);
});
it("rejects an unapproved source and a nonexistent PR", async () => {
	await expect((await fixture({ approved: false })).preview()).rejects.toThrow(
		/not been approved/,
	);
	await expect(
		(await fixture()).preview({ prId: "missing" }),
	).rejects.toMatchObject({ code: "not_found" });
});
it("returns field errors without a valid fingerprint for ambiguous or short choices", async () => {
	const f = await fixture({ description: "ABC-1 DEF-2" });
	expect(await f.preview()).toMatchObject({
		candidates: ["ABC-1", "DEF-2"],
		errors: { ticketId: expect.any(String) },
	});
	expect((await f.preview()).previewHash).toBeUndefined();
	const short = await fixture({ title: "Fix bug" });
	expect(await short.preview()).toMatchObject({
		errors: { slug: expect.any(String) },
	});
	expect((await short.preview()).previewHash).toBeUndefined();
	const none = await previewExecutionNaming(
		{ store: short.store, workspace: { resolveBase: short.resolveBase } },
		"source",
		{ prId: "pr-1", ticketId: null },
		validatePublicationPolicy({}),
		new AbortController().signal,
	);
	expect(none.branch).toMatch(/^payo\//);
	expect(none.previewHash).toBeDefined();
});
it("binds preview hashes to approved plan, selected PR, base and effective policy", async () => {
	const f = await fixture();
	const first = await f.preview();
	expect((await f.preview()).previewHash).toBe(first.previewHash);
	f.moveBase();
	expect((await f.preview()).previewHash).not.toBe(first.previewHash);
	const changed = await f.preview(
		{ prId: "pr-1" },
		validatePublicationPolicy({ remote: "upstream" }),
	);
	expect(changed.previewHash).not.toBe((await f.preview()).previewHash);
	expect(
		(await (await fixture({ title: "Create another todo entity" })).preview())
			.previewHash,
	).not.toBe(first.previewHash);
});

it("requires a current confirmed naming snapshot before accepting a new execution", async () => {
	const f = await fixture();
	const deps = {
		store: f.store,
		newId: () => crypto.randomUUID(),
		workspace: { resolveBase: f.resolveBase },
	};
	const input = {
		sourceRunId: "source",
		prId: "pr-1",
		checks: [{ name: "test", command: "test", args: [], timeout_ms: 1000 }],
		roles: {},
		roleArtifacts: {},
		roleProvenance: {},
		maxConcurrentAgents: 1,
	};
	await expect(
		beginExecution(
			deps as unknown as Parameters<typeof beginExecution>[0],
			input,
		),
	).rejects.toThrow(/confirmation/);
	const preview = await f.preview();
	const naming = {
		previewHash: preview.previewHash!,
		ticketId: preview.ticketId!,
		slug: preview.slug,
	};
	const handle = await beginExecution(
		deps as unknown as Parameters<typeof beginExecution>[0],
		{ ...input, naming },
	);
	expect(handle.log.current().config.factory).toMatchObject({
		naming: { version: 1, branch: "A2_B-003/create-todo-entity" },
	});
	await expect(
		beginExecution(deps as unknown as Parameters<typeof beginExecution>[0], {
			...input,
			naming: { ...naming, slug: "choose-another-branch" },
		}),
	).rejects.toThrow(/already exists/);
	const stale = await fixture();
	const old = await stale.preview();
	stale.moveBase();
	await expect(
		beginExecution(
			{
				...deps,
				store: stale.store,
				workspace: { resolveBase: stale.resolveBase },
			} as unknown as Parameters<typeof beginExecution>[0],
			{ ...input, naming: { ...naming, previewHash: old.previewHash! } },
		),
	).rejects.toThrow(/stale/);
});
