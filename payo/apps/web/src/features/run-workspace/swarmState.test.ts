import type { RunEvent, SwarmAttempt } from "@payo/contracts";
import { expect, it } from "vitest";
import { attemptActivity } from "./swarmState.ts";

function attemptWith(events: RunEvent[]): SwarmAttempt {
	return {
		id: "a",
		role: "reviewer",
		model: null,
		status: "running",
		startedAt: "2026-11-01T00:00:00Z",
		events: events as SwarmAttempt["events"],
	};
}

it("labels an attempt by its latest agent event, or as started", () => {
	const started = {
		seq: 1,
		type: "attempt.started",
		attemptId: "a",
		stepId: "s",
		role: "reviewer",
		model: null,
		at: "2026-11-01T00:00:00Z",
	} as RunEvent;
	const message = {
		seq: 2,
		type: "attempt.event",
		attemptId: "a",
		event: { type: "message", text: "secret" },
		at: "2026-11-01T00:00:00Z",
	} as RunEvent;
	expect(attemptActivity(attemptWith([started]))).toBe("Attempt started");
	expect(attemptActivity(attemptWith([started, message]))).toBe(
		"Agent message",
	);
});

it("keeps the latest activity after the attempt finishes", () => {
	const message = {
		seq: 2,
		type: "attempt.event",
		attemptId: "a",
		event: { type: "message", text: "done" },
		at: "2026-11-01T00:00:00Z",
	} as RunEvent;
	const finished = {
		seq: 3,
		type: "attempt.finished",
		attemptId: "a",
		outcome: "succeeded",
		at: "2026-11-01T00:00:01Z",
	} as RunEvent;
	expect(attemptActivity(attemptWith([message, finished]))).toBe(
		"Agent message",
	);
});

it("labels by the most recent agent event, not the first", () => {
	const call = {
		seq: 2,
		type: "attempt.event",
		attemptId: "a",
		event: { type: "tool_call", callId: "c1", name: "grep" },
		at: "2026-11-01T00:00:00Z",
	} as RunEvent;
	const message = {
		seq: 3,
		type: "attempt.event",
		attemptId: "a",
		event: { type: "message", text: "hi" },
		at: "2026-11-01T00:00:00Z",
	} as RunEvent;
	expect(attemptActivity(attemptWith([call, message]))).toBe("Agent message");
	expect(attemptActivity(attemptWith([message, call]))).toBe(
		"Tool call · grep",
	);
});
