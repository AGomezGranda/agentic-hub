import type { RunEventBody } from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { startRun } from "./run.ts";
import { openRunLog } from "./run-log.ts";
import { fold } from "./state.ts";
import { createMemoryRunStore } from "./store.ts";
import { body, testRunInput } from "./testing.ts";

describe("openRunLog", () => {
	it("serialises ten concurrent writes into consecutive seqs with no stale seq", async () => {
		const store = createMemoryRunStore();
		const started = await startRun(store, testRunInput("r1"));
		const log = openRunLog(store, started);

		const writes = Array.from({ length: 10 }, (_, i) =>
			log.write([body.stepStarted(`s${i}`)]),
		);
		const results = await Promise.allSettled(writes);

		expect(results.every((r) => r.status === "fulfilled")).toBe(true);
		const events = await store.read("r1");
		expect(events.map((e) => e.seq)).toEqual(
			Array.from({ length: 11 }, (_, i) => i + 1),
		);
		expect(log.current().lastSeq).toBe(11);
		expect(fold(events).steps.size).toBe(10);
	});

	it("rejects a write the reducer refuses, and the next write still succeeds", async () => {
		const store = createMemoryRunStore();
		const started = await startRun(store, testRunInput("r1"));
		const log = openRunLog(store, started);

		await expect(log.write([body.stepFinished("missing")])).rejects.toThrow(
			/unknown|not running/,
		);
		expect(log.current()).toBe(started);

		const next = await log.write([body.stepStarted("s1")]);
		expect(next.steps.get("s1")?.status).toBe("running");
		expect(next.lastSeq).toBe(2);
	});
	it("commits the bodies as they were when write was called, element by element", async () => {
		const store = createMemoryRunStore();
		const started = await startRun(store, testRunInput("r1"));
		const log = openRunLog(store, started);
		const first = { type: "step.started" as const, stepId: "s1", name: "s1" };
		const bodies: RunEventBody[] = [first];

		const pending = log.write(bodies);
		first.stepId = "s9";
		bodies.push(body.stepStarted("s2"));
		await pending;

		expect([...log.current().steps.keys()]).toEqual(["s1"]);
	});
});
