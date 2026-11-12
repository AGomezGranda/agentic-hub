import { expect, it } from "vitest";
import { parseArgs, UsageError } from "./args.ts";

it("parses plan commands and validates prompts and versions", () => {
	expect(parseArgs(["plan-update", "run", "Improve", "this"])).toEqual({
		command: "plan-update",
		runId: "run",
		prompt: "Improve this",
	});
	expect(parseArgs(["plan-diff", "run", "1", "2"])).toEqual({
		command: "plan-diff",
		runId: "run",
		from: 1,
		to: 2,
	});
	expect(parseArgs(["plan-restore", "run", "3"])).toEqual({
		command: "plan-restore",
		runId: "run",
		version: 3,
	});
	for (const args of [
		["plan-update", "run", " "],
		["plan-show", "run", "0"],
		["plan-diff", "run", "1", "2x"],
		["plan-versions"],
	])
		expect(() => parseArgs(args)).toThrow(UsageError);
});

it("parses implement with required PR and optional base", () => {
	expect(parseArgs(["implement", "approved-run", "--pr", "pr-1"])).toEqual({
		command: "implement",
		runId: "approved-run",
		prId: "pr-1",
		base: undefined,
		preview: false,
	});
	expect(
		parseArgs([
			"implement",
			"approved-run",
			"--base",
			"payo/pr-1",
			"--pr",
			"pr-2",
		]),
	).toEqual({
		command: "implement",
		runId: "approved-run",
		prId: "pr-2",
		base: "payo/pr-1",
		preview: false,
	});
	for (const args of [
		["implement", "approved-run"],
		["implement", "approved-run", "--pr"],
		["implement", "approved-run", "--pr", "pr-1", "--pr", "pr-2"],
		["implement", "approved-run", "--pr", "pr-1", "--base"],
		["implement", "approved-run", "--unknown", "value"],
	])
		expect(() => parseArgs(args)).toThrow(UsageError);
});

it("parses serve with forwarded arguments", () => {
	expect(parseArgs(["serve", "--dev-fakes"])).toEqual({
		command: "serve",
		args: ["--dev-fakes"],
	});
});

it("parses start with repo and base overrides", () => {
	expect(parseArgs(["start", "ABC-123"])).toEqual({
		command: "start",
		workItemRequest: { source: "jira", key: "ABC-123" },
		repo: undefined,
		baseBranch: undefined,
	});
	expect(
		parseArgs(["start", "ABC-123", "--repo", "/repo", "--base", "develop"]),
	).toEqual({
		command: "start",
		workItemRequest: { source: "jira", key: "ABC-123" },
		repo: "/repo",
		baseBranch: "develop",
	});
});

it("parses variadic prompt text and source-conflicting options", () => {
	expect(
		parseArgs([
			"start",
			"--prompt",
			"create",
			"a",
			"simple",
			"FastAPI",
			"todo",
			"app",
			"with",
			"strict",
			"typing",
		]),
	).toEqual({
		command: "start",
		workItemRequest: {
			source: "prompt",
			text: "create a simple FastAPI todo app with strict typing",
		},
		repo: undefined,
		baseBranch: undefined,
	});
	expect(
		parseArgs([
			"start",
			"--repo",
			"/repo",
			"--prompt",
			"Build",
			"it",
			"--base",
			"main",
		]),
	).toMatchObject({
		workItemRequest: { source: "prompt", text: "Build it" },
		repo: "/repo",
		baseBranch: "main",
	});
	expect(parseArgs(["start", "--prompt", "--", "--repo"])).toMatchObject({
		workItemRequest: { source: "prompt", text: "--repo" },
	});
	expect(parseArgs(["start", "--prompt", 'Build "the" app'])).toMatchObject({
		workItemRequest: { source: "prompt", text: 'Build "the" app' },
	});
	for (const args of [
		["start", "--prompt"],
		["start", "--prompt", "  "],
		["start", "ABC-123", "--prompt", "Build"],
		["start", "--prompt", "Build", "--prompt", "again"],
		["start", "--prompt", "Build", "--unknown"],
		["start", "--", "ABC-123"],
	])
		expect(() => parseArgs(args)).toThrow(UsageError);
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

it("requires explicit publication and parses naming confirmation", () => {
	expect(
		parseArgs([
			"implement",
			"r",
			"--pr",
			"p",
			"--confirm",
			"hash",
			"--no-ticket",
		]),
	).toMatchObject({ confirm: "hash", ticketId: null });
	expect(parseArgs(["publish", "r", "--preview"])).toMatchObject({
		preview: true,
	});
	expect(
		parseArgs(["execution-naming", "r", "--slug", "create-new-entity"]),
	).toMatchObject({ slug: "create-new-entity" });
	for (const args of [
		["publish", "r"],
		["publish", "r", "--preview", "--confirm", "h"],
		["implement", "r", "--pr", "p", "--no-ticket", "--ticket-id", "ABC-1"],
		["publish", "r", "--confirm"],
	])
		expect(() => parseArgs(args)).toThrow(UsageError);
});
