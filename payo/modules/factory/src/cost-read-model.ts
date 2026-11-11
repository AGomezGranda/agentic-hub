import {
	ExecutionRunConfig,
	FactoryRunConfig,
	WorkCostTree,
} from "@payo/contracts";
import { fold, projectRunCosts, type RunStore, sumCosts } from "@payo/kernel";
import { CommandError } from "./errors.ts";
import { validateRunId } from "./plans.ts";

/**
 * Read-only work cost tree for a planning run and every stored execution child.
 * Discovery scans all logs; it never recovers, schedules, or reads artifacts.
 */
// shortcut: replace full-log discovery with indexed lineage reads once history exceeds roughly 1,000 runs or a representative query exceeds roughly 250 ms.
export async function readWorkCosts(
	store: RunStore,
	sourceRunId: string,
): Promise<WorkCostTree> {
	try {
		validateRunId(sourceRunId);
	} catch {
		throw new CommandError(
			"invalid_request",
			`invalid run id ${JSON.stringify(sourceRunId)}`,
		);
	}

	const ids = [...new Set(await store.listRunIds())].sort();
	const planningEvents = await store.read(sourceRunId);
	if (planningEvents.length === 0)
		throw new CommandError("not_found", `run ${sourceRunId} not found`);
	const planningConfig = FactoryRunConfig.safeParse(
		fold(planningEvents).config.factory,
	);
	if (!planningConfig.success)
		throw new CommandError(
			"invalid_request",
			`run ${sourceRunId} is not a planning run`,
		);
	const planning = projectRunCosts(planningEvents);

	const executions: WorkCostTree["executions"] = [];
	for (const id of ids) {
		if (id === sourceRunId) continue;
		const events = await store.read(id);
		if (events.length === 0) continue;
		const raw = fold(events).config.factory;
		if (!isRecord(raw) || raw.kind !== "factory-execution") continue;
		if (raw.sourceRunId !== sourceRunId) continue;
		const config = ExecutionRunConfig.safeParse(raw);
		if (!config.success)
			throw new CommandError(
				"invalid_request",
				`execution run ${id} has an invalid factory config`,
			);
		executions.push({ prId: config.data.prId, run: projectRunCosts(events) });
	}
	executions.sort((a, b) =>
		a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0,
	);

	return WorkCostTree.parse({
		sourceRunId,
		planning,
		executions,
		total: sumCosts([
			planning.cost,
			...executions.map((execution) => execution.run.cost),
		]),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
