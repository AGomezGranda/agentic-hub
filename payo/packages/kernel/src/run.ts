import { type Json, RunConfig, RunEventBody } from "@payo/contracts";
import { fold, type RunState, reduce } from "./state.ts";
import type { RunStore } from "./store.ts";

type GateRaise = Omit<Extract<RunEventBody, { type: "gate.raised" }>, "type">;

/** Recursive merge of plain objects; arrays and scalars in `overrides` replace the defaults. */
export function resolveRunConfig(
	defaults: RunConfig,
	overrides: RunConfig = {},
): RunConfig {
	return RunConfig.parse(mergeObjects(defaults, overrides));
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

// Kernel policy only; the reducer enforces the rest (ended run, unknown or duplicate id) at commit.
export function decideGateRaise(
	state: RunState,
	gate: GateRaise,
): RunEventBody[] {
	const step = state.steps.get(gate.stepId);
	if (step?.status !== "running")
		throw new Error(`step ${gate.stepId} is not running`);
	return [{ type: "gate.raised", ...gate }];
}

export function decideGateResolve(
	state: RunState,
	input: { gateId: string; command: string; note: string | null },
): RunEventBody[] {
	const gate = state.gates.get(input.gateId);
	if (gate === undefined) throw new Error(`unknown gate ${input.gateId}`);
	if (gate.status !== "open")
		throw new Error(`gate ${input.gateId} is not open`);
	if (!gate.allowedCommands.includes(input.command)) {
		throw new Error(
			`command "${input.command}" is not allowed on gate ${input.gateId}`,
		);
	}
	return [
		{
			type: "gate.resolved",
			gateId: input.gateId,
			command: input.command,
			note: input.note,
		},
	];
}

/**
 * Startup only: a running attempt after a restart was interrupted, and a running step with no running attempt
 * and no open gate (the window between attempts) gets a gate. Returns [] once nothing is left to gate.
 */
export function recover(state: RunState): RunEventBody[] {
	const bodies: RunEventBody[] = [];
	for (const attempt of state.attempts.values()) {
		if (attempt.status !== "running") continue;
		bodies.push({
			type: "attempt.finished",
			attemptId: attempt.attemptId,
			outcome: "interrupted",
			usage: { tokensIn: "unknown", tokensOut: "unknown", cost: "unknown" },
		});
		bodies.push({
			type: "gate.raised",
			gateId: `interrupted:${attempt.attemptId}`,
			stepId: attempt.stepId,
			kind: "interrupted-attempt",
			allowedCommands: ["retry", "abandon"],
			reason: "attempt was running when the process stopped",
		});
	}
	for (const step of state.steps.values()) {
		if (step.status !== "running") continue;
		const busy = [...state.attempts.values()].some(
			(a) => a.stepId === step.stepId && a.status === "running",
		);
		const gated = [...state.gates.values()].some(
			(g) => g.stepId === step.stepId && g.status === "open",
		);
		if (busy || gated) continue;
		// The seq suffix keeps the id unique if a resolved gate is followed by another crash in the same window.
		bodies.push({
			type: "gate.raised",
			gateId: `interrupted-step:${step.stepId}:${state.lastSeq}`,
			stepId: step.stepId,
			kind: "interrupted-step",
			allowedCommands: ["retry", "abandon"],
			reason: "step had no running attempt when the process stopped",
		});
	}
	return bodies;
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
	input: { runId: string; repo: string; baseBranch: string; config: RunConfig },
): Promise<RunState> {
	return commit(store, null, [{ type: "run.created", ...input }]);
}

export async function openRun(
	store: RunStore,
	runId: string,
): Promise<RunState> {
	const events = await store.read(runId);
	if (events.length === 0) throw new Error(`run ${runId} not found`);
	const state = fold(events);
	return commit(store, state, recover(state));
}
