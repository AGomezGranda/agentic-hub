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

// Money uses decimal text with 12 fractional digits, rounded half up at provider/legacy ingress.
export function moneyFromNumber(value: number): string {
	if (!Number.isFinite(value) || value < 0)
		throw new RangeError("cost must be finite and nonnegative");
	const [coefficient, exponent = "0"] = value
		.toString()
		.toLowerCase()
		.split("e");
	const [whole = "0", fraction = ""] = (coefficient ?? "0").split(".");
	const digits = BigInt(whole + fraction);
	const shift = 12 + Number(exponent) - fraction.length;
	const units =
		shift >= 0
			? digits * 10n ** BigInt(shift)
			: (digits + 10n ** BigInt(-shift) / 2n) / 10n ** BigInt(-shift);
	return moneyFromUnits(units);
}

function moneyFromUnits(units: bigint): string {
	const digits = units.toString().padStart(13, "0");
	const fraction = digits.slice(-12).replace(/0+$/, "");
	return digits.slice(0, -12) + (fraction ? `.${fraction}` : "");
}

export function addMoney(left: string, right: string): string {
	const units = (value: string) => {
		const [whole, fraction = ""] = Money.parse(value).split(".");
		return BigInt(`${whole}${fraction.padEnd(12, "0")}`);
	};
	return moneyFromUnits(units(left) + units(right));
}

// Numeric input supports historical event payloads; every parsed amount leaves as decimal text.
export const Money = z.union([
	z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/),
	z.number().finite().nonnegative().transform(moneyFromNumber),
]);

export const CostAmount = z.object({
	currency: Currency,
	basis: CostBasis,
	amount: Money,
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
