import type { AgentEvent, AgentSpec } from "@payo/contracts";

/**
 * The kernel treats `result` and `error` as terminal, and never relies on `signal` being honoured.
 * Usage events are cumulative replacement snapshots for the whole attempt, and the last one must be
 * emitted before the terminal event.
 */
export interface AgentRunner {
	readonly id: string;
	run(spec: AgentSpec, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
