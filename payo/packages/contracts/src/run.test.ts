import { describe, expect, it } from "vitest";
import { ArtifactRef, Json, RunConfig, Usage } from "./primitives.ts";
import { RunEventBody } from "./run.ts";

describe("Usage", () => {
	it.each([0, 1.5, "unknown"])("accepts %j", (value) => {
		expect(Usage.safeParse(value).success).toBe(true);
	});

	it.each(["0", -1, null, undefined, Number.NaN, Infinity, -Infinity])(
		"rejects %j",
		(value) => {
			expect(Usage.safeParse(value).success).toBe(false);
		},
	);
});

describe("RunEventBody", () => {
	it("rejects an unknown type", () => {
		expect(RunEventBody.safeParse({ type: "run.exploded" }).success).toBe(
			false,
		);
	});

	it("rejects attempt.finished with non-finite usage", () => {
		expect(
			RunEventBody.safeParse({
				type: "attempt.finished",
				attemptId: "a1",
				outcome: "succeeded",
				usage: { tokensIn: Infinity, tokensOut: 0, cost: 0 },
			}).success,
		).toBe(false);
	});

	it("rejects gate.raised without allowedCommands", () => {
		const body = {
			type: "gate.raised",
			gateId: "g1",
			stepId: "s1",
			kind: "review",
			reason: "needs a human",
		};
		expect(RunEventBody.safeParse(body).success).toBe(false);
	});

	it("rejects gate.raised with an empty allowedCommands", () => {
		const body = {
			type: "gate.raised",
			gateId: "g1",
			stepId: "s1",
			kind: "review",
			allowedCommands: [],
			reason: "needs a human",
		};
		expect(RunEventBody.safeParse(body).success).toBe(false);
	});
});

describe("RunEventBody attempt.event and attempt.started", () => {
	const attemptEvent = {
		type: "attempt.event",
		attemptId: "a1",
		event: { type: "message", text: "hi" },
	};

	it("accepts attempt.event with a valid event", () => {
		expect(RunEventBody.safeParse(attemptEvent).success).toBe(true);
	});

	it("rejects attempt.event with an unknown event type", () => {
		expect(
			RunEventBody.safeParse({ ...attemptEvent, event: { type: "nope" } })
				.success,
		).toBe(false);
	});

	it("rejects attempt.started with a non-hash input artifact", () => {
		const body = {
			type: "attempt.started",
			attemptId: "a1",
			stepId: "s1",
			role: "reviewer",
			runner: "fake",
			model: null,
			roleSpecSha: null,
			inputArtifacts: ["not-a-hash"],
		};
		expect(RunEventBody.safeParse(body).success).toBe(false);
	});
});

describe("ArtifactRef", () => {
	const valid = {
		sha256: "a".repeat(64),
		size: 3,
		kind: "diff",
		mediaType: "text/plain",
	};

	it("accepts a lowercase 64-hex sha256", () => {
		expect(ArtifactRef.safeParse(valid).success).toBe(true);
	});

	it.each(["A".repeat(64), "a".repeat(63), "g".repeat(64)])(
		"rejects sha256 %s",
		(sha256) => {
			expect(ArtifactRef.safeParse({ ...valid, sha256 }).success).toBe(false);
		},
	);
});

describe("Json and RunConfig", () => {
	it("rejects an object holding undefined", () => {
		expect(Json.safeParse({ a: undefined }).success).toBe(false);
	});

	it("accepts nested objects and arrays in RunConfig", () => {
		const config = { roles: { reviewer: { model: "m", limits: [1, 2] } } };
		expect(RunConfig.safeParse(config).success).toBe(true);
	});

	it("rejects a top-level array as RunConfig", () => {
		expect(RunConfig.safeParse([1, 2]).success).toBe(false);
	});

	it("rejects non-finite numbers at the contract boundary", () => {
		expect(Json.safeParse({ a: Infinity }).success).toBe(false);
		expect(Json.safeParse({ a: -Infinity }).success).toBe(false);
		expect(RunConfig.safeParse({ a: Infinity }).success).toBe(false);
	});
});
