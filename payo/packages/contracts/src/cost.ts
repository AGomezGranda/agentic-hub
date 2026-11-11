import { z } from "zod";
import { CostAmounts, Id } from "./primitives.ts";
import { AttemptRecord, StepRecord } from "./run.ts";

export const CostCoverage = z.enum(["complete", "partial", "unknown"]);
export type CostCoverage = z.infer<typeof CostCoverage>;

export const CostSummary = z
	.object({
		amounts: CostAmounts,
		coverage: CostCoverage,
		incompleteAttempts: z.int().nonnegative(),
		attempts: z.int().nonnegative(),
	})
	.superRefine((value, ctx) => {
		if (value.incompleteAttempts > value.attempts)
			ctx.addIssue({
				code: "custom",
				message: "incompleteAttempts cannot exceed attempts",
				path: ["incompleteAttempts"],
			});
		if (value.attempts === 0) {
			if (value.incompleteAttempts !== 0)
				ctx.addIssue({
					code: "custom",
					message: "a summary with no attempts has no incomplete attempts",
					path: ["incompleteAttempts"],
				});
			if (value.amounts.length !== 0)
				ctx.addIssue({
					code: "custom",
					message: "a summary with no attempts has no amounts",
					path: ["amounts"],
				});
			if (value.coverage !== "complete")
				ctx.addIssue({
					code: "custom",
					message: "a summary with no attempts is complete",
					path: ["coverage"],
				});
			return;
		}
		if (value.incompleteAttempts === 0) {
			if (value.coverage !== "complete")
				ctx.addIssue({
					code: "custom",
					message: "fully covered attempts are complete",
					path: ["coverage"],
				});
			if (value.amounts.length === 0)
				ctx.addIssue({
					code: "custom",
					message: "a complete summary needs at least one amount",
					path: ["amounts"],
				});
			return;
		}
		if (value.amounts.length === 0 && value.coverage !== "unknown")
			ctx.addIssue({
				code: "custom",
				message: "a summary with no amounts is unknown",
				path: ["coverage"],
			});
		if (value.amounts.length > 0 && value.coverage !== "partial")
			ctx.addIssue({
				code: "custom",
				message: "a summary with amounts and incomplete attempts is partial",
				path: ["coverage"],
			});
	});
export type CostSummary = z.infer<typeof CostSummary>;

export const AttemptCost = AttemptRecord.extend({ cost: CostSummary });
export type AttemptCost = z.infer<typeof AttemptCost>;

export const StepCost = StepRecord.extend({
	cost: CostSummary,
	attempts: z.array(AttemptCost),
}).superRefine((step, ctx) => {
	if (step.cost.attempts !== step.attempts.length)
		ctx.addIssue({
			code: "custom",
			message: "step cost does not count every attempt",
			path: ["cost", "attempts"],
		});
	const incomplete = step.attempts.filter(
		(attempt) => attempt.cost.coverage !== "complete",
	).length;
	if (step.cost.incompleteAttempts !== incomplete)
		ctx.addIssue({
			code: "custom",
			message: "step cost does not count every incomplete attempt",
			path: ["cost", "incompleteAttempts"],
		});
});
export type StepCost = z.infer<typeof StepCost>;

export const RunCostTree = z
	.object({
		runId: Id,
		status: z.enum(["active", "ended"]),
		outcome: z.string().nullable(),
		asOfSeq: z.int().nonnegative(),
		cost: CostSummary,
		steps: z.array(StepCost),
	})
	.superRefine((run, ctx) => {
		const attempts = run.steps.reduce(
			(total, step) => total + step.attempts.length,
			0,
		);
		if (run.cost.attempts !== attempts)
			ctx.addIssue({
				code: "custom",
				message: "run cost does not count every step attempt",
				path: ["cost", "attempts"],
			});
		const incomplete = run.steps.reduce(
			(total, step) => total + step.cost.incompleteAttempts,
			0,
		);
		if (run.cost.incompleteAttempts !== incomplete)
			ctx.addIssue({
				code: "custom",
				message: "run cost does not count every incomplete step attempt",
				path: ["cost", "incompleteAttempts"],
			});
	});
export type RunCostTree = z.infer<typeof RunCostTree>;
