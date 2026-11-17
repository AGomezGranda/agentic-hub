import type { PullRequestRecord, RepositoryTarget } from "@payo/contracts";

export interface CodeHost {
	resolveRepository(
		remoteUrl: string,
		baseBranch: string,
		signal: AbortSignal,
	): Promise<RepositoryTarget>;
	findPullRequests(
		target: RepositoryTarget,
		headBranch: string,
		signal: AbortSignal,
	): Promise<PullRequestRecord[]>;
	createDraftPullRequest(
		target: RepositoryTarget,
		input: { headBranch: string; title: string; body: string },
		signal: AbortSignal,
	): Promise<void>;
}
