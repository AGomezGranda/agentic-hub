import type { PublicationCheckpoint } from "@payo/contracts";
import type {
	CodeHost,
	ExecutionWorkspace,
	RepositoryPublication,
	RunLog,
	RunState,
	RunStore,
} from "@payo/kernel";
import type { DeepReadonly } from "../types.ts";
export interface PublicationDeps {
	store: RunStore;
	newId: () => string;
	workspace: Pick<ExecutionWorkspace, "inspect">;
	repository: RepositoryPublication;
	codeHost: CodeHost;
}
export interface PublicationHandle {
	readonly checkpoint: DeepReadonly<PublicationCheckpoint>;
	readonly log: { current(): DeepReadonly<RunState> };
	readonly busy: boolean;
}
export interface MutablePublication {
	deps: PublicationDeps;
	log: RunLog;
	checkpoint: PublicationCheckpoint;
	busy: boolean;
}
const states = new WeakMap<object, MutablePublication>();
export function publicationHandle(
	state: MutablePublication,
): PublicationHandle {
	const handle = Object.freeze({
		get checkpoint() {
			return structuredClone(state.checkpoint);
		},
		log: Object.freeze({ current: () => structuredClone(state.log.current()) }),
		get busy() {
			return state.busy;
		},
	});
	states.set(handle, state);
	return handle;
}
export function mutablePublication(
	handle: PublicationHandle,
): MutablePublication {
	const state = states.get(handle);
	if (!state) throw new TypeError("invalid publication handle");
	return state;
}
