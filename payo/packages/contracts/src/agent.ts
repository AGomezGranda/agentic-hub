import { z } from "zod";
import { ArtifactRef, Id, ModelId, UsageRecord } from "./primitives.ts";

const MAX_TEXT = 262144;

export const AgentInput = z.object({ name: Id, ref: ArtifactRef });
export type AgentInput = z.infer<typeof AgentInput>;

export const AgentSpec = z.object({
	role: Id,
	instructions: z.string().min(1),
	roleSpecSha: Id.nullable(),
	cwd: z.string().min(1),
	tools: z.enum(["read-only", "write"]),
	model: ModelId.nullable(),
	timeoutMs: z.int().positive().max(2147483647), // setTimeout's ceiling; larger values fire at once
	outputContract: Id,
	inputs: z.array(AgentInput),
	correlation: z.object({ runId: Id, stepId: Id, attemptId: Id }).optional(),
	rawLogPath: z.string().trim().min(1).optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

// Normalised by the runner adapter. Text is capped here, a trust boundary; adapters truncate before emitting.
export const AgentEvent = z.discriminatedUnion("type", [
	z.object({ type: z.literal("started"), model: ModelId.nullable() }),
	z.object({ type: z.literal("message"), text: z.string().max(MAX_TEXT) }),
	z.object({
		type: z.literal("tool_call"),
		callId: z.string().min(1).max(256),
		name: z.string().min(1).max(128),
	}),
	z.object({
		type: z.literal("tool_result"),
		callId: z.string().min(1).max(256),
		name: z.string().min(1).max(128),
		ok: z.boolean(),
	}),
	z.object({ type: z.literal("usage"), usage: UsageRecord }),
	z.object({ type: z.literal("result"), text: z.string().max(MAX_TEXT) }),
	z.object({ type: z.literal("error"), message: z.string().max(MAX_TEXT) }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export type EnvelopeCheck =
	| { ok: true; value: unknown }
	| { ok: false; error: string };

export type OutputValidator = (text: string) => EnvelopeCheck;

export function jsonEnvelope(schema: z.ZodType): OutputValidator {
	return (text) => {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return { ok: false, error: "output is not JSON" };
		}
		const parsed = schema.safeParse(raw);
		if (parsed.success) return { ok: true, value: parsed.data };
		return { ok: false, error: z.prettifyError(parsed.error) };
	};
}
