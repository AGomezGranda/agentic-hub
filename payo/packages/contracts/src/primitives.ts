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

export const UsageRecord = z.object({
	tokensIn: Usage,
	tokensOut: Usage,
	cost: Usage,
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
