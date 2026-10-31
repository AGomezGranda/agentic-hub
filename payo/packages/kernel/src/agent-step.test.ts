import { appendFile, writeFile } from "node:fs/promises";
import {
	type AgentEvent,
	type AgentSpec,
	jsonEnvelope,
	type UsageRecord,
} from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentRunner } from "./agent.ts";
import { RETRY_NOTE, runAgentStep, type StepInput } from "./agent-step.ts";
import { createLimiter, fanOut } from "./fanout.ts";
import { startRun } from "./run.ts";
import { openRunLog, type RunLog } from "./run-log.ts";
import { fold, type RunState } from "./state.ts";
import { createMemoryRunStore, type RunStore } from "./store.ts";
import { sha, testRunInput } from "./testing.ts";

type Session = (signal: AbortSignal) => AsyncIterable<AgentEvent>;

interface ScriptedRunner extends AgentRunner {
	readonly calls: AgentSpec[];
}

// Session N plays sessions[N - 1]. Kernel tests cannot import runner-fake, so this is the local stand-in.
function scripted(...sessions: Session[]): ScriptedRunner {
	const calls: AgentSpec[] = [];
	return {
		id: "scripted",
		calls,
		run(spec, signal) {
			calls.push(spec);
			const session = sessions[calls.length - 1];
			if (session === undefined) throw new Error(`no session ${calls.length}`);
			return session(signal);
		},
	};
}

function emits(...events: AgentEvent[]): Session {
	return async function* () {
		yield* events;
	};
}

function hangs({ deaf = false } = {}): Session {
	return async function* (signal) {
		if (deaf) await new Promise<never>(() => {});
		await untilAborted(signal);
	};
}

function untilAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

const tick = (ms = 5) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const valid: AgentEvent = { type: "result", text: '{"verdict":"ok"}' };
const usage = (tokensIn: number): UsageRecord => ({
	tokensIn,
	tokensOut: 2,
	cost: "unknown",
});
const validate = jsonEnvelope(z.object({ verdict: z.literal("ok") }));

function specFor(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		role: "reviewer",
		instructions: "Review the plan.",
		roleSpecSha: "skill-sha-1",
		cwd: "/tmp/work",
		tools: "read-only",
		model: null,
		timeoutMs: 1000,
		outputContract: "verdict",
		inputs: [
			{
				name: "plan",
				ref: {
					sha256: sha("a"),
					size: 3,
					kind: "plan",
					mediaType: "text/markdown",
				},
			},
		],
		...overrides,
	};
}

function stepOf(
	runner: AgentRunner,
	overrides: Partial<StepInput> = {},
): StepInput {
	return {
		stepId: "s1",
		stepName: "review",
		attemptIds: ["a1", "a2"],
		runner,
		spec: specFor(),
		validate,
		signal: new AbortController().signal,
		...overrides,
	};
}

async function setup(options: { store?: RunStore; limit?: number } = {}) {
	const store = options.store ?? createMemoryRunStore();
	const started = await startRun(store, testRunInput("r1"));
	const log: RunLog = openRunLog(store, started);
	return {
		store,
		deps: { store, log, limiter: createLimiter(options.limit ?? 4) },
	};
}

async function stateOf(store: RunStore): Promise<RunState> {
	return fold(await store.read("r1"));
}

describe("runAgentStep", () => {
	it("records a valid run: usage as reported, and the log in order", async () => {
		const { store, deps } = await setup();
		const reported = usage(10);
		const runner = scripted(
			emits(
				{ type: "started", model: "m" },
				{ type: "message", text: "thinking" },
				{ type: "usage", usage: reported },
				valid,
			),
		);

		const result = await runAgentStep(deps, stepOf(runner));

		expect(result).toEqual({ outcome: "succeeded", value: { verdict: "ok" } });
		const events = await store.read("r1");
		expect(events.slice(1).map((e) => e.type)).toEqual([
			"step.started",
			"attempt.started",
			"attempt.event",
			"attempt.event",
			"attempt.event",
			"attempt.event",
			"attempt.finished",
			"step.finished",
		]);
		expect(fold(events).attempts.get("a1")).toMatchObject({
			status: "succeeded",
			usage: reported,
			roleSpecSha: "skill-sha-1",
			inputArtifacts: [sha("a")],
		});
	});

	it("retries invalid output once with the error as an input, then succeeds", async () => {
		const { store, deps } = await setup();
		const runner = scripted(
			emits({ type: "result", text: "not json" }),
			emits(valid),
		);

		const result = await runAgentStep(deps, stepOf(runner));

		expect(result.outcome).toBe("succeeded");
		const state = await stateOf(store);
		expect(state.attempts.get("a1")).toMatchObject({
			status: "failed",
			error: "output is not JSON",
		});
		expect(state.attempts.get("a2")?.status).toBe("succeeded");
		expect(state.artifacts.map((a) => a.kind)).toEqual([
			"agent-output",
			"validation-error",
		]);
		const retry = runner.calls[1];
		expect(retry?.inputs.map((i) => i.name)).toEqual([
			"plan",
			"previous-output",
			"validation-error",
		]);
		expect(retry?.inputs[1]?.ref).toEqual(state.artifacts[0]);
		expect(retry?.instructions.endsWith(RETRY_NOTE)).toBe(true);
		expect(runner.calls[0]?.instructions).toBe("Review the plan.");
		expect(state.gates.size).toBe(0);
	});

	it("escalates when the retry's output is invalid too, with the output's hash in the gate", async () => {
		const { store, deps } = await setup();
		const runner = scripted(
			emits({ type: "result", text: "not json" }),
			emits({ type: "result", text: '{"verdict":"nope"}' }),
		);

		const result = await runAgentStep(deps, stepOf(runner));

		expect(result).toEqual({ outcome: "escalated" });
		const events = await store.read("r1");
		const state = fold(events);
		expect(state.attempts.get("a1")?.status).toBe("failed");
		expect(state.attempts.get("a2")?.status).toBe("failed");
		const outputs = state.artifacts.filter((a) => a.kind === "agent-output");
		expect(outputs).toHaveLength(2);
		expect(state.gates.get("escalation:s1")).toMatchObject({
			status: "open",
			kind: "escalation",
			allowedCommands: ["retry", "abandon"],
		});
		expect(state.gates.get("escalation:s1")?.reason).toContain(
			outputs[1]?.sha256 ?? "missing",
		);
		expect(state.gates.get("escalation:s1")?.reason).toContain(
			state.attempts.get("a2")?.error ?? "missing",
		);
		expect(state.steps.get("s1")?.status).toBe("escalated");
		const types = events.map((e) => e.type);
		expect(types.indexOf("gate.raised")).toBeLessThan(
			types.indexOf("step.finished"),
		);
	});

	it("fails a runner error without a retry, and raises the escalation gate", async () => {
		const { store, deps } = await setup();
		const runner = scripted(emits({ type: "error", message: "boom" }));

		const result = await runAgentStep(deps, stepOf(runner));

		expect(result).toEqual({ outcome: "failed" });
		expect(runner.calls).toHaveLength(1);
		const state = await stateOf(store);
		expect(state.attempts.get("a1")).toMatchObject({
			status: "failed",
			error: "boom",
		});
		expect(state.gates.get("escalation:s1")?.status).toBe("open");
	});

	it("fails a stream that ends without a result, without a retry", async () => {
		const { store, deps } = await setup();
		const runner = scripted(emits({ type: "started", model: null }));

		const result = await runAgentStep(deps, stepOf(runner));

		expect(result).toEqual({ outcome: "failed" });
		expect(runner.calls).toHaveLength(1);
		const state = await stateOf(store);
		expect(state.attempts.get("a1")).toMatchObject({
			status: "failed",
			error: "runner ended without a result",
		});
		expect(state.gates.get("escalation:s1")?.status).toBe("open");
	});

	it("times out an attempt whose runner honours the signal, without a retry", async () => {
		const { store, deps } = await setup();
		const runner = scripted(hangs());

		const result = await runAgentStep(
			deps,
			stepOf(runner, { spec: specFor({ timeoutMs: 20 }) }),
		);

		expect(result).toEqual({ outcome: "failed" });
		expect(runner.calls).toHaveLength(1);
		const state = await stateOf(store);
		expect(state.attempts.get("a1")?.status).toBe("timed_out");
		expect(state.gates.get("escalation:s1")?.status).toBe("open");
	});

	it("times out a deaf runner in time, because the kernel races the stream", async () => {
		const { store, deps } = await setup();
		const runner = scripted(hangs({ deaf: true }));
		const started = Date.now();

		await runAgentStep(
			deps,
			stepOf(runner, { spec: specFor({ timeoutMs: 20 }) }),
		);

		expect(Date.now() - started).toBeLessThan(2000);
		expect((await stateOf(store)).attempts.get("a1")?.status).toBe("timed_out");
	});

	it("cancels on abort: no retry and no gate", async () => {
		const { store, deps } = await setup();
		const controller = new AbortController();
		const runner = scripted(hangs());
		setTimeout(() => controller.abort(), 10);

		const result = await runAgentStep(
			deps,
			stepOf(runner, { signal: controller.signal }),
		);

		expect(result).toEqual({ outcome: "failed" });
		expect(runner.calls).toHaveLength(1);
		const state = await stateOf(store);
		expect(state.attempts.get("a1")?.status).toBe("cancelled");
		expect(state.gates.size).toBe(0);
	});

	it("keeps siblings running when one child's validator throws, and reports it unchecked", async () => {
		const { store, deps } = await setup();
		const throwing = () => {
			throw new Error("validator bug");
		};
		const children: Partial<StepInput>[] = [
			{ stepId: "s1", attemptIds: ["a1", "a2"] },
			{ stepId: "s2", attemptIds: ["b1", "b2"], validate: throwing },
			{ stepId: "s3", attemptIds: ["c1", "c2"] },
		];

		const results = await fanOut(
			children.map(
				(child) => () =>
					runAgentStep(deps, stepOf(scripted(emits(valid)), child)),
			),
		);

		const succeeded = {
			outcome: "succeeded",
			value: { verdict: "ok" },
		};
		expect(results).toEqual([
			{ status: "checked", value: succeeded },
			{ status: "unchecked", reason: "validator bug" },
			{ status: "checked", value: succeeded },
		]);
		const state = await stateOf(store);
		expect(state.attempts.get("b1")).toMatchObject({
			status: "failed",
			error: "validator bug",
		});
		expect(state.steps.get("s2")?.status).toBe("failed");
		expect(
			[...state.attempts.values()].some((a) => a.status === "running"),
		).toBe(false);
		expect([...state.steps.values()].some((s) => s.status === "running")).toBe(
			false,
		);
	});

	it("never runs more sessions at once than the shared limiter allows", async () => {
		const { deps } = await setup({ limit: 2 });
		let inFlight = 0;
		let peak = 0;
		const counted: Session = async function* () {
			inFlight++;
			peak = Math.max(peak, inFlight);
			try {
				await tick();
				yield valid;
			} finally {
				inFlight--;
			}
		};
		const ids = ["s1", "s2", "s3", "s4", "s5"];

		const results = await fanOut(
			ids.map(
				(id) => () =>
					runAgentStep(
						deps,
						stepOf(scripted(counted), {
							stepId: id,
							attemptIds: [`${id}a`, `${id}b`],
						}),
					),
			),
		);

		expect(results.every((r) => r.status === "checked")).toBe(true);
		expect(peak).toBe(2);
	});

	it("keeps a valid result that arrives before the deadline, even if the write runs past it", async () => {
		const backing = createMemoryRunStore();
		const slow: RunStore = {
			...backing,
			async append(runId, events, expectedSeq) {
				if (events.some((e) => e.type === "attempt.event")) await tick(60);
				return backing.append(runId, events, expectedSeq);
			},
		};
		const { deps } = await setup({ store: slow });

		const result = await runAgentStep(
			deps,
			stepOf(scripted(emits(valid)), { spec: specFor({ timeoutMs: 20 }) }),
		);

		expect(result.outcome).toBe("succeeded");
		expect((await stateOf(backing)).attempts.get("a1")?.status).toBe(
			"succeeded",
		);
	});

	it("keeps a valid result that arrives before an abort, even if the write runs past it", async () => {
		const backing = createMemoryRunStore();
		const slow: RunStore = {
			...backing,
			async append(runId, events, expectedSeq) {
				if (events.some((e) => e.type === "attempt.event")) await tick(60);
				return backing.append(runId, events, expectedSeq);
			},
		};
		const { deps } = await setup({ store: slow });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);

		const result = await runAgentStep(
			deps,
			stepOf(scripted(emits(valid)), { signal: controller.signal }),
		);

		expect(result.outcome).toBe("succeeded");
	});

	it("cancels a step that is still queued, before it starts an attempt", async () => {
		const { store, deps } = await setup({ limit: 1 });
		const holder = scripted(async function* () {
			await tick(50);
			yield valid;
		});
		const waiter = scripted(emits(valid));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);

		const [first, second] = await Promise.all([
			runAgentStep(
				deps,
				stepOf(holder, { stepId: "s1", attemptIds: ["a1", "a2"] }),
			),
			runAgentStep(
				deps,
				stepOf(waiter, {
					stepId: "s2",
					attemptIds: ["b1", "b2"],
					signal: controller.signal,
				}),
			),
		]);

		expect(first.outcome).toBe("succeeded");
		expect(second.outcome).toBe("failed");
		expect(waiter.calls).toHaveLength(0);
		const state = await stateOf(store);
		expect(state.attempts.has("b1")).toBe(false);
		expect(state.steps.get("s2")?.status).toBe("failed");
		expect(state.gates.size).toBe(0);
	});

	it("records unknown usage when the runner reports none", async () => {
		const { store, deps } = await setup();

		await runAgentStep(deps, stepOf(scripted(emits(valid))));

		expect((await stateOf(store)).attempts.get("a1")?.usage).toEqual({
			tokensIn: "unknown",
			tokensOut: "unknown",
			cost: "unknown",
		});
	});

	it("records the last usage reported before a timeout", async () => {
		const { store, deps } = await setup();
		const runner = scripted(async function* (signal) {
			yield { type: "usage", usage: usage(1) };
			yield { type: "usage", usage: usage(2) };
			yield* hangs()(signal);
		});

		await runAgentStep(
			deps,
			stepOf(runner, { spec: specFor({ timeoutMs: 20 }) }),
		);

		const attempt = (await stateOf(store)).attempts.get("a1");
		expect(attempt?.status).toBe("timed_out");
		expect(attempt?.usage).toEqual(usage(2));
	});

	it("batches attempt events, keeping every message in order", async () => {
		const base = createMemoryRunStore();
		let eventWrites = 0;
		const store: RunStore = {
			...base,
			async append(runId, events, seq) {
				if (events.some((event) => event.type === "attempt.event"))
					eventWrites++;
				return base.append(runId, events, seq);
			},
		};
		const { deps } = await setup({ store });
		const messageTexts = Array.from({ length: 70 }, (_, i) => `m${i}`);
		const messages: AgentEvent[] = messageTexts.map((text) => ({
			type: "message",
			text,
		}));
		const runner = scripted(emits(...messages, valid));

		await runAgentStep(deps, stepOf(runner));

		const texts = (await store.read("r1")).flatMap((event) =>
			event.type === "attempt.event" && event.event.type === "message"
				? [event.event.text]
				: [],
		);
		expect(texts).toEqual(messageTexts);
		expect(eventWrites).toBeLessThanOrEqual(4);
	});

	it("flushes buffered events when the attempt times out", async () => {
		const { store, deps } = await setup();
		const runner = scripted(async function* (signal) {
			for (let i = 0; i < 5; i++) yield { type: "message", text: `m${i}` };
			yield* hangs()(signal);
		});

		await runAgentStep(
			deps,
			stepOf(runner, { spec: specFor({ timeoutMs: 20 }) }),
		);

		const state = await stateOf(store);
		expect(state.attempts.get("a1")?.status).toBe("timed_out");
		const texts = (await store.read("r1")).flatMap((event) =>
			event.type === "attempt.event" && event.event.type === "message"
				? [event.event.text]
				: [],
		);
		expect(texts).toEqual(["m0", "m1", "m2", "m3", "m4"]);
	});

	it("flushes buffered events when the runner throws", async () => {
		const { store, deps } = await setup();
		const runner = scripted(async function* () {
			for (let i = 0; i < 3; i++) yield { type: "message", text: `m${i}` };
			throw new Error("boom");
		});

		await expect(runAgentStep(deps, stepOf(runner))).rejects.toThrow("boom");

		const state = await stateOf(store);
		expect(state.attempts.get("a1")?.status).toBe("failed");
		expect(state.steps.get("s1")?.status).toBe("failed");
		const texts = (await store.read("r1")).flatMap((event) =>
			event.type === "attempt.event" && event.event.type === "message"
				? [event.event.text]
				: [],
		);
		expect(texts).toEqual(["m0", "m1", "m2"]);
	});

	it("does not strand the attempt or step when a runner emits schema-invalid usage", async () => {
		const { store, deps } = await setup();
		const bad: AgentEvent = {
			type: "usage",
			usage: { tokensIn: -1, tokensOut: 2, cost: "unknown" },
		};
		const runner = scripted(emits(bad, valid));

		await expect(runAgentStep(deps, stepOf(runner))).rejects.toThrow();

		const state = await stateOf(store);
		expect(state.attempts.get("a1")?.status).toBe("failed");
		expect(state.steps.get("s1")?.status).toBe("failed");
		expect(runner.calls).toHaveLength(1);
	});

	it("fails a runner that throws synchronously, with no gate", async () => {
		const { store, deps } = await setup();
		const runner: AgentRunner = {
			id: "throws",
			run() {
				throw new Error("no harness");
			},
		};

		await expect(runAgentStep(deps, stepOf(runner))).rejects.toThrow(
			"no harness",
		);

		const state = await stateOf(store);
		expect(state.attempts.get("a1")).toMatchObject({
			status: "failed",
			error: "no harness",
		});
		expect(state.steps.get("s1")?.status).toBe("failed");
		expect(state.gates.size).toBe(0);
	});

	it("rejects an out-of-range spec before writing any row", async () => {
		const { store, deps } = await setup();
		const runner = scripted(emits(valid));

		await expect(
			runAgentStep(
				deps,
				stepOf(runner, { spec: specFor({ timeoutMs: 2147483648 }) }),
			),
		).rejects.toThrow();

		expect((await store.read("r1")).map((e) => e.type)).toEqual([
			"run.created",
		]);
		expect(runner.calls).toHaveLength(0);
	});

	it("times out a runner that emits without awaiting, because each event yields", async () => {
		const { store, deps } = await setup();
		const flood: Session = async function* () {
			const started = Date.now();
			while (Date.now() - started < 200) {
				yield { type: "message", text: "x" };
			}
			throw new Error("deadline never fired");
		};
		const runner = scripted(flood);

		await runAgentStep(
			deps,
			stepOf(runner, { spec: specFor({ timeoutMs: 20 }) }),
		);

		expect((await stateOf(store)).attempts.get("a1")?.status).toBe("timed_out");
	});

	it("captures the runner's raw log before attempt.finished", async () => {
		const { store, deps } = await setup();
		const raw = '{"type":"message_end"}\n{"type":"agent_settled"}\n';
		const runner = scripted(async function* () {
			const spec = runner.calls[0];
			if (spec?.rawLogPath === undefined) throw new Error("no raw log path");
			await writeFile(spec.rawLogPath, raw);
			yield valid;
		});

		const result = await runAgentStep(deps, stepOf(runner));

		expect(result.outcome).toBe("succeeded");
		expect(runner.calls[0]?.correlation).toEqual({
			runId: "r1",
			stepId: "s1",
			attemptId: "a1",
		});
		const events = await store.read("r1");
		const artifactIndex = events.findIndex(
			(event) => event.type === "artifact.recorded",
		);
		const finishedIndex = events.findIndex(
			(event) => event.type === "attempt.finished",
		);
		expect(artifactIndex).toBeGreaterThan(-1);
		expect(artifactIndex).toBeLessThan(finishedIndex);
		const recorded = events[artifactIndex];
		if (recorded?.type !== "artifact.recorded") throw new Error("no artifact");
		expect(recorded.artifact.kind).toBe("agent-raw-log");
		expect(
			new TextDecoder().decode(
				await store.readArtifact(recorded.artifact.sha256),
			),
		).toBe(raw);
	});

	it("records the raw log when the runner throws, before the failed attempt row", async () => {
		const { store, deps } = await setup();
		const raw = '{"partial":true}\n';
		const runner = scripted(async function* () {
			const spec = runner.calls[0];
			if (spec?.rawLogPath === undefined) throw new Error("no raw log path");
			await writeFile(spec.rawLogPath, raw);
			yield { type: "message", text: "partial" };
			throw new Error("boom");
		});

		await expect(runAgentStep(deps, stepOf(runner))).rejects.toThrow("boom");

		const events = await store.read("r1");
		const artifactIndex = events.findIndex(
			(event) => event.type === "artifact.recorded",
		);
		const finishedIndex = events.findIndex(
			(event) => event.type === "attempt.finished",
		);
		expect(artifactIndex).toBeGreaterThan(-1);
		expect(artifactIndex).toBeLessThan(finishedIndex);
		expect(events[finishedIndex]).toMatchObject({
			type: "attempt.finished",
			outcome: "failed",
		});
	});

	it("waits for a runner that writes during cleanup", async () => {
		const { store, deps } = await setup();
		const runner = scripted(async function* () {
			const spec = runner.calls[0];
			if (spec?.rawLogPath === undefined) throw new Error("no raw log path");
			await writeFile(spec.rawLogPath, "early\n");
			try {
				yield valid;
				await new Promise<never>(() => {});
			} finally {
				await tick(25);
				await appendFile(spec.rawLogPath, "late\n");
			}
		});

		await runAgentStep(deps, stepOf(runner));

		const recorded = (await store.read("r1")).find(
			(event) => event.type === "artifact.recorded",
		);
		if (recorded?.type !== "artifact.recorded") throw new Error("no artifact");
		expect(
			new TextDecoder().decode(
				await store.readArtifact(recorded.artifact.sha256),
			),
		).toBe("early\nlate\n");
	});

	it("records no raw artifact when the runner ignores rawLogPath", async () => {
		const { store, deps } = await setup();

		await runAgentStep(deps, stepOf(scripted(emits(valid))));

		const rawArtifacts = (await store.read("r1")).filter(
			(event) =>
				event.type === "artifact.recorded" &&
				event.artifact.kind === "agent-raw-log",
		);
		expect(rawArtifacts).toHaveLength(0);
	});
});
