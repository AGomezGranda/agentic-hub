import { expect, it } from "vitest";
import { parseArgs, UsageError } from "./args.ts";

it("parses serve with forwarded arguments", () => {
	expect(parseArgs(["serve", "--dev-fakes"])).toEqual({
		command: "serve",
		args: ["--dev-fakes"],
	});
});

it("parses start with repo and base overrides", () => {
	expect(parseArgs(["start", "ABC-123"])).toEqual({
		command: "start",
		ticketKey: "ABC-123",
		repo: undefined,
		baseBranch: undefined,
	});
	expect(
		parseArgs(["start", "ABC-123", "--repo", "/repo", "--base", "develop"]),
	).toEqual({
		command: "start",
		ticketKey: "ABC-123",
		repo: "/repo",
		baseBranch: "develop",
	});
});

it("requires run IDs and flag values", () => {
	for (const command of [
		"status",
		"logs",
		"approve",
		"request-changes",
		"resume",
		"edit",
	])
		expect(() => parseArgs([command])).toThrow(UsageError);
	expect(() => parseArgs(["start"])).toThrow(/ticket key required/);
	expect(() => parseArgs(["start", "ABC-123", "--repo"])).toThrow(
		/requires a value/,
	);
	expect(() => parseArgs(["start", "ABC-123", "--base"])).toThrow(
		/requires a value/,
	);
});

it("joins answer text with spaces", () => {
	expect(
		parseArgs(["answer", "run", "q1", "Because", "it", "is", "safer"]),
	).toEqual({
		command: "answer",
		runId: "run",
		questionId: "q1",
		text: "Because it is safer",
	});
	expect(() => parseArgs(["answer", "run", "q1"])).toThrow(/answer/);
});

it("parses log following and rejects unknown flags", () => {
	expect(parseArgs(["logs", "run", "-f"])).toEqual({
		command: "logs",
		runId: "run",
		follow: true,
	});
	expect(parseArgs(["logs", "run", "--follow"])).toMatchObject({
		follow: true,
	});
	expect(() => parseArgs(["logs", "run", "--bad"])).toThrow(/unknown option/);
	expect(() => parseArgs(["status", "run", "--bad"])).toThrow(UsageError);
	expect(() => parseArgs(["start", "T", "--bad"])).toThrow(/unknown option/);
	expect(() => parseArgs(["unknown"])).toThrow(/unknown command/);
	expect(() => parseArgs([])).toThrow(UsageError);
});

it("parses token with no arguments", () => {
	expect(parseArgs(["token"])).toEqual({ command: "token" });
	expect(() => parseArgs(["token", "extra"])).toThrow(UsageError);
});

it("parses doctor with no arguments", () => {
	expect(parseArgs(["doctor"])).toEqual({ command: "doctor" });
	expect(() => parseArgs(["doctor", "extra"])).toThrow(UsageError);
});
