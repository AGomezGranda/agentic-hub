import type {
	ExecutionNamingSnapshot,
	GitHubTarget,
	PublicationCommit,
	PullRequestRecord,
} from "@payo/contracts";
import { CommandError } from "../errors.ts";

const conflict = (message: string): never => {
	throw new CommandError("conflict", message);
};
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
	executionId: string,
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
export function sameTarget(a: GitHubTarget, b: GitHubTarget): boolean {
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
		target: GitHubTarget;
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
