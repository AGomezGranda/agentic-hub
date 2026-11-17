import { z } from "zod";
import { AgentEvent } from "./agent.ts";
import type {
	AttemptIdInput,
	GateIdInput,
	RunIdInput,
	StepIdInput,
} from "./primitives.ts";
import {
	ArtifactRef,
	AttemptId,
	GateId,
	Id,
	ModelId,
	RunConfig,
	RunId,
	Sha256,
	StepId,
	UsageRecord,
} from "./primitives.ts";

export const AttemptOutcome = z.enum([
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

export const StepOutcome = z.enum(["succeeded", "failed", "escalated"]);
export type StepOutcome = z.infer<typeof StepOutcome>;

export const RunEventBody = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("run.created"),
		runId: RunId,
		repo: z.string().min(1),
		baseBranch: z.string().min(1),
		config: RunConfig,
	}),
	z.object({ type: z.literal("run.ended"), outcome: z.string().min(1) }),
	z.object({
		type: z.literal("step.started"),
		stepId: StepId,
		name: z.string().min(1),
	}),
	z.object({
		type: z.literal("step.finished"),
		stepId: StepId,
		outcome: StepOutcome,
	}),
	z.object({
		type: z.literal("attempt.started"),
		attemptId: AttemptId,
		stepId: StepId,
		role: Id,
		runner: Id,
		model: ModelId.nullable(),
		roleSpecSha: z.string().min(1).nullable(),
		inputArtifacts: z.array(Sha256),
	}),
	z.object({
		type: z.literal("attempt.event"),
		attemptId: AttemptId,
		event: AgentEvent,
	}),
	z.object({
		type: z.literal("attempt.finished"),
		attemptId: AttemptId,
		outcome: AttemptOutcome,
		usage: UsageRecord,
		error: z.string().optional(),
	}),
	z.object({
		type: z.literal("gate.raised"),
		gateId: GateId,
		stepId: StepId,
		kind: z.string().min(1),
		allowedCommands: z.array(Id).min(1),
		reason: z.string(),
	}),
	z.object({
		type: z.literal("gate.resolved"),
		gateId: GateId,
		command: Id,
		note: z.string().nullable(),
	}),
	z.object({
		type: z.literal("artifact.recorded"),
		artifact: ArtifactRef,
		attemptId: AttemptId.nullable(),
	}),
]);
type EventInput<T> = T extends unknown
	? {
			[K in keyof T]: K extends "runId"
				? RunIdInput
				: K extends "stepId"
					? StepIdInput
					: K extends "attemptId"
						? AttemptIdInput | Extract<T[K], null>
						: K extends "gateId"
							? GateIdInput
							: T[K];
		}
	: never;
export type RunEventBody = EventInput<z.input<typeof RunEventBody>>;

// Written by the store, never by callers.
export const RunEventSchema = RunEventBody.and(
	z.object({ seq: z.int().positive(), at: z.string().min(1) }),
);
export type RunEvent = z.output<typeof RunEventBody> & {
	seq: number;
	at: string;
};

export const StepRecord = z.object({
	stepId: StepId,
	name: z.string().min(1),
	status: z.union([z.literal("running"), StepOutcome]),
});
export type StepRecord = z.infer<typeof StepRecord>;

export const AttemptRecord = z.object({
	attemptId: AttemptId,
	stepId: StepId,
	role: Id,
	runner: Id,
	model: ModelId.nullable(),
	roleSpecSha: z.string().min(1).nullable(),
	inputArtifacts: z.array(Sha256),
	status: z.union([z.literal("running"), AttemptOutcome]),
	usage: UsageRecord.nullable(),
	error: z.string().optional(),
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

export const GateRecord = z.object({
	gateId: GateId,
	stepId: StepId,
	kind: z.string().min(1),
	allowedCommands: z.array(Id).min(1),
	reason: z.string(),
	status: z.enum(["open", "resolved"]),
	resolution: z.object({ command: Id, note: z.string().nullable() }).nullable(),
});
export type GateRecord = z.infer<typeof GateRecord>;
