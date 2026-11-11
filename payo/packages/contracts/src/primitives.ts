import { z } from "zod";

export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json };

export const Json: z.ZodType<Json> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(Json),
		z.record(z.string(), Json),
	]),
);

export const RunConfig = z.record(z.string(), Json);
export type RunConfig = z.infer<typeof RunConfig>;

// `unknown` means the harness did not report it. Zero is a real reading.
export const Usage = z.union([
	z.number().finite().nonnegative(),
	z.literal("unknown"),
]);
export type Usage = z.infer<typeof Usage>;

export const CostBasis = z.enum(["provider-reported", "estimated"]);
export type CostBasis = z.infer<typeof CostBasis>;

const Currency = z.string().regex(/^[A-Z]{3}$/);

export const CostAmount = z.object({
	currency: Currency,
	basis: CostBasis,
	amount: z.number().finite().nonnegative(),
});
export type CostAmount = z.infer<typeof CostAmount>;

export function compareCostAmounts(a: CostAmount, b: CostAmount): number {
	if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
	if (a.basis !== b.basis) return a.basis < b.basis ? -1 : 1;
	return 0;
}

export const CostAmounts = z.array(CostAmount).superRefine((amounts, ctx) => {
	for (let i = 1; i < amounts.length; i++) {
		const previous = amounts[i - 1];
		const current = amounts[i];
		if (previous === undefined || current === undefined) continue;
		const order = compareCostAmounts(previous, current);
		if (order === 0)
			ctx.addIssue({
				code: "custom",
				message: "duplicate currency/basis bucket",
				path: [i],
			});
		else if (order > 0)
			ctx.addIssue({
				code: "custom",
				message: "amounts must be sorted by currency and basis",
				path: [i],
			});
	}
});

export const CostDetails = z
	.object({
		amounts: CostAmounts,
		complete: z.boolean(),
	})
	.superRefine((value, ctx) => {
		if (value.complete && value.amounts.length === 0)
			ctx.addIssue({
				code: "custom",
				message: "a complete cost needs at least one amount",
				path: ["amounts"],
			});
	});
export type CostDetails = z.infer<typeof CostDetails>;

export const UsageRecord = z.object({
	tokensIn: Usage,
	tokensOut: Usage,
	cost: Usage,
	costDetails: CostDetails.optional(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ArtifactRef = z.object({
	sha256: Sha256,
	size: z.int().nonnegative(),
	kind: z.string().min(1),
	mediaType: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const Id = z.string().min(1);

export const ModelId = z.string().min(1).max(256);
export type ModelId = z.infer<typeof ModelId>;
