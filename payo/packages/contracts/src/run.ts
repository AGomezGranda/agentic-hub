import { z } from "zod";
import { AgentEvent } from "./agent.ts";
import {
	ArtifactRef,
	Id,
	RunConfig,
	Sha256,
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
		runId: Id,
		repo: z.string().min(1),
		baseBranch: z.string().min(1),
		config: RunConfig,
	}),
	z.object({ type: z.literal("run.ended"), outcome: z.string().min(1) }),
	z.object({
		type: z.literal("step.started"),
		stepId: Id,
		name: z.string().min(1),
	}),
	z.object({
		type: z.literal("step.finished"),
		stepId: Id,
		outcome: StepOutcome,
	}),
	z.object({
		type: z.literal("attempt.started"),
		attemptId: Id,
		stepId: Id,
		role: Id,
		runner: Id,
		model: z.string().min(1).nullable(),
		roleSpecSha: z.string().min(1).nullable(),
		inputArtifacts: z.array(Sha256),
	}),
	z.object({
		type: z.literal("attempt.event"),
		attemptId: Id,
		event: AgentEvent,
	}),
	z.object({
		type: z.literal("attempt.finished"),
		attemptId: Id,
		outcome: AttemptOutcome,
		usage: UsageRecord,
		error: z.string().optional(),
	}),
	z.object({
		type: z.literal("gate.raised"),
		gateId: Id,
		stepId: Id,
		kind: z.string().min(1),
		allowedCommands: z.array(Id).min(1),
		reason: z.string(),
	}),
	z.object({
		type: z.literal("gate.resolved"),
		gateId: Id,
		command: Id,
		note: z.string().nullable(),
	}),
	z.object({
		type: z.literal("artifact.recorded"),
		artifact: ArtifactRef,
		attemptId: Id.nullable(),
	}),
]);
export type RunEventBody = z.infer<typeof RunEventBody>;

// Written by the store, never by callers.
export type RunEvent = RunEventBody & { seq: number; at: string };

export const StepRecord = z.object({
	stepId: Id,
	name: z.string().min(1),
	status: z.union([z.literal("running"), StepOutcome]),
});
export type StepRecord = z.infer<typeof StepRecord>;

export const AttemptRecord = z.object({
	attemptId: Id,
	stepId: Id,
	role: Id,
	runner: Id,
	model: z.string().min(1).nullable(),
	roleSpecSha: z.string().min(1).nullable(),
	inputArtifacts: z.array(Sha256),
	status: z.union([z.literal("running"), AttemptOutcome]),
	usage: UsageRecord.nullable(),
	error: z.string().optional(),
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

export const GateRecord = z.object({
	gateId: Id,
	stepId: Id,
	kind: z.string().min(1),
	allowedCommands: z.array(Id).min(1),
	reason: z.string(),
	status: z.enum(["open", "resolved"]),
	resolution: z.object({ command: Id, note: z.string().nullable() }).nullable(),
});
export type GateRecord = z.infer<typeof GateRecord>;
