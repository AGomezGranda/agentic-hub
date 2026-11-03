import { projectSwarm, type RunEventBody } from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { fold } from "./state.ts";
import { body, seqd } from "./testing.ts";

// The web swarm view folds the same events the kernel folds. Compared: step and attempt ids and statuses only (not model or times).
const kernelView = (bodies: RunEventBody[]) => {
	const state = fold(seqd(bodies));
	return [...state.steps.values()].map((step) => ({
		id: step.stepId,
		status: step.status === "running" ? "started" : step.status,
		attempts: [...state.attempts.values()]
			.filter((attempt) => attempt.stepId === step.stepId)
			.map((attempt) => ({ id: attempt.attemptId, status: attempt.status })),
	}));
};

const swarmView = (bodies: RunEventBody[]) =>
	projectSwarm(seqd(bodies)).map((step) => ({
		id: step.id,
		status: step.status,
		attempts: step.attempts.map((attempt) => ({
			id: attempt.id,
			status: attempt.status,
		})),
	}));

const scenarios: Record<string, RunEventBody[]> = {
	"retry after a failed attempt": [
		body.runCreated(),
		body.stepStarted("s1"),
		body.attemptStarted("a1", "s1"),
		body.attemptFinished("a1", "failed"),
		body.attemptStarted("a2", "s1"),
		body.attemptFinished("a2"),
		body.stepFinished("s1"),
		body.runEnded(),
	],
	"parallel attempts that finish out of order": [
		body.runCreated(),
		body.stepStarted("s1"),
		body.attemptStarted("a1", "s1"),
		body.attemptStarted("a2", "s1"),
		body.attemptFinished("a2"),
		body.attemptFinished("a1", "failed"),
		body.stepFinished("s1", "failed"),
		body.runEnded(),
	],
	"step still running with an open attempt": [
		body.runCreated(),
		body.stepStarted("s1"),
		body.attemptStarted("a1", "s1"),
	],
	"escalated step with no attempts": [
		body.runCreated(),
		body.stepStarted("s1"),
		body.stepFinished("s1", "escalated"),
	],
};

describe("projectSwarm agrees with the kernel fold", () => {
	it.each(Object.entries(scenarios))("%s", (_name, bodies) => {
		expect(swarmView(bodies)).toEqual(kernelView(bodies));
	});
});
