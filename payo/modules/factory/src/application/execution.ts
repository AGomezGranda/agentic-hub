export {
	type BeginExecutionInput,
	beginExecution,
	type ExecutionRoleProvenance,
	type ExecutionRoleSettings,
	findExistingExecution,
	openExecution,
} from "./execution/lifecycle.ts";
export {
	assertExecutionResumable,
	prepareExecutionResume,
} from "./execution/resume.ts";
export {
	executeExecution,
	readExecutionSummary,
	resumeExecution,
} from "./execution/run.ts";
export type { ExecutionDeps, ExecutionHandle } from "./execution-handle.ts";
