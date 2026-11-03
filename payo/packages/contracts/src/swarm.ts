import type { AttemptOutcome, RunEvent, StepOutcome } from "./run.ts";

type AttemptEvent = Extract<
	RunEvent,
	{ type: "attempt.started" | "attempt.event" | "attempt.finished" }
>;

export interface SwarmAttempt {
	id: string;
	role: string;
	model: string | null;
	status: "running" | AttemptOutcome;
	startedAt: string;
	finishedAt?: string;
	events: AttemptEvent[];
}

export interface SwarmStep {
	id: string;
	name: string;
	status: "started" | StepOutcome;
	attempts: SwarmAttempt[];
}

/**
 * Groups run events into steps and their attempts. Replays are deduplicated by seq.
 * Tolerant of unknown ids: the kernel rejects such sequences before they are stored,
 * and the event log is the only input.
 */
export function projectSwarm(events: readonly RunEvent[]): SwarmStep[] {
	const steps = new Map<string, SwarmStep>();
	const attempts = new Map<string, SwarmAttempt>();
	const seen = new Set<number>();
	for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
		if (seen.has(event.seq)) continue;
		seen.add(event.seq);
		if (event.type === "step.started")
			steps.set(event.stepId, {
				id: event.stepId,
				name: event.name,
				status: "started",
				attempts: [],
			});
		else if (event.type === "step.finished") {
			const step = steps.get(event.stepId);
			if (step) step.status = event.outcome;
		} else if (event.type === "attempt.started") {
			const attempt: SwarmAttempt = {
				id: event.attemptId,
				role: event.role,
				model: event.model,
				status: "running",
				startedAt: event.at,
				events: [event],
			};
			attempts.set(event.attemptId, attempt);
			steps.get(event.stepId)?.attempts.push(attempt);
		} else if (
			event.type === "attempt.event" ||
			event.type === "attempt.finished"
		) {
			const attempt = attempts.get(event.attemptId);
			if (!attempt) continue;
			attempt.events.push(event);
			if (event.type === "attempt.event") {
				// Display only: shows the model the runner reports. The kernel keeps the requested spec.model.
				if (event.event.type === "started" && event.event.model)
					attempt.model = event.event.model;
			} else {
				attempt.status = event.outcome;
				attempt.finishedAt = event.at;
			}
		}
	}
	return [...steps.values()];
}
