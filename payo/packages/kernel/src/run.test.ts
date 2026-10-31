import type { RunEventBody } from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { commit, openRun, recover, resolveRunConfig, startRun } from "./run.ts";
import { fold } from "./state.ts";
import {
	createMemoryRunStore,
	type MemoryBacking,
	StaleSeqError,
} from "./store.ts";
import { body, seqd, testRunInput } from "./testing.ts";

function newBacking(): MemoryBacking {
	return { events: new Map(), artifacts: new Map() };
}

describe("resolveRunConfig", () => {
	it("lets overrides win at depth, keeps the rest of the defaults", () => {
		const config = resolveRunConfig(
			{ roles: { reviewer: { model: "a", limit: 1 } } },
			{ roles: { reviewer: { model: "b" } } },
		);
		expect(config).toEqual({ roles: { reviewer: { model: "b", limit: 1 } } });
	});

	it("replaces arrays and scalars instead of merging them", () => {
		const config = resolveRunConfig(
			{ list: [1, 2], nested: { a: 1 } },
			{ list: [3], nested: 2 },
		);
		expect(config).toEqual({ list: [3], nested: 2 });
	});

	it.each([
		["undefined", undefined],
		["a bigint", 1n],
	])("throws on a non-JSON override (%s)", (_label, value) => {
		expect(() => resolveRunConfig({}, { a: value } as never)).toThrow();
	});

	it("throws on a __proto__ key instead of dropping the override", () => {
		expect(() =>
			resolveRunConfig({}, JSON.parse('{"__proto__": {"x": 1}}')),
		).toThrow(/__proto__/);
	});

	it("throws on a __proto__ key inside an array in defaults or overrides", () => {
		const nested = [JSON.parse('{"__proto__": {"x": 1}}')];
		expect(() => resolveRunConfig({}, { list: nested })).toThrow(/__proto__/);
		expect(() => resolveRunConfig({ list: nested }, {})).toThrow(/__proto__/);
	});
});

describe("recover", () => {
	it("interrupts one running attempt with one finish and one gate, then adds nothing", async () => {
		const store = createMemoryRunStore(newBacking());
		const started = await startRun(store, testRunInput("r1"));
		const running = await commit(store, started, [
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
		]);

		const bodies = recover(running);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toEqual({
			type: "attempt.finished",
			attemptId: "a1",
			outcome: "interrupted",
			usage: { tokensIn: "unknown", tokensOut: "unknown", cost: "unknown" },
		});
		expect(bodies[1]).toMatchObject({
			type: "gate.raised",
			gateId: "interrupted:a1",
			stepId: "s1",
			kind: "interrupted-attempt",
			allowedCommands: ["retry", "abandon"],
		});

		const recovered = await commit(store, running, bodies);
		expect(recover(recovered)).toEqual([]);
	});
});

describe("recover: a step left running", () => {
	it("gets one interrupted-step gate when it has no running attempt and no open gate", () => {
		const state = fold(seqd([body.runCreated(), body.stepStarted("s1")]));

		expect(recover(state)).toEqual([
			{
				type: "gate.raised",
				gateId: "interrupted-step:s1:2",
				stepId: "s1",
				kind: "interrupted-step",
				allowedCommands: ["retry", "abandon"],
				reason: "step had no running attempt when the process stopped",
			},
		]);
	});

	it("adds nothing when the step already has an open gate", () => {
		const state = fold(
			seqd([
				body.runCreated(),
				body.stepStarted("s1"),
				body.gateRaised("g1", "s1"),
			]),
		);

		expect(recover(state)).toEqual([]);
	});

	it("gates a step whose only attempt already failed, with nothing running", () => {
		const state = fold(
			seqd([
				body.runCreated(),
				body.stepStarted("s1"),
				body.attemptStarted("a1", "s1"),
				body.attemptFinished("a1", "failed"),
			]),
		);

		expect(recover(state)).toEqual([
			expect.objectContaining({
				type: "gate.raised",
				gateId: "interrupted-step:s1:4",
			}),
		]);
	});

	it("re-gates a second crash in the same window under a new gate id", async () => {
		const store = createMemoryRunStore(newBacking());
		const started = await startRun(store, testRunInput("r1"));
		const gated = await commit(store, started, [body.stepStarted("s1")]);
		const first = await commit(store, gated, recover(gated));
		const resolved = await commit(store, first, [
			body.gateResolved("interrupted-step:s1:2", "retry"),
		]);

		const again = recover(resolved);
		await commit(store, resolved, again);

		expect(again[0]).toMatchObject({ kind: "interrupted-step" });
		expect(again[0]).not.toMatchObject({ gateId: "interrupted-step:s1:2" });
	});
});

describe("commit", () => {
	it("writes nothing when a body fails the schema", async () => {
		const backing = newBacking();
		const store = createMemoryRunStore(backing);
		const state = await startRun(store, testRunInput("r1"));
		const before = structuredClone(backing.events);

		const invalid: RunEventBody = {
			type: "gate.raised",
			gateId: "g1",
			stepId: "s1",
			kind: "review",
			allowedCommands: [],
			reason: "x",
		};
		await expect(commit(store, state, [invalid])).rejects.toThrow();
		expect(backing.events).toEqual(before);
	});

	it("writes nothing when a body breaks an invariant", async () => {
		const backing = newBacking();
		const store = createMemoryRunStore(backing);
		const state = await startRun(store, testRunInput("r1"));
		const before = structuredClone(backing.events);

		await expect(
			commit(store, state, [body.stepStarted("s1"), body.stepFinished("nope")]),
		).rejects.toThrow(/nope/);
		expect(backing.events).toEqual(before);
	});

	it("leaves the input state untouched when the write is stale", async () => {
		const store = createMemoryRunStore(newBacking());
		const first = await startRun(store, testRunInput("r1"));
		await commit(store, first, [body.stepStarted("s1")]);

		await expect(
			commit(store, first, [body.stepStarted("s2")]),
		).rejects.toBeInstanceOf(StaleSeqError);
		expect(first.lastSeq).toBe(1);
		expect(first.steps.size).toBe(0);
	});

	it("returns the input state unchanged for an empty batch", async () => {
		const store = createMemoryRunStore(newBacking());
		const state = await startRun(store, testRunInput("r1"));
		expect(await commit(store, state, [])).toBe(state);
	});
});

describe("startRun", () => {
	it("throws StaleSeqError when the run id already exists", async () => {
		const store = createMemoryRunStore(newBacking());
		await startRun(store, testRunInput("r1"));

		await expect(startRun(store, testRunInput("r1"))).rejects.toMatchObject({
			expected: 0,
			actual: 1,
		});
	});

	it.each([
		["top-level", JSON.parse('{"__proto__": {"x": 1}}')],
		["nested", { a: JSON.parse('{"__proto__": 1}') }],
	])(
		"rejects a %s __proto__ config key before anything is written",
		async (_label, config) => {
			const store = createMemoryRunStore(newBacking());

			await expect(
				startRun(store, { ...testRunInput("r1"), config }),
			).rejects.toThrow(/__proto__/);
			expect(await store.read("r1")).toEqual([]);
		},
	);
});

describe("openRun", () => {
	it("names the run when it does not exist", async () => {
		await expect(
			openRun(createMemoryRunStore(newBacking()), "missing"),
		).rejects.toThrow(/missing not found/);
	});

	it("interrupts a running attempt after the store is reopened", async () => {
		const backing = newBacking();
		const first = createMemoryRunStore(backing);
		const started = await startRun(first, testRunInput("r1"));
		await commit(first, started, [
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
		]);
		await first.close();

		const state = await openRun(createMemoryRunStore(backing), "r1");

		expect(state.attempts.get("a1")?.status).toBe("interrupted");
		expect(state.gates.get("interrupted:a1")).toMatchObject({
			status: "open",
			kind: "interrupted-attempt",
		});
	});

	it("does not interrupt an attempt that already finished", async () => {
		const backing = newBacking();
		const first = createMemoryRunStore(backing);
		const started = await startRun(first, testRunInput("r1"));
		await commit(first, started, [
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			body.attemptFinished("a1"),
			body.stepFinished("s1"),
		]);
		await first.close();

		const state = await openRun(createMemoryRunStore(backing), "r1");

		expect(state.attempts.get("a1")?.status).toBe("succeeded");
		expect(state.gates.size).toBe(0);
	});
});
