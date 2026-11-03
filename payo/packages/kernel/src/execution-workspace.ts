export interface ExecutionWorkspacePrepareInput {
	executionId: string;
	repo: string;
	worktreeRoot: string;
	branch: string;
	baseCommit: string;
}

export interface PreparedExecutionWorkspace {
	path: string;
	branch: string;
	baseCommit: string;
}

export interface ExecutionPrerequisite {
	description: string;
	ref?: string;
	paths?: string[];
}

export interface ExecutionPrerequisiteResult {
	description: string;
	present: boolean;
	reason: string | null;
}

export class ExecutionDiffTooLargeError extends Error {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`execution diff exceeds ${maxBytes} bytes`);
		this.maxBytes = maxBytes;
		this.name = "ExecutionDiffTooLargeError";
	}
}

export interface ExecutionCommitPlan {
	parent: string;
	tree: string;
	expectedSnapshot: string;
	changed: boolean;
}

export interface ExecutionCommitExpectation {
	parent: string;
	tree: string;
	trailer: string;
}

export interface ExecutionCommitSnapshot {
	head: string;
	parent: string | null;
	tree: string;
	message: string;
}

export interface ExecutionWorkspaceSnapshot {
	head: string;
	branch: string;
	/** Covers HEAD, index/tracked changes, untracked paths and content digests. */
	fingerprint: string;
	changedPaths: string[];
	/** Digest of local heads, remote-tracking refs, and reflogs for writer safety checks. */
	historyFingerprint: string;
}

/** Execution-only Git operations; planning keeps the narrower `Workspace` port. */
export interface ExecutionWorkspace {
	resolveBase(repo: string, ref: string, signal: AbortSignal): Promise<string>;
	prepare(
		input: ExecutionWorkspacePrepareInput,
		signal: AbortSignal,
	): Promise<PreparedExecutionWorkspace>;
	inspect(
		path: string,
		signal: AbortSignal,
	): Promise<ExecutionWorkspaceSnapshot>;
	/** Capture a diff, failing with `ExecutionDiffTooLargeError` when it exceeds the optional byte cap. */
	diff(
		path: string,
		baseCommit: string,
		signal: AbortSignal,
		maxBytes?: number,
	): Promise<string>;
	verifyPrerequisites(
		repo: string,
		baseCommit: string,
		prerequisites: readonly ExecutionPrerequisite[],
		signal: AbortSignal,
	): Promise<ExecutionPrerequisiteResult[]>;
	instructions(
		repo: string,
		baseCommit: string,
		signal: AbortSignal,
	): Promise<Record<string, string>>;
	prepareCommit(
		path: string,
		expectedSnapshot: string,
		signal: AbortSignal,
	): Promise<ExecutionCommitPlan>;
	inspectCommit(
		path: string,
		signal: AbortSignal,
	): Promise<ExecutionCommitSnapshot>;
	commit(
		path: string,
		expectedSnapshot: string,
		message: string,
		signal: AbortSignal,
		expectation: ExecutionCommitExpectation,
	): Promise<string>;
}
