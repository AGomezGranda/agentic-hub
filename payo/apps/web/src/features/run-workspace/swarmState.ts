import type { RunEvent, SwarmAttempt } from "@payo/contracts";

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

/** The label of the attempt's latest agent event; "Attempt started" until one arrives. */
export function attemptActivity(attempt: SwarmAttempt): string {
	const latest = attempt.events
		.filter((event) => event.type === "attempt.event")
		.at(-1);
	return latest?.type === "attempt.event"
		? activityLabel(latest.event)
		: "Attempt started";
}
