import type { RunEventBody } from "@payo/contracts";
import { commit } from "./run.ts";
import type { RunState } from "./state.ts";
import type { RunStore } from "./store.ts";

export interface RunLog {
	current(): RunState;
	write(bodies: RunEventBody[]): Promise<RunState>;
}

/**
 * Serialises writes to one run, so each commit uses the latest seq. A failed write leaves the state as it was.
 * One open RunLog per run per process: a second writer leaves this log stale, and every later write fails.
 */
export function openRunLog(store: RunStore, state: RunState): RunLog {
	let current = state;
	let chain: Promise<unknown> = Promise.resolve();
	return {
		current: () => current,
		async write(bodies) {
			// shortcut: no resync on StaleSeqError, a second writer wedges the log until reopened; upgrade when step 5 runs more than one writer.
			// Clone now: commit parses the bodies in a later microtask. Inside async, a non-cloneable body rejects.
			const batch = structuredClone(bodies);
			const next = chain.then(async () => {
				current = await commit(store, current, batch);
				return current;
			});
			chain = next.catch(() => {});
			return next;
		},
	};
}
