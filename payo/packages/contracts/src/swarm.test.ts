import { expect, it } from "vitest";
import type { RunEvent } from "./run.ts";
import { projectSwarm } from "./swarm.ts";

it("projects parallel attempts, retries and waiting steps without duplicating events", () => {
	const events = [
		{ seq: 1, type: "step.started", stepId: "s", name: "Review" },
		{ seq: 2, type: "step.started", stepId: "waiting", name: "Plan" },
		{
			seq: 3,
			type: "attempt.started",
			attemptId: "a",
			stepId: "s",
			role: "reviewer",
			model: "m",
		},
		{
			seq: 4,
			type: "attempt.started",
			attemptId: "b",
			stepId: "s",
			role: "security",
			model: null,
		},
		{
			seq: 5,
			type: "attempt.event",
			attemptId: "a",
			event: { type: "message", text: "secret" },
		},
		{ seq: 6, type: "attempt.finished", attemptId: "a", outcome: "failed" },
		{
			seq: 7,
			type: "attempt.started",
			attemptId: "c",
			stepId: "s",
			role: "reviewer",
			model: "m",
		},
		{ seq: 8, type: "attempt.finished", attemptId: "c", outcome: "succeeded" },
	].map((event) => ({ ...event, at: "2026-11-01T00:00:00Z" })) as RunEvent[];
	const steps = projectSwarm([...events, events[4] as RunEvent]);
	expect(projectSwarm([])).toEqual([]);
	expect(steps[0]?.attempts.map((attempt) => attempt.status)).toEqual([
		"failed",
		"running",
		"succeeded",
	]);
	expect(steps[0]?.attempts[0]?.events).toHaveLength(3);
	expect(steps[1]?.attempts).toEqual([]);
});

it("shows the model the runner reports, and a later null report does not erase it", () => {
	const [step] = projectSwarm([
		{ seq: 1, type: "step.started", stepId: "s", name: "Review", at: "t" },
		{
			seq: 2,
			type: "attempt.started",
			attemptId: "a",
			stepId: "s",
			role: "reviewer",
			model: null,
			at: "t",
		},
		{
			seq: 3,
			type: "attempt.event",
			attemptId: "a",
			event: { type: "started", model: "gpt-x" },
			at: "t",
		},
		{
			seq: 4,
			type: "attempt.event",
			attemptId: "a",
			event: { type: "started", model: null },
			at: "t",
		},
	] as RunEvent[]);
	expect(step?.attempts[0]?.model).toBe("gpt-x");
});

it("ignores attempts and finishes for unknown steps", () => {
	expect(
		projectSwarm([
			{ seq: 1, type: "step.started", stepId: "s", name: "Review", at: "t" },
			{
				seq: 2,
				type: "attempt.started",
				attemptId: "a",
				stepId: "nope",
				role: "reviewer",
				model: null,
				at: "t",
			},
			{
				seq: 3,
				type: "step.finished",
				stepId: "nope",
				outcome: "failed",
				at: "t",
			},
		] as RunEvent[]),
	).toEqual([{ id: "s", name: "Review", status: "started", attempts: [] }]);
});

it("keeps attempt start and finish times and ignores events for unknown attempts", () => {
	const events = [
		{ seq: 1, type: "step.started", stepId: "s", name: "Review", at: "t1" },
		{
			seq: 2,
			type: "attempt.started",
			attemptId: "a",
			stepId: "s",
			role: "reviewer",
			model: null,
			at: "t2",
		},
		{
			seq: 3,
			type: "attempt.event",
			attemptId: "ghost",
			event: { type: "message", text: "orphan" },
			at: "t3",
		},
		{
			seq: 4,
			type: "attempt.finished",
			attemptId: "a",
			outcome: "succeeded",
			at: "t4",
		},
	] as RunEvent[];
	const [step] = projectSwarm(events);
	expect(step?.attempts).toEqual([
		expect.objectContaining({
			id: "a",
			status: "succeeded",
			startedAt: "t2",
			finishedAt: "t4",
			events: [events[1], events[3]],
		}),
	]);
});
