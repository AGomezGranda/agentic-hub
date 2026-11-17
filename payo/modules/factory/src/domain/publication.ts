import type {
	ExecutionCheckpoint,
	ExecutionNamingSnapshot,
	ExecutionRunConfig,
	PhaseReceipt,
	PublicationCommit,
	PublicationFinalResult,
	PublicationPreview,
	PublishRequest,
	PullRequestRecord,
	RepositoryTarget,
	RunIdInput,
} from "@payo/contracts";
import { CommandError } from "./errors.ts";

function conflict(message: string): never {
	throw new CommandError("conflict", message);
}
export function publicationEligibility(
	status: string,
	outcome: string | null,
	naming: ExecutionNamingSnapshot | undefined,
): string | null {
	if (!naming) return "Legacy execution has no confirmed naming snapshot";
	if (status !== "ended" || outcome !== "reviewed")
		return "Publication requires a terminal reviewed execution";
	return null;
}
export function validatePublicationCommits(
	commits: PublicationCommit[],
	naming: ExecutionNamingSnapshot,
	executionId: RunIdInput,
): void {
	if (!commits.length) conflict("Cannot publish an empty result");
	for (const item of commits) {
		if (
			item.subject !== item.message.split("\n")[0] ||
			/[\p{Cc}\p{Zl}\p{Zp}]/u.test(item.subject) ||
			!item.subject.trim()
		)
			conflict("Invalid commit subject");
		if (naming.ticketId !== null)
			validateTicketTitle(item.subject, naming.ticketId);
		if (
			!item.message
				.split(/\r?\n/)
				.some(
					(line) =>
						line.startsWith(`Payo-Execution: ${executionId}/`) &&
						line.length > `Payo-Execution: ${executionId}/`.length,
				)
		)
			conflict("Commit ownership trailer does not match execution");
	}
}
export function validateTicketTitle(
	title: string,
	ticketId: string | null,
): void {
	if (!title.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title))
		conflict("Title must be nonblank and single-line");
	if (
		ticketId !== null &&
		(!title.startsWith(`[${ticketId}] `) ||
			!title.slice(ticketId.length + 3).trim() ||
			title.slice(ticketId.length + 3).includes(`[${ticketId}]`))
	)
		conflict("Subject must retain the exact ticket prefix");
}
export function reconcileRemote(
	observed: string | null,
	expected: string,
	hasIntent: boolean,
): "push" | "confirmed" {
	if (observed === null) return "push";
	if (!hasIntent) conflict("Remote branch is pre-existing and unowned");
	if (observed !== expected)
		conflict("Remote branch points to a different commit");
	return "confirmed";
}
export function sameTarget(a: RepositoryTarget, b: RepositoryTarget): boolean {
	return (
		a.host === b.host &&
		a.owner.toLowerCase() === b.owner.toLowerCase() &&
		a.name.toLowerCase() === b.name.toLowerCase() &&
		a.repositoryId === b.repositoryId &&
		a.baseBranch === b.baseBranch
	);
}
export function reconcilePullRequests(
	prs: PullRequestRecord[],
	expected: {
		target: RepositoryTarget;
		branch: string;
		reviewedCommit: string;
		title: string;
		body: string;
	},
): PullRequestRecord | null {
	if (prs.length > 1)
		conflict("Publication conflict: multiple PRs for this branch");
	const pr = prs[0];
	if (!pr) return null;
	if (
		pr.owner.toLowerCase() !== expected.target.owner.toLowerCase() ||
		pr.name.toLowerCase() !== expected.target.name.toLowerCase() ||
		pr.baseBranch !== expected.target.baseBranch ||
		pr.headBranch !== expected.branch ||
		pr.headCommit !== expected.reviewedCommit ||
		pr.state !== "OPEN" ||
		!pr.draft ||
		pr.title !== expected.title ||
		pr.body !== expected.body
	)
		conflict(
			"Publication conflict: existing PR identity, marker, content, head or draft state differs",
		);
	return pr;
}

export function assertPublicationResult(
	result: PublicationFinalResult,
	head: string,
	checkpoint: ExecutionCheckpoint,
): void {
	if (
		result.resultCommit !== head ||
		JSON.stringify(result.phaseReceipts) !==
			JSON.stringify(checkpoint.receipts) ||
		result.checks.sha256 !== checkpoint.evidence.checks?.sha256 ||
		result.review.sha256 !== checkpoint.evidence.review?.sha256
	)
		conflict("Final evidence differs from reviewed checkpoint");
}

export function assertPublicationManifest(
	manifest: { pr: { id: string }; phases: readonly { id: string }[] },
	config: Pick<ExecutionRunConfig, "prId">,
	checkpoint: Pick<ExecutionCheckpoint, "receipts">,
): void {
	if (
		manifest.pr.id !== config.prId ||
		manifest.phases.length !== checkpoint.receipts.length
	)
		conflict("Reviewed manifest/receipts are incomplete");
}

export function assertPublicationReceipts(
	receipts: readonly PhaseReceipt[],
	manifest: { pr: { id: string }; phases: readonly { id: string }[] },
	config: Pick<ExecutionRunConfig, "baseCommit" | "plan">,
): void {
	let parent = config.baseCommit;
	for (const [index, receipt] of receipts.entries()) {
		if (
			receipt.phaseIndex !== index ||
			receipt.phaseId !== manifest.phases[index]?.id ||
			receipt.planHash !== config.plan.sha256 ||
			receipt.startCommit !== parent
		)
			conflict("Phase receipt identity differs from reviewed plan");
		parent = receipt.resultCommit;
	}
}

export function assertPublicationCheckpoint(checkpoint: ExecutionCheckpoint) {
	const { workspace, manifest } = checkpoint;
	if (!workspace || !manifest || checkpoint.stage !== "Completed")
		conflict("Reviewed execution evidence is incomplete");
	return { workspace, manifest };
}

export function assertPublicationWorkspace(
	snapshot: {
		branch: string;
		head: string;
		changedPaths: readonly string[];
		fingerprint: string;
	},
	identity: NonNullable<ExecutionCheckpoint["workspace"]>,
	expectedBranch: string,
): void {
	if (
		snapshot.branch !== expectedBranch ||
		snapshot.branch !== identity.branch ||
		snapshot.head !== identity.head ||
		snapshot.changedPaths.length ||
		(identity.fingerprint && snapshot.fingerprint !== identity.fingerprint)
	)
		conflict("Reviewed workspace branch, HEAD or cleanliness changed");
}

export function assertPublicationBase(
	target: RepositoryTarget,
	baseCommit: string,
	expectedTarget?: RepositoryTarget,
): void {
	if (
		(expectedTarget && !sameTarget(target, expectedTarget)) ||
		target.baseCommit !== baseCommit
	)
		conflict(
			"Target base moved; approve a new plan/execution against the updated base",
		);
}

export function publicationContent(
	preview: Pick<PublicationPreview, "title" | "body">,
	request: PublishRequest,
	naming: ExecutionNamingSnapshot,
	id: string,
) {
	if (preview.title === undefined || preview.body === undefined)
		conflict("Publication preview is incomplete");
	const title = request.title ?? preview.title;
	validateTicketTitle(title, naming.ticketId);
	const body = request.body ?? preview.body;
	if (body.includes("<!-- payo-publication:"))
		conflict("Publication marker is owned by the factory");
	return { title, body: `${body}\n\n<!-- payo-publication:${id} -->` };
}

export function assertPublicationResumable(
	status: string,
	checkpoint: { stage: string; pausedOperation: "Push" | "CreatePr" | null },
): "Push" | "CreatePr" {
	if (
		status !== "active" ||
		checkpoint.stage !== "Escalated" ||
		!checkpoint.pausedOperation
	)
		conflict("publication is not resumable");
	return checkpoint.pausedOperation;
}
export function publicationResumeCommand(
	allowed: readonly string[],
): "resume" | "retry" {
	if (allowed.includes("resume")) return "resume";
	if (allowed.includes("retry")) return "retry";
	return conflict("publication gate cannot be resumed");
}
