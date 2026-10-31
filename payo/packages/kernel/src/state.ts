import type {
	ArtifactRef,
	AttemptRecord,
	GateRecord,
	RunConfig,
	RunEvent,
	RunEventBody,
	StepRecord,
} from "@payo/contracts";

export interface RunState {
	runId: string;
	repo: string;
	baseBranch: string;
	config: RunConfig;
	status: "active" | "ended";
	outcome: string | null;
	lastSeq: number;
	steps: Map<string, StepRecord>;
	attempts: Map<string, AttemptRecord>;
	gates: Map<string, GateRecord>;
	artifacts: ArtifactRef[];
}

type Sequenced = RunEventBody & { seq: number };

// Pure: returns a new state and throws on any invariant break. Never mutates `state`.
export function reduce(state: RunState | null, event: Sequenced): RunState {
	if (state === null) {
		if (event.type !== "run.created") {
			throw new Error(`first event must be run.created, got ${event.type}`);
		}
		return {
			runId: event.runId,
			repo: event.repo,
			baseBranch: event.baseBranch,
			config: event.config,
			status: "active",
			outcome: null,
			lastSeq: event.seq,
			steps: new Map(),
			attempts: new Map(),
			gates: new Map(),
			artifacts: [],
		};
	}
	if (event.type === "run.created") {
		throw new Error(
			`run ${state.runId} already exists; run.created is allowed once`,
		);
	}
	if (state.status === "ended") {
		throw new Error(`run ${state.runId} has ended; cannot apply ${event.type}`);
	}
	// The maps are never mutated, so a lastSeq-only event can share them.
	if (event.type === "attempt.event") {
		requireRunning(state.attempts, event.attemptId, "attempt");
		return { ...state, lastSeq: event.seq };
	}

	const next: RunState = {
		...state,
		lastSeq: event.seq,
		steps: new Map(state.steps),
		attempts: new Map(state.attempts),
		gates: new Map(state.gates),
		artifacts: [...state.artifacts],
	};

	switch (event.type) {
		case "run.ended": {
			const running = [...state.attempts.values()].find(
				(a) => a.status === "running",
			);
			if (running)
				throw new Error(
					`run ${state.runId} has running attempt ${running.attemptId}`,
				);
			const open = [...state.gates.values()].find((g) => g.status === "open");
			if (open)
				throw new Error(`run ${state.runId} has open gate ${open.gateId}`);
			const runningStep = [...state.steps.values()].find(
				(s) => s.status === "running",
			);
			if (runningStep)
				throw new Error(
					`run ${state.runId} has running step ${runningStep.stepId}`,
				);
			next.status = "ended";
			next.outcome = event.outcome;
			return next;
		}
		case "step.started":
			assertFresh(state.steps, event.stepId, "step");
			next.steps.set(event.stepId, {
				stepId: event.stepId,
				name: event.name,
				status: "running",
			});
			return next;
		case "step.finished": {
			const step = requireRunning(state.steps, event.stepId, "step");
			const running = [...state.attempts.values()].find(
				(a) => a.stepId === event.stepId && a.status === "running",
			);
			if (running)
				throw new Error(
					`step ${event.stepId} has running attempt ${running.attemptId}`,
				);
			next.steps.set(event.stepId, { ...step, status: event.outcome });
			return next;
		}
		case "attempt.started":
			assertFresh(state.attempts, event.attemptId, "attempt");
			requireRunning(state.steps, event.stepId, "step");
			next.attempts.set(event.attemptId, {
				attemptId: event.attemptId,
				stepId: event.stepId,
				role: event.role,
				runner: event.runner,
				model: event.model,
				roleSpecSha: event.roleSpecSha,
				inputArtifacts: event.inputArtifacts,
				status: "running",
				usage: null,
			});
			return next;
		case "attempt.finished": {
			const attempt = requireRunning(
				state.attempts,
				event.attemptId,
				"attempt",
			);
			next.attempts.set(event.attemptId, {
				...attempt,
				status: event.outcome,
				usage: event.usage,
				error: event.error,
			});
			return next;
		}
		case "gate.raised":
			assertFresh(state.gates, event.gateId, "gate");
			requireRunning(state.steps, event.stepId, "step");
			if (event.gateId.startsWith("interrupted:")) {
				const attempt = state.attempts.get(
					event.gateId.slice("interrupted:".length),
				);
				if (
					event.kind !== "interrupted-attempt" ||
					attempt?.status !== "interrupted" ||
					attempt.stepId !== event.stepId
				)
					throw new Error(`gate id ${event.gateId} is reserved for recovery`);
			}
			if (
				event.gateId.startsWith("interrupted-step:") &&
				(event.kind !== "interrupted-step" ||
					!event.gateId.startsWith(`interrupted-step:${event.stepId}:`))
			)
				throw new Error(`gate id ${event.gateId} is reserved for recovery`);
			next.gates.set(event.gateId, {
				gateId: event.gateId,
				stepId: event.stepId,
				kind: event.kind,
				allowedCommands: event.allowedCommands,
				reason: event.reason,
				status: "open",
				resolution: null,
			});
			return next;
		case "gate.resolved": {
			const gate = requireKnown(state.gates, event.gateId, "gate");
			if (gate.status !== "open")
				throw new Error(`gate ${event.gateId} is not open`);
			if (!gate.allowedCommands.includes(event.command))
				throw new Error(
					`command "${event.command}" is not allowed on gate ${event.gateId}`,
				);
			next.gates.set(event.gateId, {
				...gate,
				status: "resolved",
				resolution: { command: event.command, note: event.note },
			});
			return next;
		}
		case "artifact.recorded":
			if (event.attemptId !== null)
				requireKnown(state.attempts, event.attemptId, "attempt");
			if (!state.artifacts.some((a) => a.sha256 === event.artifact.sha256)) {
				next.artifacts.push(event.artifact);
			}
			return next;
	}
}

export function fold(events: RunEvent[]): RunState {
	const [first, ...rest] = events;
	if (first === undefined) throw new Error("cannot fold an empty event log");
	let state = reduce(null, first);
	for (const event of rest) state = reduce(state, event);
	return state;
}

function assertFresh<T>(map: Map<string, T>, id: string, what: string): void {
	if (map.has(id)) throw new Error(`duplicate ${what} id ${id}`);
}

function requireKnown<T>(map: Map<string, T>, id: string, what: string): T {
	const value = map.get(id);
	if (value === undefined) throw new Error(`unknown ${what} ${id}`);
	return value;
}

function requireRunning<T extends { status: string }>(
	map: Map<string, T>,
	id: string,
	what: string,
): T {
	const value = requireKnown(map, id, what);
	if (value.status !== "running")
		throw new Error(`${what} ${id} is not running`);
	return value;
}
