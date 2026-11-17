import type { CheckResult } from "../domain/checks.ts";

export {
	allChecksPassed,
	type CheckResult,
	type CheckStatus,
} from "../domain/checks.ts";

export interface CheckCommand {
	name: string;
	command: string;
	args: readonly string[];
	timeoutMs: number;
}

/** Ordered check execution in a workspace. An empty suite never means success. */
export interface Checks {
	run(
		cwd: string,
		commands: readonly CheckCommand[],
		signal: AbortSignal,
	): Promise<CheckResult[]>;
}
