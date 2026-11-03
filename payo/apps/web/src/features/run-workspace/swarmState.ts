import type { AttemptOutcome, RunEvent, StepOutcome } from "@payo/contracts";

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
	activity: string;
	events: AttemptEvent[];
}
export interface SwarmStep {
	id: string;
	name: string;
	status: "started" | StepOutcome;
	attempts: SwarmAttempt[];
}

export function activityLabel(
	event: Extract<RunEvent, { type: "attempt.event" }>["event"],
): string {
	switch (event.type) {
		case "tool_call":
			return `Tool call · ${event.name}`;
		case "tool_result":
			return `Tool result · ${event.name} · ${event.ok ? "ok" : "failed"}`;
		case "message":
			return "Agent message";
		case "result":
			return "Agent result";
		case "error":
			return "Agent error";
		case "usage":
			return "Usage recorded";
		case "started":
			return "Agent started";
	}
}

export function agentEventDetail(
	event: Extract<RunEvent, { type: "attempt.event" }>["event"],
): string | null {
	if (event.type === "message" || event.type === "result") return event.text;
	if (event.type === "error") return event.message;
	return null;
}

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
				activity: "Attempt started",
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
				attempt.activity = activityLabel(event.event);
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
