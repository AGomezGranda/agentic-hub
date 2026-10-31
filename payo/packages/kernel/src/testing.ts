// Test support for kernel and adapters. Imported only through "@payo/kernel/testing", never from the root.
import type {
	AttemptOutcome,
	RunConfig,
	RunEvent,
	RunEventBody,
	StepOutcome,
} from "@payo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, openRun, startRun } from "./run.ts";
import { fold } from "./state.ts";
import { type RunStore, StaleSeqError, sha256Hex } from "./store.ts";

export const sha = (char: string): string => char.repeat(64);

export const body = {
	runCreated: (runId = "run-1", config: RunConfig = {}): RunEventBody => ({
		type: "run.created",
		runId,
		repo: "acme/app",
		baseBranch: "main",
		config,
	}),
	runEnded: (outcome = "approved"): RunEventBody => ({
		type: "run.ended",
		outcome,
	}),
	stepStarted: (stepId: string): RunEventBody => ({
		type: "step.started",
		stepId,
		name: stepId,
	}),
	stepFinished: (
		stepId: string,
		outcome: StepOutcome = "succeeded",
	): RunEventBody => ({
		type: "step.finished",
		stepId,
		outcome,
	}),
	attemptStarted: (attemptId: string, stepId: string): RunEventBody => ({
		type: "attempt.started",
		attemptId,
		stepId,
		role: "reviewer",
		runner: "fake",
		model: null,
		roleSpecSha: null,
		inputArtifacts: [],
	}),
	attemptFinished: (
		attemptId: string,
		outcome: AttemptOutcome = "succeeded",
	): RunEventBody => ({
		type: "attempt.finished",
		attemptId,
		outcome,
		usage: { tokensIn: 1, tokensOut: 2, cost: "unknown" },
	}),
	gateRaised: (gateId: string, stepId: string): RunEventBody => ({
		type: "gate.raised",
		gateId,
		stepId,
		kind: "review",
		allowedCommands: ["approve", "reject"],
		reason: "needs a human",
	}),
	gateResolved: (gateId: string, command = "approve"): RunEventBody => ({
		type: "gate.resolved",
		gateId,
		command,
		note: null,
	}),
	artifactRecorded: (
		hash: string,
		attemptId: string | null = null,
	): RunEventBody => ({
		type: "artifact.recorded",
		artifact: { sha256: hash, size: 3, kind: "diff", mediaType: "text/x-diff" },
		attemptId,
	}),
};

export function testRunInput(runId: string) {
	return { runId, repo: "acme/app", baseBranch: "main", config: {} };
}

// Gives bodies the seq 1..n the store would assign.
export function seqd(bodies: RunEventBody[]): RunEvent[] {
	return bodies.map((event, i) => ({
		...event,
		seq: i + 1,
		at: "2026-10-30T00:00:00.000Z",
	}));
}

export interface StoreHarness {
	open(): Promise<RunStore>;
	dispose(): Promise<void>;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const meta = { kind: "diff", mediaType: "text/x-diff" };

/** Every RunStore must pass this. Each case gets fresh storage from `makeHarness`. */
export function runStoreContract(
	name: string,
	makeHarness: () => Promise<StoreHarness>,
): void {
	describe(`RunStore contract: ${name}`, () => {
		let harness: StoreHarness;
		beforeEach(async () => {
			harness = await makeHarness();
		});
		afterEach(async () => {
			await harness.dispose();
		});

		it("returns events in seq order with the runId intact and an ISO at", async () => {
			const store = await harness.open();
			await store.append(
				"r1",
				[body.runCreated("r1"), body.stepStarted("s1")],
				0,
			);

			const events = await store.read("r1");

			expect(events.map((e) => e.seq)).toEqual([1, 2]);
			expect(events[0]).toMatchObject({ type: "run.created", runId: "r1" });
			expect(new Date(events[0]?.at ?? "").toISOString()).toBe(events[0]?.at);
			await store.close();
		});

		it("reads only seq >= fromSeq", async () => {
			const store = await harness.open();
			await store.append(
				"r1",
				[
					body.runCreated("r1"),
					body.stepStarted("s1"),
					body.stepStarted("s2"),
					body.stepStarted("s3"),
				],
				0,
			);

			const events = await store.read("r1", 3);

			expect(events.map((e) => e.seq)).toEqual([3, 4]);
			await store.close();
		});

		it("rejects a stale expectedSeq with StaleSeqError and leaves the log unchanged", async () => {
			const store = await harness.open();
			await store.append(
				"r1",
				[body.runCreated("r1"), body.stepStarted("s1")],
				0,
			);

			await expect(
				store.append("r1", [body.stepStarted("s2")], 0),
			).rejects.toMatchObject({
				expected: 0,
				actual: 2,
			});
			expect(await store.read("r1")).toHaveLength(2);
			await store.close();
		});

		it("lets only one of two writers from the same seq win", async () => {
			const a = await harness.open();
			const b = await harness.open();

			const results = await Promise.allSettled([
				a.append("r1", [body.runCreated("r1")], 0),
				b.append("r1", [body.runCreated("r1")], 0),
			]);

			const rejected = results.filter((r) => r.status === "rejected");
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
				StaleSeqError,
			);
			expect(await a.read("r1")).toHaveLength(1);
			await a.close();
			await b.close();
		});

		it("stores artifacts by sha256 and reads back the same bytes", async () => {
			const store = await harness.open();

			const ref = await store.putArtifact(bytes("hello"), meta);
			expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(ref.size).toBe(5);
			expect(await store.putArtifact(bytes("hello"), meta)).toEqual(ref);
			expect((await store.putArtifact(bytes("hellO"), meta)).sha256).not.toBe(
				ref.sha256,
			);
			expect(text(await store.readArtifact(ref.sha256))).toBe("hello");
			await store.close();
		});

		it("keeps events, artifacts and interrupted attempts across close and reopen", async () => {
			const first = await harness.open();
			const started = await startRun(first, testRunInput("r1"));
			const running = await commit(first, started, [
				body.stepStarted("s1"),
				body.attemptStarted("a1", "s1"),
			]);
			const ref = await first.putArtifact(bytes("hello"), meta);
			await commit(first, running, [
				{ type: "artifact.recorded", artifact: ref, attemptId: "a1" },
			]);
			const preClose = fold(await first.read("r1"));
			await first.close();

			const second = await harness.open();
			const reopened = await openRun(second, "r1");

			expect(reopened).toMatchObject({
				repo: preClose.repo,
				baseBranch: preClose.baseBranch,
				config: preClose.config,
			});
			expect(reopened.steps).toEqual(preClose.steps);
			expect(reopened.artifacts).toEqual([ref]);
			expect(reopened.attempts.get("a1")?.status).toBe("interrupted");
			expect(reopened.gates.get("interrupted:a1")).toMatchObject({
				status: "open",
				kind: "interrupted-attempt",
			});
			expect(text(await second.readArtifact(ref.sha256))).toBe("hello");
			await second.close();
		});

		it("adds no second interrupted gate when openRun runs again after a reopen", async () => {
			const first = await harness.open();
			const started = await startRun(first, testRunInput("r1"));
			await commit(first, started, [
				body.stepStarted("s1"),
				body.attemptStarted("a1", "s1"),
			]);
			await first.close();

			const second = await harness.open();
			await openRun(second, "r1");
			const before = await second.read("r1");
			await second.close();

			const third = await harness.open();
			const state = await openRun(third, "r1");
			expect(state.gates.size).toBe(1);
			expect(await third.read("r1")).toHaveLength(before.length);
			await third.close();
		});

		it("rejects a schema-invalid body and writes no rows", async () => {
			const store = await harness.open();
			const invalid = {
				type: "gate.raised",
				gateId: "g1",
				stepId: "s1",
				kind: "review",
				allowedCommands: [],
				reason: "x",
			} as RunEventBody;

			await expect(
				store.append("r1", [body.runCreated("r1"), invalid], 0),
			).rejects.toThrow();
			expect(await store.read("r1")).toEqual([]);
			await store.close();
		});

		it("writes no rows when the last row of a batch is schema-invalid (bigint in config)", async () => {
			const store = await harness.open();
			const unserialisable = {
				...body.runCreated("r1"),
				config: { big: 1n },
			} as unknown as RunEventBody;

			await expect(
				store.append(
					"r1",
					[body.runCreated("r1"), body.stepStarted("s1"), unserialisable],
					0,
				),
			).rejects.toThrow();
			expect(await store.read("r1")).toEqual([]);
			await store.close();
		});

		it("keeps attempt.event rows and sha256 input artifacts as written", async () => {
			const store = await harness.open();
			await store.append(
				"r1",
				[
					body.runCreated("r1"),
					body.stepStarted("s1"),
					{
						type: "attempt.started",
						attemptId: "a1",
						stepId: "s1",
						role: "reviewer",
						runner: "fake",
						model: null,
						roleSpecSha: null,
						inputArtifacts: [sha("a")],
					},
					{
						type: "attempt.event",
						attemptId: "a1",
						event: { type: "message", text: "hi" },
					},
				],
				0,
			);

			const events = await store.read("r1");

			expect(events[2]).toMatchObject({ inputArtifacts: [sha("a")] });
			expect(events[3]).toMatchObject({
				type: "attempt.event",
				event: { type: "message", text: "hi" },
			});
			await store.close();
		});

		it("treats an empty append as a no-op and reads an unknown run as empty", async () => {
			const store = await harness.open();
			await store.append("r1", [], 0);
			expect(await store.read("r1")).toEqual([]);
			expect(await store.read("unknown")).toEqual([]);
			await store.close();
		});

		it("lists each run ID once in deterministic order", async () => {
			const store = await harness.open();
			expect(await store.listRunIds()).toEqual([]);
			await store.append("r2", [body.runCreated("r2")], 0);
			await store.append("r1", [body.runCreated("r1")], 0);
			await store.append("r1", [body.stepStarted("s1")], 1);

			expect(await store.listRunIds()).toEqual(["r1", "r2"]);
			await store.close();
		});

		it("writes no part of an initial batch when a later event is invalid", async () => {
			const store = await harness.open();
			const invalid = {
				...body.artifactRecorded("a".repeat(63)),
			} as RunEventBody;

			await expect(
				store.append(
					"r1",
					[body.runCreated("r1"), body.stepStarted("s1"), invalid],
					0,
				),
			).rejects.toThrow();
			expect(await store.read("r1")).toEqual([]);
			expect(await store.listRunIds()).toEqual([]);
			await store.close();
		});

		it.each(["../x", "A".repeat(64), "a".repeat(63)])(
			"rejects artifact name %j before reading anything",
			async (name) => {
				const store = await harness.open();
				await expect(store.readArtifact(name)).rejects.toThrow(
					/not a sha256 artifact name/,
				);
				await store.close();
			},
		);

		it("rejects invalid artifact metadata and stores nothing", async () => {
			const store = await harness.open();
			await expect(
				store.putArtifact(bytes("x"), { kind: "", mediaType: "text/x-diff" }),
			).rejects.toThrow();
			await expect(store.readArtifact(sha256Hex(bytes("x")))).rejects.toThrow(
				/not found/,
			);
			await store.close();
		});
	});
}
