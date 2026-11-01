import type { RunEvent } from "@payo/contracts";
import { expect, it } from "vitest";
import { projectSwarm } from "./swarmState.ts";

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
	expect(steps[0]?.attempts[0]?.activity).toBe("Agent message");
	expect(steps[1]?.attempts).toEqual([]);
});
