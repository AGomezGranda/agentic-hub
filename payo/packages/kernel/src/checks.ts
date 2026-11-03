export interface CheckCommand {
	name: string;
	command: string;
	args: readonly string[];
	timeoutMs: number;
}

export type CheckStatus =
	| "passed"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "spawn_failed";

export interface CheckResult {
	name: string;
	status: CheckStatus;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** True when stdout or stderr was capped; the adapter appends an explicit marker. */
	truncated: boolean;
}

/** Ordered check execution in a workspace. An empty suite never means success. */
export interface Checks {
	run(
		cwd: string,
		commands: readonly CheckCommand[],
		signal: AbortSignal,
	): Promise<CheckResult[]>;
}

export function allChecksPassed(results: readonly CheckResult[]): boolean {
	return (
		results.length > 0 && results.every((result) => result.status === "passed")
	);
}
