import { z } from "zod";
import { Finding } from "./factory.ts";
import { ArtifactRef, Id } from "./primitives.ts";
import { ExecutionNamingSnapshot } from "./publication.ts";

const text = z
	.string()
	.refine((value) => value.trim().length > 0, "must not be blank");
const uniqueStrings = (items: string[]) => new Set(items).size === items.length;
const unique = <T extends { id: string }>(items: T[]) =>
	new Set(items.map((item) => item.id)).size === items.length;
const MAX_TIMEOUT_MS = 2_147_483_647;

export const ExecutionCheck = z.strictObject({
	name: text,
	command: text,
	args: z.array(z.string()),
	timeout_ms: z.int().positive().max(MAX_TIMEOUT_MS),
});
export type ExecutionCheck = z.infer<typeof ExecutionCheck>;

export const ExecutionStage = z.enum([
	"Prepare",
	"Implement",
	"Check",
	"Review",
	"Repair",
	"Finalize",
	"Escalated",
	"Completed",
]);
export type ExecutionStage = z.infer<typeof ExecutionStage>;

export const ExecutionScope = z.enum(["phase", "final"]);
export type ExecutionScope = z.infer<typeof ExecutionScope>;

export const ExecutionPhase = z.object({
	id: Id,
	title: text,
	planExcerpt: text,
	acceptanceCriteria: z.array(text).min(1).refine(uniqueStrings, "duplicate"),
});
export type ExecutionPhase = z.infer<typeof ExecutionPhase>;

export const ExecutionPrerequisite = z
	.object({
		description: text,
		ref: text.optional(),
		paths: z.array(text).min(1).optional(),
	})
	.refine(
		(value) => value.ref !== undefined || value.paths !== undefined,
		"prerequisite requires ref or paths",
	);
export type ExecutionPrerequisite = z.infer<typeof ExecutionPrerequisite>;

/** The executable projection of one approved PR unit. */
export const ExecutionManifest = z.object({
	pr: z.object({ id: Id, title: text }),
	phases: z.array(ExecutionPhase).min(1).refine(unique, "duplicate phase id"),
	prerequisites: z.array(ExecutionPrerequisite),
	issues: z.array(text),
});
export type ExecutionManifest = z.infer<typeof ExecutionManifest>;

export const ImplementationOutput = z.object({
	summary: text,
	completedCriteria: z.array(text),
	planIssues: z.array(text),
});
export type ImplementationOutput = z.infer<typeof ImplementationOutput>;

export const ExecutionScopeMap = z.object({
	summary: text,
	files: z
		.array(
			z.object({
				path: text,
				purpose: text,
				instructionPaths: z.array(text),
			}),
		)
		.refine(
			(items) => new Set(items.map((item) => item.path)).size === items.length,
			"duplicate changed path",
		),
	planIssues: z.array(text),
});
export type ExecutionScopeMap = z.infer<typeof ExecutionScopeMap>;

export const ImplementationReviewOutput = z.object({
	checked: z.array(text).min(1),
	findings: z.array(
		z.object({
			id: Id,
			severity: z.enum(["P0", "P1", "P2"]),
			title: text,
			path: z.string().nullable(),
			line: z.int().positive().nullable(),
			evidence: text,
			consequence: text,
			suggestedFix: text,
		}),
	),
});
export type ImplementationReviewOutput = z.infer<
	typeof ImplementationReviewOutput
>;

export const ImplementationVerificationOutput = z.object({
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
			severity: z.enum(["P0", "P1", "P2"]),
			reason: text,
			counterEvidence: z.string().nullable(),
		}),
	),
	planIssues: z.array(text),
});
export type ImplementationVerificationOutput = z.infer<
	typeof ImplementationVerificationOutput
>;

export const RepairOutput = z
	.object({
		summary: text,
		addressedFindingIds: z.array(Id),
		unresolvedFindingIds: z.array(Id),
		planIssues: z.array(text),
	})
	.refine(
		(value) =>
			uniqueStrings([
				...value.addressedFindingIds,
				...value.unresolvedFindingIds,
			]),
		"duplicate repair finding id",
	);
export type RepairOutput = z.infer<typeof RepairOutput>;

const RoleSettings = z.object({
	model: text.nullable(),
	timeoutMs: z.int().positive().max(MAX_TIMEOUT_MS),
});
const RoleProvenance = z.object({ path: text, sha: text });

export const ExecutionRunConfig = z.object({
	kind: z.literal("factory-execution"),
	naming: ExecutionNamingSnapshot.optional(),
	sourceRunId: Id,
	sourceBaseBranch: text,
	plan: ArtifactRef,
	prId: Id,
	baseCommit: text,
	checks: z
		.array(ExecutionCheck)
		.min(1)
		.refine(
			(items) => new Set(items.map((item) => item.name)).size === items.length,
			"duplicate check name",
		),
	roles: z.record(Id, RoleSettings),
	roleArtifacts: z.record(Id, ArtifactRef),
	roleProvenance: z.record(Id, RoleProvenance),
	maxConcurrentAgents: z.int().positive(),
});
export type ExecutionRunConfig = z.infer<typeof ExecutionRunConfig>;

export const ExecutionWorkspaceIdentity = z.object({
	path: text,
	branch: text,
	baseCommit: text,
	head: text.nullable(),
	fingerprint: text.nullable(),
	historyFingerprint: text.nullable(),
});
export type ExecutionWorkspaceIdentity = z.infer<
	typeof ExecutionWorkspaceIdentity
>;

const Evidence = z.object({
	diff: ArtifactRef.nullable(),
	checks: ArtifactRef.nullable(),
	review: ArtifactRef.nullable(),
});

export const ExecutionCommitIntent = z.object({
	scope: ExecutionScope.default("phase"),
	phaseId: Id,
	phaseIndex: z.int().nonnegative(),
	startCommit: text,
	parent: text,
	tree: text,
	expectedSnapshot: text,
	trailer: text,
	message: text,
	report: ArtifactRef,
	checks: ArtifactRef,
	review: ArtifactRef,
	summary: text,
	acceptedCriteria: z.array(text),
	deviations: z.array(text),
});
export type ExecutionCommitIntent = z.infer<typeof ExecutionCommitIntent>;

export const ExecutionIssueAnswer = z.object({
	issue: text,
	answer: text,
});
export type ExecutionIssueAnswer = z.infer<typeof ExecutionIssueAnswer>;

export const ExecutionCheckpoint = z.object({
	naming: ExecutionNamingSnapshot.optional(),
	issueAnswers: z.array(ExecutionIssueAnswer).optional(),
	revision: z.int().nonnegative(),
	implementationFeedback: text.nullable().optional(),
	stage: ExecutionStage,
	phaseIndex: z.int().nonnegative(),
	scope: ExecutionScope,
	cycle: z.int().nonnegative(),
	round: z.int().nonnegative(),
	manifest: ArtifactRef.nullable(),
	workspace: ExecutionWorkspaceIdentity.nullable(),
	evidence: Evidence,
	commitIntent: ExecutionCommitIntent.nullable().default(null),
	acceptedFindingIds: z.array(Id).default([]),
	pendingFindingIds: z.array(Id).default([]),
	unresolvedFindingIds: z.array(Id).default([]),
	receipts: z.array(ArtifactRef),
	inFlight: z
		.object({ operation: ExecutionStage, stepIds: z.array(Id).min(1) })
		.nullable(),
	escalation: z.object({ reason: text }).nullable(),
	statusDetail: text.nullable(),
});
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpoint>;

export const PhaseReceipt = z.object({
	phaseId: Id,
	phaseIndex: z.int().nonnegative(),
	planHash: text,
	startCommit: text,
	resultCommit: text,
	report: ArtifactRef,
	checks: ArtifactRef,
	review: ArtifactRef,
	summary: text,
	acceptedCriteria: z.array(text),
	deviations: z.array(text),
});
export type PhaseReceipt = z.infer<typeof PhaseReceipt>;

const CheckStatus = z.enum([
	"passed",
	"failed",
	"timed_out",
	"cancelled",
	"spawn_failed",
]);

export const ExecutionSummary = z.object({
	naming: ExecutionNamingSnapshot.optional(),
	publicationIneligibleReason: z.string().optional(),
	runId: Id,
	sourceRunId: Id,
	prId: Id,
	phaseCount: z.int().nonnegative().default(0),
	phases: z.array(z.object({ id: Id, title: text })).optional(),
	completedPhases: z
		.array(z.object({ id: Id, title: text, resultCommit: text }))
		.default([]),
	resultCommit: text.nullable().default(null),
	artifactIssues: z.array(text).default([]),
	status: z.enum(["active", "ended"]),
	outcome: text.nullable(),
	stage: ExecutionStage,
	phaseIndex: z.int().nonnegative(),
	scope: ExecutionScope,
	branch: text.nullable(),
	worktree: text.nullable(),
	statusDetail: text.nullable(),
	escalationReason: text.nullable(),
	pausedOperation: ExecutionStage.optional(),
	planIssues: z.array(text).optional(),
	issueAnswers: z.array(ExecutionIssueAnswer).optional(),
	checks: z.array(
		z.object({
			name: text,
			status: CheckStatus,
			output: z.string().optional(),
		}),
	),
	review: z
		.object({
			lenses: z.array(text),
			uncheckedLenses: z.array(text),
			findings: z.int().nonnegative(),
			blockers: z.array(Finding).optional(),
			details: z
				.object({
					findings: z.array(Finding),
					verdicts: ImplementationVerificationOutput.shape.verdicts,
					coverage: z.array(z.object({ lens: text, checked: z.array(text) })),
					scope: ExecutionScope.nullable(),
					phaseIndex: z.int().nonnegative().nullable(),
					round: z.int().nonnegative().nullable(),
					startCommit: text.nullable(),
					fingerprint: text.nullable(),
					discarded: z.boolean(),
					checksAreLatest: z.boolean(),
				})
				.optional(),
			unresolved: z.int().nonnegative(),
			acceptedFindingIds: z.array(Id).default([]),
			unresolvedFindingIds: z.array(Id).default([]),
			round: z.int().nonnegative().default(0),
		})
		.nullable(),
});
export type ExecutionSummary = z.infer<typeof ExecutionSummary>;
