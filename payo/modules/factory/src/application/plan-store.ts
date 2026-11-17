import type { RunIdInput } from "@payo/contracts";
export class PlanNotFound extends Error {
	constructor(runId: RunIdInput, cause?: unknown) {
		super(`working plan for run ${runId} not found`, { cause });
		this.name = "PlanNotFound";
	}
}
