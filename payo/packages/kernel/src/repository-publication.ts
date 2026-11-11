import type { PublicationCommit } from "@payo/contracts";

export interface RepositoryPublication {
	resolveRemote(
		repo: string,
		remote: string,
		signal: AbortSignal,
	): Promise<{ fetchUrl: string; pushUrl: string }>;
	readCommits(
		path: string,
		baseCommit: string,
		resultCommit: string,
		signal: AbortSignal,
	): Promise<PublicationCommit[]>;
	readRemoteHead(
		pushUrl: string,
		branch: string,
		signal: AbortSignal,
	): Promise<string | null>;
	pushCommit(
		path: string,
		pushUrl: string,
		branch: string,
		commit: string,
		signal: AbortSignal,
	): Promise<void>;
}
