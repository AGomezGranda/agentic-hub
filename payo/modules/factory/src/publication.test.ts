import { commit, createMemoryRunStore } from "@payo/kernel";
import { expect, it, vi } from "vitest";
import { initialExecutionCheckpoint } from "./domain/execution.ts";
import { validatePublicationPolicy } from "./domain/naming.ts";
import { storeExecutionCheckpoint } from "./execution-artifacts.ts";
import {
	beginPublication,
	executePublication,
	openPublication,
	preparePublicationResume,
	previewPublication,
} from "./publication.ts";

const base = "b".repeat(40),
	head = "a".repeat(40);
async function fixture() {
	const store = createMemoryRunStore();
	const json = async (value: unknown, kind: string) =>
		store.putArtifact(new TextEncoder().encode(JSON.stringify(value)), {
			kind,
			mediaType: "application/json",
		});
	const checks = await json(
		{ results: [{ name: "unit", status: "passed" }] },
		"factory-execution-checks-v1",
	);
	const review = await json({ checked: true }, "factory-execution-review-v1");
	const plan = await json({}, "plan");
	const report = await json({ summary: "Implemented feature" }, "report");
	const receipt = await json(
		{
			phaseId: "phase-1",
			phaseIndex: 0,
			planHash: plan.sha256,
			startCommit: base,
			resultCommit: head,
			report,
			checks,
			review,
			summary: "Create todo entity",
			acceptedCriteria: ["works"],
			deviations: [],
		},
		"factory-execution-phase-receipt-v1",
	);
	const manifest = await json(
		{
			pr: { id: "pr-1", title: "Create todo entity" },
			phases: [
				{
					id: "phase-1",
					title: "Create todo entity",
					planExcerpt: "Plan",
					acceptanceCriteria: ["works"],
				},
			],
			prerequisites: [],
			issues: [],
		},
		"factory-execution-manifest-v1",
	);
	const result = await json(
		{
			resultCommit: head,
			summary: "Reviewed feature",
			report,
			checks,
			review,
			phaseReceipts: [receipt],
		},
		"factory-execution-final-result-v1",
	);
	const naming = {
		version: 1,
		ticketId: "ABC-123",
		slug: "create-todo-entity",
		branch: "ABC-123/create-todo-entity",
		policy: validatePublicationPolicy({}),
	};
	await commit(store, null, [
		{
			type: "run.created",
			runId: "execution",
			repo: "/repo",
			baseBranch: "main",
			config: {
				factory: {
					kind: "factory-execution",
					sourceRunId: "source",
					sourceBaseBranch: "main",
					plan,
					prId: "pr-1",
					baseCommit: base,
					naming,
					checks: [
						{ name: "unit", command: "test", args: [], timeout_ms: 1000 },
					],
					roles: {},
					roleArtifacts: {},
					roleProvenance: {},
					maxConcurrentAgents: 1,
				},
			},
		},
		...[result, manifest].map((artifact) => ({
			type: "artifact.recorded" as const,
			artifact,
			attemptId: null,
		})),
		await storeExecutionCheckpoint(store, {
			...initialExecutionCheckpoint(),
			stage: "Completed",
			manifest,
			receipts: [receipt],
			workspace: {
				path: "/worktrees/execution",
				branch: naming.branch,
				baseCommit: base,
				head,
				fingerprint: "clean",
				historyFingerprint: "history",
			},
			evidence: { diff: null, checks, review },
		}),
		{ type: "run.ended", outcome: "reviewed" },
	]);
	const target = {
		host: "github.com" as const,
		owner: "org",
		name: "repo",
		repositoryId: "1",
		baseBranch: "main",
		baseCommit: base,
	};
	let remote: string | null = null;
	let prs: import("@payo/contracts").PullRequestRecord[] = [];
	const assertIntent = async (operation: string) => {
		const ids = (await store.listRunIds()).filter((id) => id !== "execution");
		expect(ids).toHaveLength(1);
		const event = (await store.read(ids[0]!)).findLast(
			(e) =>
				e.type === "artifact.recorded" &&
				e.artifact.kind === "factory-publication-checkpoint-v1",
		);
		if (event?.type !== "artifact.recorded") throw Error("missing intent");
		expect(
			JSON.parse(
				new TextDecoder().decode(
					await store.readArtifact(event.artifact.sha256),
				),
			).intent,
		).toBe(operation);
	};
	const repository = {
		resolveRemote: vi.fn(async () => ({
			fetchUrl: "git@github.com:org/repo.git",
			pushUrl: "git@github.com:org/repo.git",
		})),
		readCommits: vi.fn(async () => [
			{
				sha: head,
				subject: "[ABC-123] Create todo entity",
				message:
					"[ABC-123] Create todo entity\n\nPayo-Execution: execution/phase-1",
			},
		]),
		readRemoteHead: vi.fn(async () => remote),
		pushCommit: vi.fn(async () => {
			await assertIntent("Push");
			remote = head;
		}),
	};
	const codeHost = {
		resolveRepository: vi.fn(async () => target),
		findPullRequests: vi.fn(async () => prs),
		createDraftPullRequest: vi.fn(
			async (
				_target: typeof target,
				input: { headBranch: string; title: string; body: string },
			) => {
				await assertIntent("CreatePr");
				prs = [
					{
						number: 1,
						url: "https://github.com/org/repo/pull/1",
						owner: "org",
						name: "repo",
						baseBranch: "main",
						headBranch: input.headBranch,
						headCommit: head,
						state: "OPEN",
						draft: true,
						title: input.title,
						body: input.body,
					},
				];
			},
		),
	};
	const workspace = {
		inspect: vi.fn(async () => ({
			head,
			branch: naming.branch,
			fingerprint: "clean",
			historyFingerprint: "history",
			changedPaths: [],
		})),
	};
	const deps = {
		store,
		newId: () => crypto.randomUUID(),
		repository,
		codeHost,
		workspace,
	};
	return {
		deps,
		repository,
		codeHost,
		store,
		setRemote: (value: string | null) => {
			remote = value;
		},
		setPrs: (value: typeof prs) => {
			prs = value;
		},
	};
}
const signal = () => new AbortController().signal;
it("only explicit acceptance creates one child; intent precedes effects and parent stays ended", async () => {
	const f = await fixture();
	const before = await f.store.read("execution");
	const preview = await previewPublication(f.deps, "execution", signal());
	expect(preview.eligible).toBe(true);
	expect(await f.store.listRunIds()).toEqual(["execution"]);
	expect(f.repository.pushCommit).not.toHaveBeenCalled();
	const input = { previewHash: preview.previewHash! };
	const [a, b] = await Promise.all([
		beginPublication(f.deps, "execution", input, signal()),
		beginPublication(f.deps, "execution", input, signal()),
	]);
	expect(a.handle.log.current().runId).toBe(b.handle.log.current().runId);
	expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
	await executePublication(a.handle, { signal: signal() });
	expect(a.handle.log.current()).toMatchObject({
		status: "ended",
		outcome: "published",
	});
	expect(a.handle.log.current().attempts.size).toBe(0);
	expect(await f.store.read("execution")).toEqual(before);
	const repeated = await beginPublication(f.deps, "execution", input, signal());
	expect(repeated.created).toBe(false);
	await expect(
		beginPublication(
			f.deps,
			"execution",
			{ ...input, body: "different" },
			signal(),
		),
	).rejects.toThrow(/already/);
});
it.each(["push", "pr"])(
	"reconciles lost %s responses only after explicit resume",
	async (operation) => {
		const f = await fixture();
		const effect: import("vitest").Mock<(...args: unknown[]) => Promise<void>> =
			operation === "push"
				? f.repository.pushCommit
				: (f.codeHost
						.createDraftPullRequest as unknown as import("vitest").Mock<
						(...args: unknown[]) => Promise<void>
					>);
		const original = effect.getMockImplementation()!;
		effect.mockImplementationOnce(async (...args: unknown[]) => {
			await (original as (...a: unknown[]) => Promise<void>)(...args);
			throw Error("lost response");
		});
		const preview = await previewPublication(f.deps, "execution", signal());
		const accepted = await beginPublication(
			f.deps,
			"execution",
			{ previewHash: preview.previewHash! },
			signal(),
		);
		await executePublication(accepted.handle, { signal: signal() });
		expect(accepted.handle.checkpoint.stage).toBe("Escalated");
		const count = effect.mock.calls.length;
		const recovered = await openPublication(
			f.deps,
			accepted.handle.log.current().runId,
		);
		expect(effect.mock.calls).toHaveLength(count);
		await preparePublicationResume(recovered);
		await executePublication(recovered, { signal: signal() });
		expect(recovered.log.current().outcome).toBe("published");
		expect(effect.mock.calls).toHaveLength(count);
		expect(
			[...recovered.log.current().gates.values()].filter(
				(g) => g.status === "open",
			),
		).toEqual([]);
	},
);
it("gates an unowned equal branch and unknown query results without effects", async () => {
	const f = await fixture();
	const preview = await previewPublication(f.deps, "execution", signal());
	const accepted = await beginPublication(
		f.deps,
		"execution",
		{ previewHash: preview.previewHash! },
		signal(),
	);
	f.setRemote(head);
	await executePublication(accepted.handle, { signal: signal() });
	expect(accepted.handle.checkpoint.stage).toBe("Escalated");
	expect(f.repository.pushCommit).not.toHaveBeenCalled();
});
it("opening a child interrupted before its first step never schedules publication", async () => {
	const f = await fixture();
	const preview = await previewPublication(f.deps, "execution", signal());
	const accepted = await beginPublication(
		f.deps,
		"execution",
		{ previewHash: preview.previewHash! },
		signal(),
	);
	const reopened = await openPublication(
		f.deps,
		accepted.handle.log.current().runId,
	);
	expect(reopened.checkpoint.stage).toBe("Escalated");
	expect(f.repository.pushCommit).not.toHaveBeenCalled();
});
