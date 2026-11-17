import type { RunIdInput } from "@payo/contracts";
import { type Json, RunConfig, RunEventBody } from "@payo/contracts";
import { recover } from "../domain/recovery.ts";
import { fold, type RunState, reduce } from "../domain/state.ts";
import type { RunStore } from "./store.ts";

export { recover } from "../domain/recovery.ts";

/** Recursive merge of plain objects; arrays and scalars in `overrides` replace the defaults. */
export function resolveRunConfig(
	defaults: RunConfig,
	overrides: RunConfig = {},
): RunConfig {
	const merged = mergeObjects(defaults, overrides);
	rejectProtoKey(merged);
	return RunConfig.parse(merged);
}

function mergeObjects(
	base: Record<string, Json>,
	over: Record<string, Json>,
): Record<string, Json> {
	const out: Record<string, Json> = { ...base };
	for (const [key, value] of Object.entries(over)) {
		// Assigning this key sets the prototype, so the override would vanish without an error.
		if (key === "__proto__")
			throw new Error('config key "__proto__" is not allowed');
		const prev = out[key];
		out[key] =
			isObject(prev) && isObject(value) ? mergeObjects(prev, value) : value;
	}
	return out;
}

function isObject(value: unknown): value is Record<string, Json> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Zod drops an own `__proto__` key without an error, so this runs before the schema parse.
function rejectProtoKey(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) rejectProtoKey(item);
	} else if (isObject(value)) {
		if (Object.hasOwn(value, "__proto__"))
			throw new Error('config key "__proto__" is not allowed');
		for (const item of Object.values(value)) rejectProtoKey(item);
	}
}

/** Validates and folds every body before any write, so a bad batch never reaches the log. */
export async function commit(
	store: RunStore,
	state: RunState | null,
	bodies: RunEventBody[],
): Promise<RunState> {
	for (const body of bodies) {
		if (body.type === "run.created") rejectProtoKey(body.config);
	}
	const parsed = bodies.map((body) => RunEventBody.parse(body));
	const base = state?.lastSeq ?? 0;
	let next = state;
	for (const [i, body] of parsed.entries()) {
		next = reduce(next, { ...body, seq: base + i + 1 });
	}
	if (next === null) throw new Error("nothing to commit to a new run");
	await store.append(next.runId, parsed, base);
	return next;
}

export function startRun(
	store: RunStore,
	input: {
		runId: RunIdInput;
		repo: string;
		baseBranch: string;
		config: RunConfig;
	},
): Promise<RunState> {
	return commit(store, null, [{ type: "run.created", ...input }]);
}

export async function openRun(
	store: RunStore,
	runId: RunIdInput,
	options: { recover?: boolean } = {},
): Promise<RunState> {
	const events = await store.read(runId);
	if (events.length === 0) throw new Error(`run ${runId} not found`);
	const state = fold(events);
	return options.recover === false
		? state
		: commit(store, state, recover(state));
}
