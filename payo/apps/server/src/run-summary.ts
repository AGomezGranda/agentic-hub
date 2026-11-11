import type { RunSummary } from "@payo/contracts";
import {
	type ExecutionHandle,
	type FactoryHandle,
	type PublicationHandle,
	readExecutionGates,
	readExecutionSummary,
	readPublicationSummary,
} from "@payo/factory";
import type { RunStore } from "@payo/kernel";
import { ApplicationError } from "./errors.ts";
export async function readRunSummary(
	store: RunStore,
	runId: string,
	factory: FactoryHandle | undefined,
	execution: ExecutionHandle | undefined,
	publication?: PublicationHandle,
): Promise<RunSummary> {
	if (!factory && !execution && !publication)
		throw new ApplicationError("not_found", `run ${runId} not found`);
	const state = (publication ?? factory ?? execution)?.log.current();
	if (!state) throw new ApplicationError("not_found", `run ${runId} not found`);
	const events = await store.read(runId);
	const first = events[0]?.at;
	const last = events.at(-1)?.at;
	if (!first || !last)
		throw new ApplicationError("not_found", `run ${runId} not found`);
	const workItem = factory?.checkpoint.workItem;
	const executionSummary = execution
		? await readExecutionSummary(execution)
		: undefined;
	const publicationSummary = publication
		? readPublicationSummary(publication)
		: undefined;
	return {
		runId,
		repo: state.repo,
		baseBranch: state.baseBranch,
		status: state.status,
		outcome: state.outcome,
		stage:
			publication?.checkpoint.stage ??
			execution?.checkpoint.stage ??
			factory?.checkpoint.stage ??
			null,
		workItem: workItem
			? {
					source: workItem.origin.source,
					title: workItem.title,
					key: workItem.origin.source === "jira" ? workItem.origin.key : null,
				}
			: null,
		startedAt: first,
		updatedAt: last,
		openGates: execution
			? readExecutionGates(execution)
			: [...state.gates.values()]
					.filter((gate) => gate.status === "open")
					.map((gate) => ({
						gateId: gate.gateId,
						stepId: gate.stepId,
						kind: gate.kind,
						allowedCommands: [...gate.allowedCommands],
						reason: gate.reason,
					})),
		...(executionSummary ? { execution: executionSummary } : {}),
		...(publicationSummary ? { publication: publicationSummary } : {}),
	};
}
