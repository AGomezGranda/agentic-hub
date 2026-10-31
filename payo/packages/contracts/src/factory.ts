import { z } from "zod";
import { ArtifactRef, Id } from "./primitives.ts";

const unique = <T extends { id: string }>(items: T[]) =>
	new Set(items.map((item) => item.id)).size === items.length;
const text = z
	.string()
	.refine((value) => value.trim().length > 0, "must not be blank");
export const Ticket = z.object({
	key: Id,
	title: text,
	description: z.string(),
	url: z.string().nullable(),
});
export type Ticket = z.infer<typeof Ticket>;
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
	"Plan",
	"PlanReview",
	"Revise",
	"Approval",
	"Approved",
	"Escalated",
]);
export type FactoryStage = z.infer<typeof FactoryStage>;
export const FactoryCheckpoint = z.object({
	revision: z.int().nonnegative(),
	stage: FactoryStage,
	cycle: z.int().nonnegative(),
	round: z.int().nonnegative(),
	ticket: Ticket.nullable(),
	workspace: z.string().nullable(),
	plan: ArtifactRef.nullable(),
	lastAgentPlan: ArtifactRef.nullable(),
	answers: z.record(z.string(), z.string()),
	review: ArtifactRef.nullable(),
	approvalMetric: ArtifactRef.nullable(),
	inFlight: z
		.object({ stage: FactoryStage, stepIds: z.array(Id).min(1) })
		.nullable(),
});
export type FactoryCheckpoint = z.infer<typeof FactoryCheckpoint>;
export const PlanVersion = z.object({
	number: z.int().positive(),
	source: z.enum(["agent", "human", "answer"]),
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
export const FactoryRunConfig = z.object({
	ticketKey: Id,
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
export type FactoryRunConfig = z.infer<typeof FactoryRunConfig>;
