import { z } from "zod";
import { ExecutionSummary } from "./execution.ts";
import {
	Finding,
	OpenQuestion,
	VerifiedOutput,
	WorkItemRequest,
} from "./factory.ts";
import { Id } from "./primitives.ts";
import { GateRecord, RunEventSchema } from "./run.ts";

const nonBlank = z
	.string()
	.refine((value) => value.trim().length > 0, "must not be blank");

export const RunId = z.uuid();

export const StartRunRequest = z
	.object({
		workItemRequest: WorkItemRequest.optional(),
		ticketKey: nonBlank.optional(),
		repo: nonBlank.optional(),
		baseBranch: nonBlank.optional(),
	})
	.superRefine((value, context) => {
		if (value.workItemRequest && value.ticketKey) {
			context.addIssue({
				code: "custom",
				path: ["workItemRequest"],
				message: "provide only one work-item input",
			});
		} else if (!value.workItemRequest && !value.ticketKey) {
			context.addIssue({
				code: "custom",
				path: ["workItemRequest"],
				message: "work-item input required",
			});
		}
	})
	.transform(({ workItemRequest, ticketKey, ...overrides }) => ({
		...overrides,
		workItemRequest: workItemRequest ?? {
			source: "jira" as const,
			key: ticketKey as string,
		},
	}));
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export const ImplementRequest = z.object({
	prId: nonBlank,
	base: nonBlank.optional(),
});
export type ImplementRequest = z.infer<typeof ImplementRequest>;

export const AnswerRequest = z.object({
	questionId: nonBlank,
	text: nonBlank,
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

const concurrency = {
	expectedVersion: z.int().positive(),
	expectedWorkingCopyHash: z.string().regex(/^[0-9a-f]{64}$/),
};
export const PlanUpdateRequest = z.object({ ...concurrency, prompt: nonBlank });
export type PlanUpdateRequest = z.infer<typeof PlanUpdateRequest>;
export const PlanRestoreRequest = z.object({
	...concurrency,
	version: z.int().positive(),
});
export type PlanRestoreRequest = z.infer<typeof PlanRestoreRequest>;
export const PlanVersionDetail = z.object({
	number: z.int().positive(),
	source: z.enum(["agent", "human", "answer", "restore"]),
	markdown: z.string(),
	questions: z.array(OpenQuestion),
	answers: z.record(z.string(), z.string()),
});
export type PlanVersionDetail = z.infer<typeof PlanVersionDetail>;
export const PlanVersionList = z.object({
	versions: z.array(PlanVersionDetail),
});

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
	stage: nonBlank.nullable(),
	workItem: z
		.object({
			source: z.enum(["jira", "prompt"]),
			title: nonBlank,
			key: nonBlank.nullable(),
		})
		.nullable(),
	startedAt: z.string().min(1),
	updatedAt: z.string().min(1),
	openGates: z.array(OpenGateSummary),
	execution: ExecutionSummary.optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

const UnavailableReason = z.enum([
	"not_available",
	"missing",
	"unsafe",
	"invalid",
]);
const Unavailable = z.object({
	available: z.literal(false),
	reason: UnavailableReason,
});
export const RunReview = z.object({
	plan: z.discriminatedUnion("available", [
		Unavailable,
		z.object({
			available: z.literal(true),
			markdown: z.string(),
			editorPath: nonBlank.nullable(),
			questions: z.array(OpenQuestion),
			version: z.int().positive().optional(),
			workingCopyHash: z
				.string()
				.regex(/^[0-9a-f]{64}$/)
				.optional(),
		}),
	]),
	answers: z.record(z.string(), z.string()),
	review: z.discriminatedUnion("available", [
		Unavailable,
		z.object({
			available: z.literal(true),
			findings: z.array(Finding),
			uncheckedLenses: z.array(nonBlank),
			verdicts: VerifiedOutput.shape.verdicts.nullable(),
			provenance: z.literal("unknown"),
		}),
	]),
});
export type RunReview = z.infer<typeof RunReview>;

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
