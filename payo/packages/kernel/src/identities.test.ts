import {
	AttemptId,
	type AttemptIdInput,
	GateId,
	type GateIdInput,
	type RunEventBody,
	RunId,
	type RunIdInput,
	StepId,
	type StepIdInput,
} from "@payo/contracts";
import { expect, expectTypeOf, it } from "vitest";
import type { StepInput } from "./application/agent-step.ts";
import type { RunStore } from "./application/store.ts";

it("keeps historical identifiers and their serialized representation", () => {
	for (const schema of [RunId, StepId, AttemptId, GateId]) {
		expect(JSON.stringify(schema.parse("legacy-1.2"))).toBe('"legacy-1.2"');
		expect(() => schema.parse("")).toThrow();
	}
});

it("rejects mixed validated identities at engine ports and event inputs", () => {
	expectTypeOf<RunId>().toExtend<RunIdInput>();
	expectTypeOf<string>().toExtend<RunIdInput>();
	expectTypeOf<StepId>().not.toExtend<RunIdInput>();
	expectTypeOf<AttemptId>().not.toExtend<StepIdInput>();
	expectTypeOf<GateId>().not.toExtend<AttemptIdInput>();
	expectTypeOf<RunId>().not.toExtend<GateIdInput>();
	expectTypeOf<Parameters<RunStore["read"]>[0]>().toEqualTypeOf<RunIdInput>();
	expectTypeOf<StepInput["stepId"]>().toEqualTypeOf<StepIdInput>();
	expectTypeOf<
		StepInput["attemptIds"][number]
	>().toEqualTypeOf<AttemptIdInput>();
	expectTypeOf<
		Extract<RunEventBody, { type: "run.created" }>["runId"]
	>().toEqualTypeOf<RunIdInput>();
});
