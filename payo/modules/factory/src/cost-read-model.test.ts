import type {
	ArtifactRef,
	CostAmount,
	RunConfig,
	RunEventBody,
	UsageRecord,
} from "@payo/contracts";
import { commit, createMemoryRunStore, type RunStore } from "@payo/kernel";
import { describe, expect, it } from "vitest";
import { readWorkCosts } from "./cost-read-model.ts";

const role = { model: null, timeoutMs: 1000 };
const artifact = (seed: string): ArtifactRef => ({
	sha256: seed.repeat(64),
	size: 1,
	kind: "role",
	mediaType: "text/plain",
});

const planningConfig: RunConfig = {
	workItemRequest: { source: "jira", key: "T" },
	roles: { planner: role, reviewer: role, verifier: role, reviser: role },
	maxConcurrentAgents: 1,
	roleArtifacts: {
		planner: artifact("a"),
		reviewer: artifact("b"),
		verifier: artifact("c"),
		reviser: artifact("d"),
	},
	lenses: ["architecture"],
	roleProvenance: {
		planner: { path: "p", sha: "p" },
		reviewer: { path: "r", sha: "r" },
		verifier: { path: "v", sha: "v" },
		reviser: { path: "q", sha: "q" },
	},
};

const executionConfig = (sourceRunId: string, prId: string): RunConfig => ({
	kind: "factory-execution",
	sourceRunId,
	sourceBaseBranch: "main",
	plan: artifact("e"),
	prId,
	baseCommit: "abc123",
	checks: [{ name: "unit", command: "pnpm", args: ["test"], timeout_ms: 1000 }],
	roles: {},
	roleArtifacts: {},
	roleProvenance: {},
	maxConcurrentAgents: 1,
});

interface Spend {
	amount: number;
	currency?: string;
	basis?: CostAmount["basis"];
	complete?: boolean;
	/** No costDetails: a legacy scalar that has no qualified currency. */
	legacy?: boolean;
}

function usageOf(spend: Spend): UsageRecord {
	if (spend.legacy) return { tokensIn: 1, tokensOut: 1, cost: spend.amount };
	return {
		tokensIn: 1,
		tokensOut: 1,
		cost: spend.amount,
		costDetails: {
			amounts: [
				{
					currency: spend.currency ?? "USD",
					basis: spend.basis ?? "estimated",
					amount: spend.amount,
				},
			],
			complete: spend.complete ?? true,
		},
	};
}

/** Writes a run; `live` leaves the last attempt, step and run unfinished. */
async function writeRun(
	store: RunStore,
	runId: string,
	factory: RunConfig,
	options: { spend?: Spend | Spend[]; live?: boolean } = {},
): Promise<void> {
	const spends = options.spend
		? Array.isArray(options.spend)
			? options.spend
			: [options.spend]
		: [];
	const bodies: RunEventBody[] = [
		{
			type: "run.created",
			runId,
			repo: "acme/app",
			baseBranch: "main",
			config: { factory },
		},
	];
	if (spends.length > 0) {
		bodies.push(stepStarted("s1"));
		for (const [index, spend] of spends.entries()) {
			const attemptId = `a${index + 1}`;
			const usage = usageOf(spend);
			bodies.push(attemptStarted(attemptId, "s1"), {
				type: "attempt.event",
				attemptId,
				event: { type: "usage", usage },
			});
			if (options.live && index === spends.length - 1) continue;
			bodies.push({
				type: "attempt.finished",
				attemptId,
				outcome: index === spends.length - 1 ? "succeeded" : "failed",
				usage,
			});
		}
		if (!options.live) bodies.push(stepFinished("s1"));
	} else if (!options.live) {
		bodies.push(stepStarted("s1"), stepFinished("s1"));
	}
	if (!options.live) bodies.push(runEnded());
	await commit(store, null, bodies);
}

const usd = (amount: number, basis: CostAmount["basis"] = "estimated") =>
	({ currency: "USD", basis, amount }) satisfies CostAmount;

const stepStarted = (stepId: string): RunEventBody => ({
	type: "step.started",
	stepId,
	name: stepId,
});
const stepFinished = (stepId: string): RunEventBody => ({
	type: "step.finished",
	stepId,
	outcome: "succeeded",
});
const attemptStarted = (attemptId: string, stepId: string): RunEventBody => ({
	type: "attempt.started",
	attemptId,
	stepId,
	role: "worker",
	runner: "fake",
	model: null,
	roleSpecSha: null,
	inputArtifacts: [],
});
const runEnded = (): RunEventBody => ({
	type: "run.ended",
	outcome: "approved",
});

describe("readWorkCosts", () => {
	it("reads a planning-only work flow", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "plan", planningConfig, { spend: { amount: 1 } });

		const tree = await readWorkCosts(store, "plan");

		expect(tree.sourceRunId).toBe("plan");
		expect(tree.planning).toMatchObject({
			runId: "plan",
			status: "ended",
			outcome: "approved",
			cost: {
				amounts: [usd(1)],
				coverage: "complete",
				incompleteAttempts: 0,
				attempts: 1,
			},
		});
		expect(tree.planning.asOfSeq).toBe((await store.read("plan")).length);
		expect(tree.executions).toEqual([]);
		expect(tree.total).toEqual(tree.planning.cost);
	});

	it("adds each execution once and sorts them by run ID", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "plan", planningConfig, { spend: { amount: 1 } });
		await writeRun(store, "exec-b", executionConfig("plan", "pr-b"), {
			spend: { amount: 2 },
		});
		await writeRun(store, "exec-a", executionConfig("plan", "pr-a"), {
			spend: { amount: 3 },
		});

		const tree = await readWorkCosts(store, "plan");

		expect(tree.executions.map((item) => [item.run.runId, item.prId])).toEqual([
			["exec-a", "pr-a"],
			["exec-b", "pr-b"],
		]);
		expect(tree.executions.map((item) => item.run.cost.amounts)).toEqual([
			[usd(3)],
			[usd(2)],
		]);
		expect(tree.total).toEqual({
			amounts: [usd(6)],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 3,
		});
		expect(tree.executions[0]?.run.asOfSeq).toBe(
			(await store.read("exec-a")).length,
		);
	});

	it("discovers duplicate IDs once and reads each log at most once", async () => {
		const base = createMemoryRunStore();
		await writeRun(base, "plan", planningConfig, { spend: { amount: 1 } });
		await writeRun(base, "exec", executionConfig("plan", "pr-1"), {
			spend: { amount: 2 },
		});
		const reads: string[] = [];
		const store: RunStore = {
			...base,
			async listRunIds() {
				const ids = await base.listRunIds();
				return [...ids, ...ids, ...ids];
			},
			async read(runId, fromSeq) {
				reads.push(runId);
				return base.read(runId, fromSeq);
			},
		};

		const started = Date.now();
		const tree = await readWorkCosts(store, "plan");

		expect(tree.executions).toHaveLength(1);
		expect(tree.total.attempts).toBe(2);
		expect(reads.sort()).toEqual(["exec", "plan"]);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("keeps distinct executions that share a PR ID", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "plan", planningConfig, { spend: { amount: 1 } });
		await writeRun(store, "exec-1", executionConfig("plan", "pr-1"), {
			spend: { amount: 2 },
		});
		await writeRun(store, "exec-2", executionConfig("plan", "pr-1"), {
			spend: { amount: 3 },
		});

		const tree = await readWorkCosts(store, "plan");

		expect(tree.executions.map((item) => item.run.runId)).toEqual([
			"exec-1",
			"exec-2",
		]);
		expect(tree.executions.every((item) => item.prId === "pr-1")).toBe(true);
		expect(tree.total.amounts).toEqual([usd(6)]);
	});

	it("excludes unrelated planning, execution and plain runs", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "plan", planningConfig, { spend: { amount: 1 } });
		await writeRun(store, "other-plan", planningConfig, {
			spend: { amount: 2 },
		});
		await writeRun(store, "other-exec", executionConfig("other-plan", "pr-x"), {
			spend: { amount: 3 },
		});
		await writeRun(store, "plain", {});

		const tree = await readWorkCosts(store, "plan");

		expect(tree.executions).toEqual([]);
		expect(tree.total.amounts).toEqual([usd(1)]);
	});

	it("qualifies currencies and bases and keeps a legacy child unknown", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "plan", planningConfig, {
			spend: { amount: 1, currency: "USD", basis: "estimated" },
		});
		await writeRun(store, "exec-eur", executionConfig("plan", "pr-eur"), {
			spend: { amount: 2, currency: "EUR", basis: "provider-reported" },
		});
		await writeRun(store, "exec-legacy", executionConfig("plan", "pr-old"), {
			spend: { amount: 3, legacy: true },
		});

		const tree = await readWorkCosts(store, "plan");

		expect(tree.total).toEqual({
			amounts: [
				{ currency: "EUR", basis: "provider-reported", amount: 2 },
				usd(1),
			],
			coverage: "partial",
			incompleteAttempts: 1,
			attempts: 3,
		});
		expect(tree.executions[1]?.run.cost).toEqual({
			amounts: [],
			coverage: "unknown",
			incompleteAttempts: 1,
			attempts: 1,
		});
	});

	it("joins retried attempts once without recovering a live child", async () => {
		const base = createMemoryRunStore();
		await writeRun(base, "plan", planningConfig, { spend: { amount: 1 } });
		await writeRun(base, "exec-live", executionConfig("plan", "pr-1"), {
			spend: [{ amount: 2 }, { amount: 3 }],
			live: true,
		});
		let appends = 0;
		let artifactReads = 0;
		const store: RunStore = {
			...base,
			async append(runId, events, expectedSeq) {
				appends++;
				return base.append(runId, events, expectedSeq);
			},
			async readArtifact(sha256) {
				artifactReads++;
				return base.readArtifact(sha256);
			},
		};
		const before = await base.read("exec-live");

		const tree = await readWorkCosts(store, "plan");

		const live = tree.executions[0]?.run;
		expect(live).toMatchObject({ status: "active", outcome: null });
		expect(live?.steps[0]?.attempts).toHaveLength(2);
		expect(live?.cost).toEqual({
			amounts: [usd(5)],
			coverage: "partial",
			incompleteAttempts: 1,
			attempts: 2,
		});
		expect(appends).toBe(0);
		expect(artifactReads).toBe(0);
		expect(await base.read("exec-live")).toEqual(before);
	});

	it("rejects a missing root, an execution root and an invalid factory root", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "exec", executionConfig("plan", "pr-1"));
		await writeRun(store, "invalid", { nope: true });

		await expect(readWorkCosts(store, "missing")).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(readWorkCosts(store, "exec")).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(readWorkCosts(store, "invalid")).rejects.toMatchObject({
			code: "invalid_request",
		});
	});

	it("rejects a malformed run ID as invalid_request", async () => {
		const store = createMemoryRunStore();

		await expect(readWorkCosts(store, "../x")).rejects.toMatchObject({
			code: "invalid_request",
		});
	});

	it("fails rather than omits a corrupt execution log", async () => {
		const base = createMemoryRunStore();
		await writeRun(base, "plan", planningConfig);
		await writeRun(base, "exec-bad", executionConfig("plan", "pr-1"));
		const store: RunStore = {
			...base,
			async read(runId, fromSeq) {
				if (runId === "exec-bad") throw new Error("corrupt log");
				return base.read(runId, fromSeq);
			},
		};

		await expect(readWorkCosts(store, "plan")).rejects.toThrow(/corrupt log/);
	});

	it("fails on a matching execution candidate with an invalid config", async () => {
		const store = createMemoryRunStore();
		await writeRun(store, "plan", planningConfig);
		await writeRun(store, "exec-bad", {
			kind: "factory-execution",
			sourceRunId: "plan",
		});

		await expect(readWorkCosts(store, "plan")).rejects.toMatchObject({
			code: "invalid_request",
		});
	});
});
