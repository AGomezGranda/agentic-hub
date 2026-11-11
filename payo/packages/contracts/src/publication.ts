import { z } from "zod";
import { ArtifactRef } from "./primitives.ts";
import {
	GitHubTarget,
	PublicationCommit,
	PullRequestRecord,
} from "./publication-records.ts";

export const PublicationPolicy = z.strictObject({
	remote: z.string(),
	branchTemplate: z.string(),
	commitTemplate: z.string(),
	prTitleTemplate: z.string(),
	prBodyTemplate: z.string(),
});
export type PublicationPolicy = z.infer<typeof PublicationPolicy>;

export const ExecutionNamingSnapshot = z.strictObject({
	version: z.literal(1),
	ticketId: z.string().nullable(),
	slug: z.string(),
	branch: z.string(),
	policy: PublicationPolicy,
});
export type ExecutionNamingSnapshot = z.infer<typeof ExecutionNamingSnapshot>;

export const ImplementPreviewRequest = z.strictObject({
	prId: z.string().trim().min(1),
	base: z.string().trim().min(1).optional(),
	ticketId: z.string().nullable().optional(),
	slug: z.string().optional(),
});
export type ImplementPreviewRequest = z.infer<typeof ImplementPreviewRequest>;

export const ImplementPreview = z.strictObject({
	baseCommit: z.string().optional(),
	candidates: z.array(z.string()),
	ticketId: z.string().nullable().optional(),
	slug: z.string(),
	branch: z.string().optional(),
	commitSubject: z.string().optional(),
	prTitle: z.string().optional(),
	errors: z.record(z.string(), z.string()),
	previewHash: z.string().optional(),
});
export type ImplementPreview = z.infer<typeof ImplementPreview>;

export const ExecutionNamingRequest = z.strictObject({
	slug: z.string(),
	previewHash: z.string().min(1).optional(),
});
export type ExecutionNamingRequest = z.infer<typeof ExecutionNamingRequest>;

export const PublicationRunConfig = z.strictObject({
	kind: z.literal("factory-publication"),
	sourceRunId: z.string().min(1),
	executionRunId: z.string().min(1),
	plan: ArtifactRef,
	reviewedCommit: z.string().min(1),
	baseCommit: z.string().min(1),
	branch: z.string().min(1),
	worktree: z.string().min(1),
	target: GitHubTarget,
	pushUrl: z.string().min(1),
	title: z.string().min(1),
	body: z.string(),
	previewHash: z.string().min(1),
});
export type PublicationRunConfig = z.infer<typeof PublicationRunConfig>;
export const PublicationStage = z.enum([
	"Push",
	"CreatePr",
	"Escalated",
	"Completed",
]);
export const PublicationCheckpoint = z.strictObject({
	revision: z.int().nonnegative(),
	stage: PublicationStage,
	intent: z.enum(["Push", "CreatePr"]).nullable(),
	observedRemoteSha: z.string().nullable(),
	pr: PullRequestRecord.nullable(),
	pausedOperation: z.enum(["Push", "CreatePr"]).nullable(),
	reason: z.string().nullable(),
});
export type PublicationCheckpoint = z.infer<typeof PublicationCheckpoint>;
export const PublicationSummary = z.strictObject({
	sourceRunId: z.string(),
	executionRunId: z.string(),
	stage: PublicationStage,
	branch: z.string(),
	reviewedCommit: z.string(),
	target: GitHubTarget,
	pr: PullRequestRecord.nullable(),
	reason: z.string().nullable(),
});
export type PublicationSummary = z.infer<typeof PublicationSummary>;
export const PublicationPreviewRequest = z.strictObject({});
export type PublicationPreviewRequest = z.infer<
	typeof PublicationPreviewRequest
>;
export const PublicationPreview = z.strictObject({
	executionRunId: z.string(),
	eligible: z.boolean(),
	errors: z.array(z.string()),
	previewHash: z.string().optional(),
	target: GitHubTarget.optional(),
	branch: z.string().optional(),
	reviewedCommit: z.string().optional(),
	baseCommit: z.string().optional(),
	pushUrl: z.string().optional(),
	title: z.string().optional(),
	body: z.string().optional(),
	commits: z.array(PublicationCommit),
});
export type PublicationPreview = z.infer<typeof PublicationPreview>;
export const PublishRequest = z.strictObject({
	previewHash: z.string().min(1),
	title: z.string().optional(),
	body: z.string().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const PublicationFinalResult = z.object({
	resultCommit: z.string().min(1),
	summary: z.string().min(1),
	report: ArtifactRef,
	checks: ArtifactRef,
	review: ArtifactRef,
	phaseReceipts: z.array(ArtifactRef).min(1),
});
export const PublicationChecks = z.object({
	results: z
		.array(z.object({ name: z.string().min(1), status: z.literal("passed") }))
		.min(1),
});
