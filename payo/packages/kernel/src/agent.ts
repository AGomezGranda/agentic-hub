import type { AgentEvent, AgentSpec } from "@payo/contracts";

/** The kernel treats `result` and `error` as terminal, and never relies on `signal` being honoured. */
export interface AgentRunner {
	readonly id: string;
	run(spec: AgentSpec, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
