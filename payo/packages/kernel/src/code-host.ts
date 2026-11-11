import type { GitHubTarget, PullRequestRecord } from "@payo/contracts";

export interface CodeHost {
	resolveRepository(
		remoteUrl: string,
		baseBranch: string,
		signal: AbortSignal,
	): Promise<GitHubTarget>;
	findPullRequests(
		target: GitHubTarget,
		headBranch: string,
		signal: AbortSignal,
	): Promise<PullRequestRecord[]>;
	createDraftPullRequest(
		target: GitHubTarget,
		input: { headBranch: string; title: string; body: string },
		signal: AbortSignal,
	): Promise<void>;
}
