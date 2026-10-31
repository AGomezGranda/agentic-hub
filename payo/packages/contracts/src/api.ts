import { z } from "zod";
import { FactoryStage } from "./factory.ts";
import { Id } from "./primitives.ts";
import { GateRecord, RunEventSchema } from "./run.ts";

const nonBlank = z
	.string()
	.refine((value) => value.trim().length > 0, "must not be blank");

export const RunId = z.uuid();

export const StartRunRequest = z.object({
	ticketKey: nonBlank,
	repo: nonBlank.optional(),
	baseBranch: nonBlank.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export const AnswerRequest = z.object({
	questionId: nonBlank,
	text: nonBlank,
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export const ApiError = z.object({ code: nonBlank, message: nonBlank });
export type ApiError = z.infer<typeof ApiError>;

export const DoctorCheck = z.object({
	name: Id,
	ok: z.boolean(),
	detail: z.string().max(512),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
	ok: z.boolean(),
	checks: z.array(DoctorCheck),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const OpenGateSummary = GateRecord.pick({
	gateId: true,
	stepId: true,
	kind: true,
	allowedCommands: true,
	reason: true,
});
export type OpenGateSummary = z.infer<typeof OpenGateSummary>;

export const RunSummary = z.object({
	runId: RunId,
	repo: z.string().min(1),
	baseBranch: z.string().min(1),
	status: z.enum(["active", "ended"]),
	outcome: z.string().nullable(),
	stage: FactoryStage.nullable(),
	startedAt: z.string().min(1),
	updatedAt: z.string().min(1),
	openGates: z.array(OpenGateSummary),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const RunSummaryList = z.object({ runs: z.array(RunSummary) });
export type RunSummaryList = z.infer<typeof RunSummaryList>;

export const StartRunResponse = z.object({ runId: RunId });
export type StartRunResponse = z.infer<typeof StartRunResponse>;

export const EventsResponse = z.object({ events: z.array(RunEventSchema) });
export type EventsResponse = z.infer<typeof EventsResponse>;

export const RunIdResponse = z.object({ runId: RunId });
export type RunIdResponse = z.infer<typeof RunIdResponse>;

/** Stable identifier used by the CLI and server before a run exists. */
export const TicketKey = Id;
