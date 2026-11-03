import type { ExecutionCheckpoint } from "@payo/contracts";
import type {
	AgentRunner,
	Checks,
	ExecutionWorkspace,
	Limiter,
	RunLog,
	RunState,
	RunStore,
} from "@payo/kernel";
import type { DeepReadonly } from "./types.ts";

export interface ExecutionReviewRoleSnapshots {
	roleArtifacts: Record<
		"scout" | "reviewer" | "verifier",
		import("@payo/contracts").ArtifactRef
	>;
	roles: Record<
		"scout" | "reviewer" | "verifier",
		{ model: string | null; timeoutMs: number }
	>;
}

export interface ExecutionDeps {
	store: RunStore;
	runner?: AgentRunner;
	limiter?: Limiter;
	workspace?: ExecutionWorkspace;
	checks?: Checks;
	dataDir?: string;
	loadReviewRoleSnapshots?: (
		sourceRunId: string,
		pinnedBase: string,
	) => Promise<ExecutionReviewRoleSnapshots>;
}

/** Public handle snapshots are detached; only factory-local collaborators mutate state. */
export interface ExecutionHandle {
	readonly checkpoint: DeepReadonly<ExecutionCheckpoint>;
	readonly log: { current(): DeepReadonly<RunState> };
	readonly busy: boolean;
}

export interface MutableExecutionHandle {
	deps: ExecutionDeps;
	log: RunLog;
	checkpoint: ExecutionCheckpoint;
	busy: boolean;
}

const mutableByHandle = new WeakMap<object, MutableExecutionHandle>();

export function createExecutionHandle(
	state: MutableExecutionHandle,
): ExecutionHandle {
	const view = Object.freeze({
		get checkpoint() {
			return structuredClone(
				state.checkpoint,
			) as DeepReadonly<ExecutionCheckpoint>;
		},
		log: Object.freeze({
			current: () =>
				structuredClone(state.log.current()) as DeepReadonly<RunState>,
		}),
		get busy() {
			return state.busy;
		},
	});
	mutableByHandle.set(view, state);
	return view;
}

export function mutableExecutionHandle(
	handle: ExecutionHandle,
): MutableExecutionHandle {
	const state = mutableByHandle.get(handle);
	if (!state) throw new TypeError("invalid execution handle");
	return state;
}
