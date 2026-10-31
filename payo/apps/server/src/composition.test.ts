import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginFactory } from "@payo/factory";
import {
	createLimiter,
	createMemoryRunStore,
	type RunStore,
} from "@payo/kernel";
import { expect, it } from "vitest";
import type { AdapterSet } from "./adapters.ts";
import { createComposition, effectiveConcurrency } from "./composition.ts";
import type { ServerConfig } from "./config.ts";
import {
	createFakeRunner,
	envelope,
	fakeTickets,
	fakeWorkspace,
} from "./factory-fixtures.ts";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		dataDir: "/tmp/payo-composition",
		repo: "/repo",
		baseBranch: "main",
		maxConcurrentAgents: 4,
		webOrigins: [],
		devFakes: true,
		scenario: "clean",
		port: 0,
		testMode: true,
		piBin: "pi",
		acliBin: "acli",
		gitBin: "git",
		piProvider: "anthropic",
		model: null,
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
	markdown: "# Plan\n",
	prStrategy: [{ id: "pr", title: "One", phases: [] }],
	openQuestions: [],
};

const cleanScript = () => [
	envelope(plan),
	...Array.from({ length: 7 }, () => envelope({ findings: [] })),
	envelope({ verdicts: [] }),
];

function injected(
	runner: () => ReturnType<typeof createFakeRunner>,
): AdapterSet {
	return {
		runner,
		tickets: fakeTickets([
			{ key: "T", title: "Ticket", description: "", url: null },
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
			store,
			runner: createFakeRunner([], "fake"),
			limiter: createLimiter(1),
			tickets: fakeTickets([
				{ key: "T", title: "Ticket", description: "", url: null },
			]),
			workspace: fakeWorkspace("/workspace"),
			dataDir,
			roleSources,
		},
		{
			runId,
			ticketKey: "T",
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

it("caps new runs by active run settings and ignores ended runs", async () => {
	const store = createMemoryRunStore();
	await seed(store, "active", 2);
	await seed(store, "ended", 8, true);
	const composition = await createComposition({ config: config(), store });

	const runId = await composition.start({
		ticketKey: "T",
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
		ticketKey: "T",
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

it("uses an injected adapter set in real mode", async () => {
	const store = createMemoryRunStore();
	const composition = await createComposition({
		config: config({ devFakes: false, scenario: null, model: "test-model" }),
		store,
		adapters: injected(() => createFakeRunner(cleanScript())),
	});
	const runId = await composition.start({
		ticketKey: "T",
		repo: "/repo",
		baseBranch: "main",
	});
	await composition.waitForIdle();
	expect(await composition.summary(runId)).toMatchObject({
		status: "active",
		stage: "Approval",
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
			ticketKey: "T",
			repo: "/repo",
			baseBranch: "main",
		});
		await composition.waitForIdle();
	}
	expect(calls).toBe(2);
	await composition.shutdown();
});
