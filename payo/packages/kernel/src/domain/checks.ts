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

export function allChecksPassed(results: readonly CheckResult[]): boolean {
	return (
		results.length > 0 && results.every((result) => result.status === "passed")
	);
}
