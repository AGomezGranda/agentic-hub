import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePayoConfigDocument } from "@payo/config";
import {
	beginFactory,
	beginPublication,
	readPlan,
	writePlan,
} from "@payo/factory";
import {
	createLimiter,
	createMemoryRunStore,
	type RunStore,
	systemScheduler,
} from "@payo/kernel";
import { createSqliteRunStore } from "@payo/store-sqlite";
import { expect, it } from "vitest";
import { type AdapterSet, createAdapterSet } from "./adapters.ts";
import { createComposition, effectiveConcurrency } from "./composition.ts";
import type { ServerConfig } from "./config.ts";
import {
	createFakeRunner,
	envelope,
	fakeExecutionWorkspace,
	fakePublicationPorts,
	fakeWorkItems,
	fakeWorkspace,
} from "./factory-fixtures.ts";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		ghBin: "gh",
		publication: resolvePayoConfigDocument({}, {}, "/repo").publication,
		configFile: "/tmp/payo-composition/config.toml",
		dataDir: "/tmp/payo-composition",
		repo: "/repo",
		baseBranch: "main",
		maxConcurrentAgents: 4,
		webOrigins: [],
		checks: [],
		devFakes: true,
		scenario: "clean",
		port: 0,
		testMode: true,
		piBin: "pi",
		acliBin: "acli",
		gitBin: "git",
		piProvider: "anthropic",
		model: null,
		roles: {
			planner: { model: null, timeoutMs: 300_000 },
			reviewer: { model: null, timeoutMs: 300_000 },
			verifier: { model: null, timeoutMs: 300_000 },
			reviser: { model: null, timeoutMs: 300_000 },
		},
		...overrides,
	};
}

const roles = {
	planner: { model: null, timeoutMs: 1000 },
	reviewer: { model: null, timeoutMs: 1000 },
	verifier: { model: null, timeoutMs: 1000 },
	reviser: { model: null, timeoutMs: 1000 },
};

const source = {
	path: "synthetic/role.md",
	sha: "synthetic-sha",
	content: "synthetic role",
	resources: {},
};
const roleSources = {
	planner: source,
	reviewer: source,
	verifier: source,
	reviser: source,
};

const plan = {
	markdown: "# Plan\n## Phase 1 — One phase\n",
	prStrategy: [{ id: "pr", title: "One", phases: ["One phase"] }],
	openQuestions: [],
};

const cleanScript = () => [
	envelope(plan),
	...Array.from({ length: 7 }, () => envelope({ findings: [] })),
	envelope({ verdicts: [] }),
];

it("waits for run acceptance before closing the store during shutdown", async () => {
	const memory = createMemoryRunStore();
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let closed = false;
	const store: RunStore = {
		...memory,
		async putArtifact(...args) {
			entered();
			await held;
			if (closed) throw new Error("store closed during acceptance");
			return memory.putArtifact(...args);
		},
		async close() {
			closed = true;
			await memory.close();
		},
	};
	const composition = await createComposition({ config: config(), store });
	const acceptance = composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	await started;
	const shutdown = composition.shutdown();
	await Promise.resolve();
	expect(closed).toBe(false);
	release();
	await acceptance;
	await shutdown;
	expect(closed).toBe(true);
});

function injected(
	runner: () => ReturnType<typeof createFakeRunner>,
): AdapterSet {
	return {
		runner,
		workItems: fakeWorkItems([
			{
				origin: { source: "jira", key: "T", url: null },
				title: "Ticket",
				description: "",
			},
		]),
		workspace: fakeWorkspace("/workspaces"),
		roleSources,
	};
}

async function seed(
	store: RunStore,
	runId: string,
	maxConcurrentAgents: number,
	end = false,
) {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-composition-"));
	await beginFactory(
		{
			scheduler: systemScheduler,
			newId: () => crypto.randomUUID(),
			store,
			runner: createFakeRunner([], "fake"),
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
		},
		{
			runId,
			workItemRequest: { source: "jira", key: "T" },
			repo: "/repo",
			baseBranch: "main",
			roles,
			maxConcurrentAgents,
		},
	);
	if (end) {
		const events = await store.read(runId);
		await store.append(
			runId,
			[{ type: "run.ended", outcome: "approved" }],
			events.at(-1)?.seq ?? 0,
		);
	}
}

it("computes the effective ceiling from configured and active runs", () => {
	expect(effectiveConcurrency(5, [])).toBe(5);
	expect(effectiveConcurrency(5, [2, 8])).toBe(2);
	expect(effectiveConcurrency(5, [undefined, 8])).toBe(5);
	expect(effectiveConcurrency(5, [0, -1, 1.5])).toBe(5);
});

it("rejects a moved execution HEAD but resumes after repository-wide history changes", async () => {
	const store = createMemoryRunStore();
	const dataDir = await mkdtemp(join(tmpdir(), "payo-resume-"));
	const settings = config({
		dataDir,
		checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
	});
	const adapters = await createAdapterSet(settings, store);
	const workspace = adapters.executionWorkspace;
	const runner = adapters.executionRunner;
	if (!workspace || !runner) throw new Error("execution adapters expected");
	let interrupted = true;
	let historyChanged = false;
	let headChanged = false;
	const composition = await createComposition({
		config: settings,
		store,
		adapters: {
			...adapters,
			executionRunner: () => ({
				id: "resume-test-runner",
				run: (spec, signal) => {
					if (interrupted)
						return (async function* () {
							yield { type: "error", message: "preparer interrupted" } as const;
						})();
					return runner().run(spec, signal);
				},
			}),
			executionWorkspace: {
				...workspace,
				inspect: async (path, signal) => {
					const snapshot = await workspace.inspect(path, signal);
					return {
						...snapshot,
						...(historyChanged ? { historyFingerprint: "changed-refs" } : {}),
						...(headChanged ? { head: "unexpected-commit" } : {}),
					};
				},
			},
		},
	});
	try {
		const sourceRunId = await composition.start({
			workItemRequest: { source: "jira", key: "ABC-123" },
			repo: "/repo",
			baseBranch: "main",
		});
		await composition.waitForIdle();
		await composition.answer(sourceRunId, {
			questionId: "q1",
			text: "Because.",
		});
		await composition.approve(sourceRunId);
		const preview = await composition.implementPreview(sourceRunId, {
			prId: "pr-1",
			slug: "create-todo-entity",
		});
		if (!preview.previewHash || preview.ticketId === undefined)
			throw new Error(JSON.stringify(preview.errors));
		const runId = await composition.implement(sourceRunId, {
			prId: "pr-1",
			naming: {
				previewHash: preview.previewHash,
				ticketId: preview.ticketId,
				slug: preview.slug,
			},
		});
		await composition.waitForIdle();
		const gated = await composition.summary(runId);
		expect(gated.stage).toBe("Escalated");
		historyChanged = true;
		headChanged = true;
		await expect(composition.resume(runId)).rejects.toMatchObject({
			code: "conflict",
			message: expect.stringContaining("workspace HEAD changed"),
		});
		expect((await composition.summary(runId)).openGates).toEqual(
			gated.openGates,
		);
		headChanged = false;
		interrupted = false;
		await composition.resume(runId);
		await composition.waitForIdle();
		expect(await composition.summary(runId)).toMatchObject({
			stage: "Completed",
			outcome: "reviewed",
			openGates: [],
		});
	} finally {
		await composition.shutdown();
	}
});

it("allows retrying a plan conflict in the same execution", async () => {
	const store = createMemoryRunStore();
	const dataDir = await mkdtemp(join(tmpdir(), "payo-plan-conflict-"));
	const settings = config({
		dataDir,
		checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
	});
	const adapters = await createAdapterSet(settings, store);
	const runner = adapters.executionRunner;
	if (!runner) throw new Error("execution runner expected");
	const issue = "The requested API already exists; preserve its consumers.";
	const composition = await createComposition({
		config: settings,
		store,
		adapters: {
			...adapters,
			executionRunner: () => ({
				id: "plan-conflict-runner",
				run: (spec, signal) =>
					spec.role === "implementer"
						? (async function* () {
								yield {
									type: "result",
									text: JSON.stringify({
										summary: "Blocked",
										completedCriteria: [],
										planIssues: [issue],
									}),
								} as const;
							})()
						: runner().run(spec, signal),
			}),
		},
	});
	try {
		const sourceRunId = await composition.start({
			workItemRequest: { source: "jira", key: "ABC-123" },
			repo: "/repo",
			baseBranch: "main",
		});
		await composition.waitForIdle();
		await composition.answer(sourceRunId, {
			questionId: "q1",
			text: "Because.",
		});
		await composition.approve(sourceRunId);
		const preview = await composition.implementPreview(sourceRunId, {
			prId: "pr-1",
			slug: "create-todo-entity",
		});
		if (!preview.previewHash || preview.ticketId === undefined)
			throw new Error(JSON.stringify(preview.errors));
		const runId = await composition.implement(sourceRunId, {
			prId: "pr-1",
			naming: {
				previewHash: preview.previewHash,
				ticketId: preview.ticketId,
				slug: preview.slug,
			},
		});
		await composition.waitForIdle();
		const summary = await composition.summary(runId);
		expect(summary.execution?.planIssues).toEqual([issue]);
		expect(
			summary.openGates.find((gate) => gate.kind === "execution-escalation")
				?.allowedCommands,
		).toEqual(["resume"]);
		const answers = [{ issue, answer: "Reuse the existing API." }];
		const gateId = summary.openGates.find(
			(gate) => gate.kind === "execution-escalation",
		)?.gateId;
		if (!gateId) throw new Error("missing gate");
		await composition.resume(runId, { gateId, answers });
		await composition.waitForIdle();
		expect((await composition.summary(runId)).execution?.planIssues).toEqual([
			issue,
		]);
		expect((await composition.summary(runId)).execution?.issueAnswers).toEqual(
			answers,
		);
	} finally {
		await composition.shutdown();
	}
});

it("caps new runs by active run settings and ignores ended runs", async () => {
	const store = createMemoryRunStore();
	await seed(store, "active", 2);
	await seed(store, "ended", 8, true);
	const composition = await createComposition({ config: config(), store });

	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	const [created] = await store.read(runId);
	expect(created).toMatchObject({
		type: "run.created",
		config: { factory: { maxConcurrentAgents: 2 } },
	});
	await composition.shutdown();
});

it("uses the configured value when every run has ended", async () => {
	const store = createMemoryRunStore();
	await seed(store, "ended", 8, true);
	const composition = await createComposition({
		config: config({ maxConcurrentAgents: 5 }),
		store,
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	const [created] = await store.read(runId);
	expect(created).toMatchObject({
		type: "run.created",
		config: { factory: { maxConcurrentAgents: 5 } },
	});
	await composition.shutdown();
});

it("skips a run without a checkpoint without blocking other runs", async () => {
	const store = createMemoryRunStore();
	await store.append(
		"broken",
		[
			{
				type: "run.created",
				runId: "broken",
				repo: "/repo",
				baseBranch: "main",
				config: {},
			},
		],
		0,
	);
	await seed(store, "good", 1);

	const composition = await createComposition({ config: config(), store });

	expect(composition.hasRun("broken")).toBe(false);
	expect(composition.hasRun("good")).toBe(true);
	expect((await composition.listRuns()).map((run) => run.runId)).toEqual([
		"good",
	]);
	await composition.shutdown();
});

it("rejects an unknown fake scenario and scenarios without --dev-fakes", async () => {
	const store = createMemoryRunStore();
	await expect(
		createComposition({
			config: config({ scenario: "unknown" }),
			store,
		}),
	).rejects.toThrow(/unknown fake scenario/);
	const second = createMemoryRunStore();
	await expect(
		createComposition({
			config: config({ scenario: "clean", devFakes: false }),
			store: second,
		}),
	).rejects.toThrow(/--dev-fakes/);
});

it("allows planning without an implementer model but rejects implementation actionably", async () => {
	const store = createMemoryRunStore();
	const model = { provider: "anthropic", id: "test-model" };
	const composition = await createComposition({
		config: config({
			devFakes: false,
			scenario: null,
			checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
			roles: {
				planner: { model, timeoutMs: 1000 },
				reviewer: { model, timeoutMs: 1000 },
				verifier: { model, timeoutMs: 1000 },
				reviser: { model, timeoutMs: 1000 },
			},
		}),
		store,
		adapters: injected(() => createFakeRunner(cleanScript())),
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	await composition.waitForIdle();
	await composition.approve(runId);
	await expect(composition.implement(runId, { prId: "pr" })).rejects.toThrow(
		/\[roles\.implementer\]\.model/,
	);
	await composition.shutdown();
});

it("reports a failed execution role-source load as unavailable", async () => {
	const store = createMemoryRunStore();
	const model = { provider: "anthropic", id: "test-model" };
	const composition = await createComposition({
		config: config({
			devFakes: false,
			scenario: null,
			checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
			roles: {
				planner: { model, timeoutMs: 1000 },
				reviewer: { model, timeoutMs: 1000 },
				verifier: { model, timeoutMs: 1000 },
				reviser: { model, timeoutMs: 1000 },
				implementer: { model, timeoutMs: 1000 },
			},
		}),
		store,
		adapters: {
			...injected(() => createFakeRunner(cleanScript())),
			executionWorkspace: fakeExecutionWorkspace("/workspaces"),
			checks: { run: async () => [] },
			loadExecutionRoleSources: async () => {
				throw new Error("skills checkout is unreadable");
			},
		},
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	await composition.waitForIdle();
	await composition.approve(runId);
	await expect(
		composition.implement(runId, { prId: "pr" }),
	).rejects.toMatchObject({
		name: "ApplicationError",
		code: "execution_unavailable",
	});
	await composition.shutdown();
});

it("reports a failed stored execution base resolution as unavailable", async () => {
	const store = createMemoryRunStore();
	const model = { provider: "anthropic", id: "test-model" };
	const composition = await createComposition({
		config: config({
			devFakes: false,
			scenario: null,
			checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
			roles: {
				planner: { model, timeoutMs: 1000 },
				reviewer: { model, timeoutMs: 1000 },
				verifier: { model, timeoutMs: 1000 },
				reviser: { model, timeoutMs: 1000 },
				implementer: { model, timeoutMs: 1000 },
			},
		}),
		store,
		adapters: {
			...injected(() => createFakeRunner(cleanScript())),
			executionWorkspace: {
				...fakeExecutionWorkspace("/workspaces"),
				resolveBase: async () => {
					throw new Error("base branch is missing");
				},
			},
			checks: { run: async () => [] },
			loadExecutionRoleSources: async () => {
				throw new Error("role sources must not be loaded");
			},
		},
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	await composition.waitForIdle();
	await composition.approve(runId);
	await expect(
		composition.implement(runId, { prId: "pr" }),
	).rejects.toMatchObject({
		name: "ApplicationError",
		code: "execution_unavailable",
	});
	await composition.shutdown();
});

it("reports a failed requested execution base resolution as bad request", async () => {
	const store = createMemoryRunStore();
	const model = { provider: "anthropic", id: "test-model" };
	const composition = await createComposition({
		config: config({
			devFakes: false,
			scenario: null,
			checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
			roles: {
				planner: { model, timeoutMs: 1000 },
				reviewer: { model, timeoutMs: 1000 },
				verifier: { model, timeoutMs: 1000 },
				reviser: { model, timeoutMs: 1000 },
				implementer: { model, timeoutMs: 1000 },
			},
		}),
		store,
		adapters: {
			...injected(() => createFakeRunner(cleanScript())),
			executionWorkspace: {
				...fakeExecutionWorkspace("/workspaces"),
				resolveBase: async () => {
					throw new Error("base branch is missing");
				},
			},
			checks: { run: async () => [] },
			loadExecutionRoleSources: async () => {
				throw new Error("role sources must not be loaded");
			},
		},
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	await composition.waitForIdle();
	await composition.approve(runId);
	await expect(
		composition.implement(runId, { prId: "pr", base: "release" }),
	).rejects.toMatchObject({
		name: "ApplicationError",
		code: "execution_base_unavailable",
	});
	await composition.shutdown();
});

it("uses an injected adapter set in real mode", async () => {
	const store = createMemoryRunStore();
	const composition = await createComposition({
		config: config({ devFakes: false, scenario: null, model: "test-model" }),
		store,
		adapters: injected(() => createFakeRunner(cleanScript())),
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	const [created] = await store.read(runId);
	expect(created).toMatchObject({
		type: "run.created",
		config: {
			factory: {
				roles: {
					planner: { timeoutMs: 300_000 },
					reviewer: { timeoutMs: 300_000 },
					verifier: { timeoutMs: 300_000 },
					reviser: { timeoutMs: 300_000 },
				},
			},
		},
	});
	await composition.waitForIdle();
	expect(await composition.summary(runId)).toMatchObject({
		status: "active",
		stage: "Approval",
	});
	await composition.shutdown();
});

it("snapshots provider-qualified models and role timeouts into each new run", async () => {
	const store = createMemoryRunStore();
	const configured = config({
		roles: {
			planner: { model: { provider: "openai", id: "o3" }, timeoutMs: 1111 },
			reviewer: {
				model: { provider: "anthropic", id: "claude-review" },
				timeoutMs: 2222,
			},
			verifier: {
				model: { provider: "google", id: "gemini-check" },
				timeoutMs: 3333,
			},
			reviser: {
				model: { provider: "openai", id: "o4-mini" },
				timeoutMs: 4444,
			},
		},
	});
	const composition = await createComposition({
		config: configured,
		store,
		adapters: injected(() => createFakeRunner(cleanScript())),
	});
	const runId = await composition.start({
		workItemRequest: { source: "jira", key: "T" },
		repo: "/repo",
		baseBranch: "main",
	});
	configured.roles.planner.model = { provider: "changed", id: "later" };
	const [created] = await store.read(runId);
	expect(created).toMatchObject({
		type: "run.created",
		config: {
			factory: {
				roles: {
					planner: { model: "openai/o3", timeoutMs: 1111 },
					reviewer: { model: "anthropic/claude-review", timeoutMs: 2222 },
					verifier: { model: "google/gemini-check", timeoutMs: 3333 },
					reviser: { model: "openai/o4-mini", timeoutMs: 4444 },
				},
			},
		},
	});
	await composition.shutdown();
});

it("builds a fresh fake runner for every run", async () => {
	const store = createMemoryRunStore();
	let calls = 0;
	const composition = await createComposition({
		config: config(),
		store,
		adapters: injected(() => {
			calls++;
			return createFakeRunner(cleanScript());
		}),
	});
	for (let index = 0; index < 2; index++) {
		await composition.start({
			workItemRequest: { source: "jira", key: "T" },
			repo: "/repo",
			baseBranch: "main",
		});
		await composition.waitForIdle();
	}
	expect(calls).toBe(2);
	await composition.shutdown();
});

it("recovers an interrupted publication child on restart and resumes it explicitly", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-publication-restart-"));
	const settings = config({
		dataDir,
		checks: [{ name: "unit", command: "true", args: [], timeout_ms: 1000 }],
	});
	const store = await createSqliteRunStore({ dataDir });
	const adapters = await createAdapterSet(settings, store);
	const first = await createComposition({ config: settings, store, adapters });
	const sourceRunId = await first.start({
		workItemRequest: { source: "jira", key: "ABC-123" },
		repo: "/repo",
		baseBranch: "main",
	});
	await first.waitForIdle();
	await first.answer(sourceRunId, { questionId: "q1", text: "Because." });
	await first.approve(sourceRunId);
	const naming = await first.implementPreview(sourceRunId, {
		prId: "pr-1",
		slug: "create-todo-entity",
	});
	if (!naming.previewHash || naming.ticketId === undefined)
		throw new Error(JSON.stringify(naming.errors));
	const executionRunId = await first.implement(sourceRunId, {
		prId: "pr-1",
		naming: {
			previewHash: naming.previewHash,
			ticketId: naming.ticketId,
			slug: naming.slug,
		},
	});
	await first.waitForIdle();
	expect((await first.summary(executionRunId)).execution?.outcome).toBe(
		"reviewed",
	);
	const preview = await first.publicationPreview(executionRunId);
	expect(preview.eligible).toBe(true);
	if (!preview.previewHash) throw new Error(preview.errors.join("; "));
	const ports = fakePublicationPorts();
	if (!adapters.executionWorkspace)
		throw new Error("execution workspace expected");
	const accepted = await beginPublication(
		{
			store,
			newId: () => crypto.randomUUID(),
			workspace: adapters.executionWorkspace,
			repository: ports.repository,
			codeHost: ports.codeHost,
		},
		executionRunId,
		{ previewHash: preview.previewHash },
		new AbortController().signal,
	);
	const publicationRunId = accepted.handle.log.current().runId;
	expect(accepted.created).toBe(true);
	await first.shutdown();

	const restartedStore = await createSqliteRunStore({ dataDir });
	const restarted = await createComposition({
		config: settings,
		store: restartedStore,
		adapters: await createAdapterSet(settings, restartedStore),
	});
	try {
		const gated = await restarted.summary(publicationRunId);
		expect(gated.publication).toMatchObject({
			executionRunId,
			stage: "Escalated",
		});
		expect(gated.openGates.length).toBeGreaterThan(0);
		expect((await restarted.summary(executionRunId)).status).toBe("ended");
		await restarted.resume(publicationRunId);
		await restarted.waitForIdle();
		expect(await restarted.summary(publicationRunId)).toMatchObject({
			status: "ended",
			outcome: "published",
			publication: { stage: "Completed" },
			openGates: [],
		});
	} finally {
		await restarted.shutdown();
	}
});

it("refuses invalid publication policy before opening the store or adapters", async () => {
	await expect(
		createComposition({
			config: config({
				publication: {
					...config().publication,
					prTitleTemplate: "{description}",
				},
			}),
		}),
	).rejects.toMatchObject({
		code: "invalid_request",
		message: expect.stringContaining("publication.pr_title_template"),
	});
});
