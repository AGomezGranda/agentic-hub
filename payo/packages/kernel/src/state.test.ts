import type { RunEventBody } from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { fold, reduce } from "./state.ts";
import { body, seqd, sha } from "./testing.ts";

// The gate recover() raises for an interrupted attempt.
const recoveryGate = (attemptId: string, stepId = "s1"): RunEventBody => ({
	type: "gate.raised",
	gateId: `interrupted:${attemptId}`,
	stepId,
	kind: "interrupted-attempt",
	allowedCommands: ["retry", "abandon"],
	reason: "attempt was running when the process stopped",
});

describe("fold", () => {
	it("folds a full happy path into an ended run", () => {
		const state = fold(
			seqd([
				body.runCreated("run-1"),
				body.stepStarted("s1"),
				body.attemptStarted("a1", "s1"),
				body.artifactRecorded(sha("a"), "a1"),
				body.attemptFinished("a1"),
				body.gateRaised("g1", "s1"),
				body.gateResolved("g1", "approve"),
				body.stepFinished("s1"),
				body.runEnded("approved"),
			]),
		);

		expect(state).toMatchObject({
			runId: "run-1",
			status: "ended",
			outcome: "approved",
			lastSeq: 9,
		});
		expect(state.steps.get("s1")?.status).toBe("succeeded");
		expect(state.attempts.get("a1")).toMatchObject({
			status: "succeeded",
			usage: { tokensIn: 1, tokensOut: 2, cost: "unknown" },
		});
		expect(state.gates.get("g1")).toMatchObject({
			status: "resolved",
			resolution: { command: "approve", note: null },
		});
		expect(state.artifacts).toHaveLength(1);
	});

	it("refuses run.ended while a gate is open, naming the gate", () => {
		const events = seqd([
			body.runCreated(),
			body.stepStarted("s1"),
			body.gateRaised("g1", "s1"),
			body.runEnded(),
		]);
		expect(() => fold(events)).toThrow(/g1/);
	});

	it("refuses run.ended while an attempt is running, naming the attempt", () => {
		const events = seqd([
			body.runCreated(),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			body.runEnded(),
		]);
		expect(() => fold(events)).toThrow(/a1/);
	});

	it("refuses run.ended while a step is running, naming the step", () => {
		const events = seqd([
			body.runCreated(),
			body.stepStarted("s1"),
			body.runEnded(),
		]);
		expect(() => fold(events)).toThrow(/s1/);
	});

	it("refuses an event before run.created", () => {
		expect(() => fold(seqd([body.stepStarted("s1")]))).toThrow(/run\.created/);
	});

	it("refuses a second run.created", () => {
		expect(() => fold(seqd([body.runCreated(), body.runCreated()]))).toThrow(
			/run\.created/,
		);
	});

	it("refuses any event after run.ended", () => {
		expect(() =>
			fold(seqd([body.runCreated(), body.runEnded(), body.stepStarted("s1")])),
		).toThrow(/ended/);
	});

	it("refuses a duplicate step id, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.stepStarted("s1"),
				]),
			),
		).toThrow(/s1/);
	});

	it("refuses an attempt on a finished step, naming the step", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.stepFinished("s1"),
					body.attemptStarted("a1", "s1"),
				]),
			),
		).toThrow(/s1/);
	});

	it("refuses to finish an attempt twice, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.attemptStarted("a1", "s1"),
					body.attemptFinished("a1"),
					body.attemptFinished("a1"),
				]),
			),
		).toThrow(/a1/);
	});

	it("refuses to resolve a gate twice, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.gateRaised("g1", "s1"),
					body.gateResolved("g1"),
					body.gateResolved("g1"),
				]),
			),
		).toThrow(/g1/);
	});

	it("refuses to finish a step that is not running, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.stepFinished("s1"),
					body.stepFinished("s1"),
				]),
			),
		).toThrow(/s1/);
	});

	it("refuses to finish a step while one of its attempts runs, naming the attempt", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.attemptStarted("a1", "s1"),
					body.stepFinished("s1"),
				]),
			),
		).toThrow(/a1/);
	});

	it("refuses a duplicate attempt id, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.attemptStarted("a1", "s1"),
					body.attemptStarted("a1", "s1"),
				]),
			),
		).toThrow(/a1/);
	});

	it("refuses a duplicate gate id, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.gateRaised("g1", "s1"),
					body.gateRaised("g1", "s1"),
				]),
			),
		).toThrow(/g1/);
	});

	it("refuses a gate on an unknown step, naming it", () => {
		expect(() =>
			fold(seqd([body.runCreated(), body.gateRaised("g1", "nope")])),
		).toThrow(/nope/);
	});

	it("refuses a gate id reserved for recovery, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.gateRaised("interrupted:a1", "s1"),
				]),
			),
		).toThrow(/interrupted:a1/);
	});

	it("refuses a step-recovery gate id used by any other kind, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.gateRaised("interrupted-step:s1:2", "s1"),
				]),
			),
		).toThrow(/interrupted-step:s1:2/);
	});

	it("refuses a step-recovery gate id that names another step, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					{
						type: "gate.raised",
						gateId: "interrupted-step:s2:2",
						stepId: "s1",
						kind: "interrupted-step",
						allowedCommands: ["retry"],
						reason: "x",
					},
				]),
			),
		).toThrow(/interrupted-step:s2:2/);
	});

	it("refuses a recovery gate for an attempt still running, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.attemptStarted("a1", "s1"),
					recoveryGate("a1"),
				]),
			),
		).toThrow(/interrupted:a1/);
	});

	it("accepts the recovery gate once recovery has finished the attempt", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.attemptStarted("a1", "s1"),
					body.attemptFinished("a1", "interrupted"),
					recoveryGate("a1"),
				]),
			),
		).not.toThrow();
	});

	it("refuses a recovery gate on a step other than the attempt's, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.stepStarted("s2"),
					body.attemptStarted("a1", "s1"),
					body.attemptFinished("a1", "interrupted"),
					recoveryGate("a1", "s2"),
				]),
			),
		).toThrow(/interrupted:a1/);
	});

	it("refuses a recovery gate that is not the interrupted-attempt kind, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.attemptStarted("a1", "s1"),
					body.attemptFinished("a1", "interrupted"),
					body.gateRaised("interrupted:a1", "s1"),
				]),
			),
		).toThrow(/interrupted:a1/);
	});

	it("refuses a resolve with a command the gate never offered, naming it", () => {
		expect(() =>
			fold(
				seqd([
					body.runCreated(),
					body.stepStarted("s1"),
					body.gateRaised("g1", "s1"),
					body.gateResolved("g1", "delete"),
				]),
			),
		).toThrow(/delete/);
	});

	it("refuses an artifact attached to an unknown attempt", () => {
		expect(() =>
			fold(seqd([body.runCreated(), body.artifactRecorded(sha("a"), "a9")])),
		).toThrow(/a9/);
	});

	it("keeps a duplicate artifact hash once", () => {
		const state = fold(
			seqd([
				body.runCreated(),
				body.artifactRecorded(sha("a")),
				body.artifactRecorded(sha("a")),
			]),
		);
		expect(state.artifacts).toHaveLength(1);
	});

	it("refuses an empty log", () => {
		expect(() => fold([])).toThrow();
	});
});

const agentEvent = (attemptId: string): RunEventBody => ({
	type: "attempt.event",
	attemptId,
	event: { type: "message", text: "hi" },
});

describe("reduce attempt.event", () => {
	const running = fold(
		seqd([
			body.runCreated(),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
		]),
	);

	it("advances lastSeq and leaves steps, attempts and gates unchanged", () => {
		const next = reduce(running, { ...agentEvent("a1"), seq: 4 });

		expect(next.lastSeq).toBe(4);
		expect(next.steps).toEqual(running.steps);
		expect(next.attempts).toEqual(running.attempts);
		expect(next.gates).toEqual(running.gates);
	});

	it("refuses an event on a finished attempt, naming it", () => {
		const done = reduce(running, { ...body.attemptFinished("a1"), seq: 4 });
		expect(() => reduce(done, { ...agentEvent("a1"), seq: 5 })).toThrow(
			/is not running/,
		);
	});

	it("refuses an event for an unknown attempt, naming it", () => {
		expect(() => reduce(running, { ...agentEvent("zz"), seq: 4 })).toThrow(
			/unknown attempt/,
		);
	});
});

describe("reduce", () => {
	it("does not mutate the state it is given", () => {
		const before = fold(
			seqd([
				body.runCreated(),
				body.stepStarted("s1"),
				body.attemptStarted("a1", "s1"),
			]),
		);
		const snapshot = structuredClone(before);

		const after = reduce(before, { ...body.attemptFinished("a1"), seq: 4 });

		expect(before).toEqual(snapshot);
		expect(after.attempts.get("a1")?.status).toBe("succeeded");
	});
});
