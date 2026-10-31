import type { ArtifactRef, FactoryCheckpoint } from "@payo/contracts";
import type {
	AgentRunner,
	Limiter,
	RunLog,
	RunState,
	RunStore,
	TicketSource,
	Workspace,
} from "@payo/kernel";

export function required<T>(value: T | null | undefined, name: string): T {
	if (value == null) throw new Error(`missing ${name}`);
	return value;
}

export interface RoleSource {
	path: string;
	sha: string;
	content: string;
	resources: Record<string, string>;
}
export interface FactoryDeps {
	store: RunStore;
	runner: AgentRunner;
	limiter: Limiter;
	tickets: TicketSource;
	workspace: Workspace;
	dataDir: string;
	roleSources: Record<
		"planner" | "reviewer" | "verifier" | "reviser",
		RoleSource
	>;
}
export interface StartInput {
	runId: string;
	ticketKey: string;
	repo: string;
	baseBranch: string;
	roles: Record<
		"planner" | "reviewer" | "verifier" | "reviser",
		{ model: string | null; timeoutMs: number }
	>;
	maxConcurrentAgents: number;
	signal: AbortSignal;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends Map<infer K, infer V>
		? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
		: T extends Set<infer V>
			? ReadonlySet<DeepReadonly<V>>
			: T extends readonly (infer V)[]
				? readonly DeepReadonly<V>[]
				: T extends object
					? { readonly [P in keyof T]: DeepReadonly<T[P]> }
					: T;

/** Public handle: state reads are detached snapshots and the event log is read-only. */
export interface FactoryHandle {
	readonly checkpoint: DeepReadonly<FactoryCheckpoint>;
	readonly log: { current(): DeepReadonly<RunState> };
	readonly busy: boolean;
}

/** Mutable state is kept inside the factory implementation, not exposed to callers. */
export interface MutableFactoryHandle {
	deps: FactoryDeps;
	log: RunLog;
	checkpoint: FactoryCheckpoint;
	busy: boolean;
	roleArtifacts: Record<string, ArtifactRef>;
}

const mutableByHandle = new WeakMap<object, MutableFactoryHandle>();

export function createFactoryHandle(
	state: MutableFactoryHandle,
): FactoryHandle {
	const view = Object.freeze({
		get checkpoint() {
			return structuredClone(
				state.checkpoint,
			) as DeepReadonly<FactoryCheckpoint>;
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

export function mutableFactoryHandle(
	handle: FactoryHandle,
): MutableFactoryHandle {
	const state = mutableByHandle.get(handle);
	if (!state) throw new TypeError("invalid factory handle");
	return state;
}
