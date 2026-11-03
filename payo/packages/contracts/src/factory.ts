import { z } from "zod";
import { ArtifactRef, Id } from "./primitives.ts";

const unique = <T extends { id: string }>(items: T[]) =>
	new Set(items.map((item) => item.id)).size === items.length;
const text = z
	.string()
	.refine((value) => value.trim().length > 0, "must not be blank");
export const LegacyTicket = z.object({
	key: Id,
	title: text,
	description: z.string(),
	url: z.string().nullable(),
});
export type LegacyTicket = z.infer<typeof LegacyTicket>;
export const Ticket = LegacyTicket;
export type Ticket = LegacyTicket;

export const WorkItemRequest = z.discriminatedUnion("source", [
	z.object({ source: z.literal("jira"), key: text }),
	z.object({ source: z.literal("prompt"), text }),
]);
export type WorkItemRequest = z.infer<typeof WorkItemRequest>;
export const PersistedWorkItemRequest = z.discriminatedUnion("source", [
	z.object({ source: z.literal("jira"), key: text }),
	z.object({ source: z.literal("prompt"), artifact: ArtifactRef }),
]);
export type PersistedWorkItemRequest = z.infer<typeof PersistedWorkItemRequest>;
export const WorkItemOrigin = z.discriminatedUnion("source", [
	z.object({
		source: z.literal("jira"),
		key: text,
		url: z.string().nullable(),
	}),
	z.object({ source: z.literal("prompt") }),
]);
export type WorkItemOrigin = z.infer<typeof WorkItemOrigin>;
export const WorkItem = z.object({
	origin: WorkItemOrigin,
	title: text,
	description: z.string(),
});
export type WorkItem = z.infer<typeof WorkItem>;
export const OpenQuestion = z.object({ id: Id, question: text });
export type OpenQuestion = z.infer<typeof OpenQuestion>;
export const PlanOutput = z.object({
	markdown: text,
	prStrategy: z
		.array(z.object({ id: Id, title: text, phases: z.array(text) }))
		.min(1)
		.refine(unique, "duplicate PR id"),
	openQuestions: z.array(OpenQuestion).refine(unique, "duplicate question id"),
});
export type PlanOutput = z.infer<typeof PlanOutput>;
const Severity = z.enum(["P0", "P1", "P2"]);
export const Finding = z.object({
	id: Id,
	severity: Severity,
	title: text,
	path: z.string().nullable(),
	line: z.int().positive().nullable(),
	evidence: text,
	consequence: text,
	suggestedFix: text,
});
export type Finding = z.infer<typeof Finding>;
export const ReviewOutput = z.object({
	findings: z.array(Finding).refine(unique, "duplicate finding id"),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
export const VerifiedOutput = z.object({
	verdicts: z.array(
		z.object({
			sourceIds: z.array(Id).min(1),
			classification: z.enum([
				"BLOCKER",
				"NON-BLOCKER",
				"STALE",
				"INVALID",
				"SPECULATIVE",
			]),
			severity: Severity,
			reason: text,
			counterEvidence: z.string().nullable(),
		}),
	),
});
export type VerifiedOutput = z.infer<typeof VerifiedOutput>;
export const RevisionOutput = z.object({
	plan: PlanOutput,
	unreconciledFindingIds: z.array(Id),
});
export type RevisionOutput = z.infer<typeof RevisionOutput>;
export const FactoryStage = z.enum([
	"FetchTicket",
	"ResolveWorkItem",
	"Plan",
	"PlanReview",
	"Revise",
	"Approval",
	"Approved",
	"Escalated",
]);
export type FactoryStage = z.infer<typeof FactoryStage>;
const FactoryCheckpointSchema = z.object({
	revision: z.int().nonnegative(),
	stage: FactoryStage,
	cycle: z.int().nonnegative(),
	round: z.int().nonnegative(),
	workItem: WorkItem.nullable(),
	workspace: z.string().nullable(),
	plan: ArtifactRef.nullable(),
	lastAgentPlan: ArtifactRef.nullable(),
	answers: z.record(z.string(), z.string()),
	review: ArtifactRef.nullable(),
	approvalMetric: ArtifactRef.nullable(),
	pendingPlanUpdate: z
		.object({
			kind: z.enum(["prompt", "restore"]),
			base: ArtifactRef,
			expectedWorkingCopyHash: z.string(),
			prompt: ArtifactRef.nullable(),
			version: z.int().positive().nullable(),
			result: ArtifactRef.nullable(),
		})
		.nullable()
		.default(null),
	inFlight: z
		.object({ stage: FactoryStage, stepIds: z.array(Id).min(1) })
		.nullable(),
});
export const FactoryCheckpoint = z.preprocess((input) => {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return input;
	const value = input as Record<string, unknown>;
	if (value.workItem !== undefined || value.ticket === undefined) return input;
	const ticket = value.ticket;
	if (ticket === null) return { ...value, workItem: null };
	if (typeof ticket !== "object" || ticket === null || Array.isArray(ticket))
		return input;
	const legacy = ticket as Record<string, unknown>;
	return {
		...value,
		workItem: {
			origin: { source: "jira", key: legacy.key, url: legacy.url },
			title: legacy.title,
			description: legacy.description,
		},
	};
}, FactoryCheckpointSchema);
export type FactoryCheckpoint = z.infer<typeof FactoryCheckpointSchema>;
export const PlanVersion = z.object({
	number: z.int().positive(),
	source: z.enum(["agent", "human", "answer", "restore"]),
	markdown: ArtifactRef,
	plan: PlanOutput,
	answers: z.record(z.string(), z.string()),
});
export type PlanVersion = z.infer<typeof PlanVersion>;

const RoleSettings = z.object({
	model: z.string().nullable(),
	timeoutMs: z.int().positive(),
});
const RoleSources = z.object({
	path: text,
	sha: text,
});
const FactoryRunConfigSchema = z.object({
	workItemRequest: PersistedWorkItemRequest,
	roles: z.object({
		planner: RoleSettings,
		reviewer: RoleSettings,
		verifier: RoleSettings,
		reviser: RoleSettings,
	}),
	maxConcurrentAgents: z.int().positive(),
	roleArtifacts: z.object({
		planner: ArtifactRef,
		reviewer: ArtifactRef,
		verifier: ArtifactRef,
		reviser: ArtifactRef,
	}),
	lenses: z
		.array(text)
		.min(1)
		.refine((items) => new Set(items).size === items.length, "duplicate lens"),
	roleProvenance: z.object({
		planner: RoleSources,
		reviewer: RoleSources,
		verifier: RoleSources,
		reviser: RoleSources,
	}),
});
export const FactoryRunConfig = z.preprocess((input) => {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return input;
	const value = input as Record<string, unknown>;
	if (
		value.workItemRequest !== undefined ||
		typeof value.ticketKey !== "string"
	)
		return input;
	return {
		...value,
		workItemRequest: { source: "jira", key: value.ticketKey },
	};
}, FactoryRunConfigSchema);
export type FactoryRunConfig = z.infer<typeof FactoryRunConfigSchema>;
