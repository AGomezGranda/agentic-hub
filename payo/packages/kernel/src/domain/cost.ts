import { isDeepStrictEqual } from "node:util";
import {
	type AttemptRecord,
	addMoney,
	type CostAmount,
	CostSummary,
	compareCostAmounts,
	RunCostTree,
	type RunEvent,
} from "@payo/contracts";
import { fold } from "./state.ts";

const INCOMPLETE_STATUS = new Set([
	"running",
	"cancelled",
	"timed_out",
	"interrupted",
]);

/** Derives one run's cost tree from its event log. Throws on gaps, conflicting rows, or invalid lifecycle. */
export function projectRunCosts(events: readonly RunEvent[]): RunCostTree {
	const state = fold(ordered(events));
	const attemptsByStep = new Map<string, AttemptCost[]>();
	for (const attempt of state.attempts.values()) {
		const cost = attemptCost(attempt);
		const siblings = attemptsByStep.get(attempt.stepId);
		if (siblings === undefined) attemptsByStep.set(attempt.stepId, [cost]);
		else siblings.push(cost);
	}
	const steps = [...state.steps.values()].map((step) => {
		const attempts = attemptsByStep.get(step.stepId) ?? [];
		return { ...step, cost: sumCosts(attempts.map((a) => a.cost)), attempts };
	});
	return RunCostTree.parse({
		runId: state.runId,
		status: state.status,
		outcome: state.outcome,
		asOfSeq: state.lastSeq,
		cost: sumCosts(steps.map((step) => step.cost)),
		steps,
	});
}

/** Merges disjoint summaries: same currency/basis adds, separate buckets stay separate. */
export function sumCosts(summaries: readonly CostSummary[]): CostSummary {
	const buckets = new Map<string, CostAmount>();
	let attempts = 0;
	let incompleteAttempts = 0;
	for (const summary of summaries) {
		attempts += summary.attempts;
		incompleteAttempts += summary.incompleteAttempts;
		for (const amount of summary.amounts) {
			const key = `${amount.currency}\u0000${amount.basis}`;
			const previous = buckets.get(key);
			const total = addMoney(previous?.amount ?? "0", amount.amount);
			buckets.set(key, {
				currency: amount.currency,
				basis: amount.basis,
				amount: total,
			});
		}
	}
	const amounts = [...buckets.values()].sort(compareCostAmounts);
	const coverage =
		incompleteAttempts === 0
			? "complete"
			: amounts.length > 0
				? "partial"
				: "unknown";
	return CostSummary.parse({ amounts, coverage, incompleteAttempts, attempts });
}

type AttemptCost = AttemptRecord & { cost: CostSummary };

function attemptCost(attempt: AttemptRecord): AttemptCost {
	const details = attempt.usage?.costDetails;
	const amounts = [...(details?.amounts ?? [])].sort(compareCostAmounts);
	const complete =
		!INCOMPLETE_STATUS.has(attempt.status) && details?.complete === true;
	return {
		...attempt,
		cost: CostSummary.parse({
			amounts,
			coverage: complete
				? "complete"
				: amounts.length > 0
					? "partial"
					: "unknown",
			incompleteAttempts: complete ? 0 : 1,
			attempts: 1,
		}),
	};
}

// Duplicate identical rows may be delivered twice; different rows for one sequence are corruption.
function ordered(events: readonly RunEvent[]): RunEvent[] {
	const bySeq = new Map<number, RunEvent>();
	for (const event of events) {
		const seen = bySeq.get(event.seq);
		if (seen === undefined) bySeq.set(event.seq, event);
		else if (!isDeepStrictEqual(seen, event))
			throw new Error(`conflicting event rows for seq ${event.seq}`);
	}
	const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
	for (const [index, event] of sorted.entries()) {
		const expected = index + 1;
		if (event.seq !== expected)
			throw new Error(
				`run log has a gap: expected seq ${expected}, got ${event.seq}`,
			);
	}
	return sorted;
}
