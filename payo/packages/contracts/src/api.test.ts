import { describe, expect, it } from "vitest";
import {
	AnswerRequest,
	ApiError,
	DoctorCheck,
	DoctorReport,
	RunId,
	RunSummary,
	StartRunRequest,
} from "./api.ts";

const runId = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const summary = {
	runId,
	repo: "/repo",
	baseBranch: "main",
	status: "active" as const,
	outcome: null,
	stage: "Approval" as const,
	startedAt: "2026-10-30T00:00:00.000Z",
	updatedAt: "2026-10-30T00:01:00.000Z",
	openGates: [
		{
			gateId: "gate",
			stepId: "step",
			kind: "approval",
			allowedCommands: ["approve"],
			reason: "awaiting approval",
		},
	],
};

describe("API contracts", () => {
	it("accepts a minimal start request and optional repo overrides", () => {
		expect(StartRunRequest.parse({ ticketKey: "ABC-123" })).toEqual({
			ticketKey: "ABC-123",
		});
		expect(
			StartRunRequest.parse({
				ticketKey: "ABC-123",
				repo: "/repo",
				baseBranch: "develop",
			}),
		).toMatchObject({ repo: "/repo", baseBranch: "develop" });
	});

	it("rejects missing or blank start fields", () => {
		expect(StartRunRequest.safeParse({}).success).toBe(false);
		expect(StartRunRequest.safeParse({ ticketKey: " " }).success).toBe(false);
		expect(
			StartRunRequest.safeParse({ ticketKey: "T", repo: "" }).success,
		).toBe(false);
	});

	it("requires a nonblank answer", () => {
		expect(
			AnswerRequest.safeParse({ questionId: "q", text: "Because" }).success,
		).toBe(true);
		expect(
			AnswerRequest.safeParse({ questionId: "q", text: " \n" }).success,
		).toBe(false);
		expect(AnswerRequest.safeParse({ questionId: "q" }).success).toBe(false);
	});

	it("accepts only UUID run IDs", () => {
		expect(RunId.safeParse(runId).success).toBe(true);
		expect(RunId.safeParse("run").success).toBe(false);
		expect(RunId.safeParse("").success).toBe(false);
	});

	it("keeps summaries JSON-safe and ignores unknown fields", () => {
		const parsed = RunSummary.parse(summary);
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
		expect(RunSummary.parse({ ...summary, extra: true })).toEqual(parsed);
		expect(
			RunSummary.safeParse({ ...summary, runId: "not-a-uuid" }).success,
		).toBe(false);
	});

	it("requires both error fields", () => {
		expect(
			ApiError.safeParse({ code: "not_found", message: "gone" }).success,
		).toBe(true);
		expect(ApiError.safeParse({ code: "not_found" }).success).toBe(false);
	});

	it("caps a doctor check detail at 512 characters", () => {
		expect(
			DoctorCheck.safeParse({ name: "pi", ok: true, detail: "x".repeat(512) })
				.success,
		).toBe(true);
		expect(
			DoctorCheck.safeParse({ name: "pi", ok: true, detail: "x".repeat(513) })
				.success,
		).toBe(false);
	});

	it("parses an ordered doctor report", () => {
		const report = {
			ok: false,
			checks: [
				{ name: "pi", ok: true, detail: "ready" },
				{ name: "acli", ok: false, detail: "missing" },
			],
		};
		expect(DoctorReport.parse(report)).toEqual(report);
	});
});
