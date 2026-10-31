import type { AgentEvent, AgentSpec } from "@payo/contracts";
import type { AgentRunner } from "@payo/kernel";

export type FakeStep =
	| { kind: "emit"; event: AgentEvent }
	| { kind: "hang"; ignoreSignal?: boolean }
	| { kind: "throw"; message: string };

export interface FakeRunner extends AgentRunner {
	readonly calls: readonly AgentSpec[];
}

/** Session N (1-based) plays scripts[N - 1]. Adapter and step 4–5 wiring tests only; modules never import it. */
export function createFakeRunner(
	scripts: readonly FakeStep[][],
	id = "fake",
): FakeRunner {
	const calls: AgentSpec[] = [];
	return {
		id,
		calls,
		run(spec, signal) {
			calls.push(spec);
			return play(scripts[calls.length - 1], signal, calls.length);
		},
	};
}

async function* play(
	script: FakeStep[] | undefined,
	signal: AbortSignal,
	session: number,
): AsyncGenerator<AgentEvent> {
	if (script === undefined) throw new Error(`no script for session ${session}`);
	for (const step of script) {
		if (step.kind === "emit") {
			yield step.event;
		} else if (step.kind === "throw") {
			throw new Error(step.message);
		} else if (step.ignoreSignal) {
			await new Promise<never>(() => {});
		} else {
			await untilAborted(signal);
			return;
		}
	}
}

function untilAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
