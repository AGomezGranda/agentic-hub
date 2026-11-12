import type {
	ExecutionCheck,
	ExecutionCheckpoint,
	ExecutionStage,
} from "@payo/contracts";
import {
	type AgentRunner,
	type CheckCommand,
	type Checks,
	ExecutionDiffTooLargeError,
	type ExecutionWorkspace,
	type Limiter,
} from "@payo/kernel";
import { MAX_DIFF_BYTES } from "../domain/execution.ts";
import type {
	ExecutionDeps,
	MutableExecutionHandle,
} from "../execution-handle.ts";

import { raiseExecutionGate } from "./checkpoint.ts";

export function requireExecutionPorts(deps: ExecutionDeps): {
	runner: AgentRunner;
	limiter: Limiter;
	workspace: ExecutionWorkspace;
	checks: Checks;
	dataDir: string;
} {
	if (
		!deps.runner ||
		!deps.limiter ||
		!deps.workspace ||
		!deps.checks ||
		!deps.dataDir
	)
		throw new Error(
			"execution adapters are not configured; writable execution is unavailable",
		);
	if (!deps.platformSupported)
		throw new Error("writable execution requires POSIX process-group cleanup");
	return {
		runner: deps.runner,
		limiter: deps.limiter,
		workspace: deps.workspace,
		checks: deps.checks,
		dataDir: deps.dataDir,
	};
}

export async function captureDiffOrGate(
	state: MutableExecutionHandle,
	workspace: ExecutionWorkspace,
	path: string,
	baseCommit: string,
	signal: AbortSignal,
	operation: ExecutionStage,
	stepIds: readonly string[],
): Promise<string | null> {
	try {
		const diff = await workspace.diff(path, baseCommit, signal, MAX_DIFF_BYTES);
		if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES)
			throw new ExecutionDiffTooLargeError(MAX_DIFF_BYTES);
		return diff;
	} catch (error) {
		if (!(error instanceof ExecutionDiffTooLargeError)) throw error;
		await raiseExecutionGate(
			state,
			operation,
			error.message,
			stepIds,
			"diff-too-large",
		);
		return null;
	}
}

export function toCheckCommand(check: ExecutionCheck): CheckCommand {
	return {
		name: check.name,
		command: check.command,
		args: check.args,
		timeoutMs: check.timeout_ms,
	};
}

export function makeWorkspaceIdentity(
	path: string,
	snapshot: Awaited<ReturnType<ExecutionWorkspace["inspect"]>>,
	baseCommit: string,
): NonNullable<ExecutionCheckpoint["workspace"]> {
	return {
		path,
		branch: snapshot.branch,
		baseCommit,
		head: snapshot.head,
		fingerprint: snapshot.fingerprint,
		historyFingerprint: snapshot.historyFingerprint,
	};
}

export function assertKnownWorkspace(
	snapshot: Awaited<ReturnType<ExecutionWorkspace["inspect"]>>,
	baseCommit: string,
	branch: string,
	expectedHead = baseCommit,
): void {
	if (snapshot.head !== expectedHead || snapshot.branch !== branch)
		throw new Error("execution worktree has an unexpected HEAD or branch");
}

export function requireDataDir(deps: ExecutionDeps): string {
	if (!deps.dataDir)
		throw new Error("execution data directory is not configured");
	return deps.dataDir;
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
