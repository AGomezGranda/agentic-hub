import type { AgentEvent, AgentSpec } from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { createFakeRunner } from "./index.ts";

const spec: AgentSpec = {
	role: "reviewer",
	instructions: "Review the plan.",
	roleSpecSha: null,
	cwd: "/tmp/work",
	tools: "read-only",
	model: null,
	timeoutMs: 1000,
	outputContract: "verdict",
	inputs: [],
};
const started: AgentEvent = { type: "started", model: "fake-model" };
const result: AgentEvent = { type: "result", text: "{}" };

async function collect(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("createFakeRunner", () => {
	it("plays session 1 in order and records the spec it was given", async () => {
		const runner = createFakeRunner([
			[
				{ kind: "emit", event: started },
				{ kind: "emit", event: result },
			],
		]);

		const events = await collect(
			runner.run(spec, new AbortController().signal),
		);

		expect(events).toEqual([started, result]);
		expect(runner.calls).toEqual([spec]);
		expect(runner.id).toBe("fake");
	});

	it("gives each session its own script, and rejects a session with none", async () => {
		const runner = createFakeRunner([
			[{ kind: "emit", event: started }],
			[{ kind: "emit", event: result }],
		]);
		const signal = new AbortController().signal;

		expect(await collect(runner.run(spec, signal))).toEqual([started]);
		expect(await collect(runner.run(spec, signal))).toEqual([result]);
		await expect(collect(runner.run(spec, signal))).rejects.toThrow(
			"no script for session 3",
		);
		expect(runner.calls).toHaveLength(3);
	});

	it("ends a hang when the signal aborts, after the events before it", async () => {
		const runner = createFakeRunner([
			[{ kind: "emit", event: started }, { kind: "hang" }],
		]);
		const controller = new AbortController();

		const pending = collect(runner.run(spec, controller.signal));
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();

		expect(await pending).toEqual([started]);
	});

	it("ends a hang at once when the signal is already aborted", async () => {
		const runner = createFakeRunner([[{ kind: "hang" }]]);
		const controller = new AbortController();
		controller.abort();

		expect(await collect(runner.run(spec, controller.signal))).toEqual([]);
	});

	it("rejects the next call with a throw step's message", async () => {
		const runner = createFakeRunner([
			[{ kind: "throw", message: "harness crashed" }],
		]);

		await expect(
			collect(runner.run(spec, new AbortController().signal)),
		).rejects.toThrow("harness crashed");
	});

	it("stays pending after the signal aborts when a hang ignores it", async () => {
		const runner = createFakeRunner([[{ kind: "hang", ignoreSignal: true }]]);
		const controller = new AbortController();
		const next = runner
			.run(spec, controller.signal)
			[Symbol.asyncIterator]()
			.next();

		controller.abort();
		const outcome = await Promise.race([
			next.then(() => "settled"),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("pending"), 20),
			),
		]);

		expect(outcome).toBe("pending");
	});
});
