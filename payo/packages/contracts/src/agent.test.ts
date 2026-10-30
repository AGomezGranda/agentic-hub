import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEvent, AgentSpec, jsonEnvelope } from "./agent.ts";

const sha = "a".repeat(64);
const usage = { tokensIn: 10, tokensOut: "unknown", cost: 0 } as const;

const validSpec = {
	role: "reviewer",
	instructions: "Review the diff.",
	roleSpecSha: null,
	cwd: "/tmp/work",
	tools: "read-only",
	model: null,
	timeoutMs: 1000,
	outputContract: "review-verdict",
	inputs: [
		{
			name: "diff",
			ref: { sha256: sha, size: 3, kind: "diff", mediaType: "text/x-diff" },
		},
	],
};

describe("AgentSpec", () => {
	it("accepts a complete valid spec", () => {
		expect(AgentSpec.safeParse(validSpec).success).toBe(true);
	});

	it("accepts timeoutMs at the timer ceiling", () => {
		expect(
			AgentSpec.safeParse({ ...validSpec, timeoutMs: 2147483647 }).success,
		).toBe(true);
	});

	it.each([
		["timeoutMs: 0", { ...validSpec, timeoutMs: 0 }],
		[
			"timeoutMs above the timer ceiling",
			{ ...validSpec, timeoutMs: 2147483648 },
		],
		["an empty instructions", { ...validSpec, instructions: "" }],
		[
			"a tools value other than read-only or write",
			{ ...validSpec, tools: "all" },
		],
		[
			"an input with a non-sha256 ref",
			{
				...validSpec,
				inputs: [
					{
						name: "diff",
						ref: { sha256: "nope", size: 3, kind: "diff", mediaType: "x" },
					},
				],
			},
		],
	])("rejects %s", (_label, spec) => {
		expect(AgentSpec.safeParse(spec).success).toBe(false);
	});
});

describe("AgentEvent", () => {
	it.each([
		{ type: "started", model: "m" },
		{ type: "message", text: "hi" },
		{ type: "tool_call", callId: "c1", name: "read" },
		{ type: "tool_result", callId: "c1", name: "read", ok: true },
		{ type: "usage", usage },
		{ type: "result", text: "{}" },
		{ type: "error", message: "boom" },
	])("accepts a $type event", (event) => {
		expect(AgentEvent.safeParse(event).success).toBe(true);
	});

	it("rejects an unknown type", () => {
		expect(AgentEvent.safeParse({ type: "delta", text: "x" }).success).toBe(
			false,
		);
	});

	it("rejects tool_result without ok", () => {
		expect(
			AgentEvent.safeParse({ type: "tool_result", callId: "c1", name: "read" })
				.success,
		).toBe(false);
	});

	it("rejects usage holding a string instead of a UsageRecord", () => {
		expect(AgentEvent.safeParse({ type: "usage", usage: "0" }).success).toBe(
			false,
		);
	});

	it.each(["message", "result", "error"])(
		"caps %s text at 262144 characters",
		(type) => {
			const field = type === "error" ? "message" : "text";
			const at = (n: number) => ({ type, [field]: "x".repeat(n) });
			expect(AgentEvent.safeParse(at(262144)).success).toBe(true);
			expect(AgentEvent.safeParse(at(262145)).success).toBe(false);
		},
	);

	it("rejects a tool name over 128 characters", () => {
		const name = "x".repeat(129);
		expect(
			AgentEvent.safeParse({ type: "tool_call", callId: "c1", name }).success,
		).toBe(false);
	});
});

describe("jsonEnvelope", () => {
	const validate = jsonEnvelope(z.object({ verdict: z.literal("ok") }));

	it("returns the parsed value for JSON matching the schema", () => {
		expect(validate('{"verdict":"ok"}')).toEqual({
			ok: true,
			value: { verdict: "ok" },
		});
	});

	it("reports not JSON when the text does not parse", () => {
		expect(validate("not json")).toEqual({
			ok: false,
			error: "output is not JSON",
		});
	});

	it("names the failing field when the JSON does not match the schema", () => {
		const check = validate('{"verdict":"no"}');
		expect(check.ok).toBe(false);
		expect(check).toMatchObject({ error: expect.stringContaining("verdict") });
	});
});
