import type { ExecutionCheckpoint, ExecutionRunConfig } from "@payo/contracts";
export function executionNaming(
	config: ExecutionRunConfig,
	checkpoint: Pick<ExecutionCheckpoint, "naming">,
) {
	return checkpoint.naming ?? config.naming;
}
export function expectedExecutionBranch(
	config: ExecutionRunConfig,
	checkpoint: Pick<ExecutionCheckpoint, "naming">,
	runId: string,
) {
	return executionNaming(config, checkpoint)?.branch ?? `payo/${runId}`;
}
