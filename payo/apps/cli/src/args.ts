import type { WorkItemRequest } from "@payo/contracts";

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type Command =
	| { command: "serve"; args: string[] }
	| {
			command: "start";
			workItemRequest: WorkItemRequest;
			repo?: string;
			baseBranch?: string;
	  }
	| { command: "implement"; runId: string; prId: string; base?: string }
	| { command: "status"; runId: string }
	| { command: "logs"; runId: string; follow: boolean }
	| { command: "answer"; runId: string; questionId: string; text: string }
	| { command: "approve"; runId: string }
	| { command: "request-changes"; runId: string }
	| { command: "resume"; runId: string }
	| { command: "edit"; runId: string }
	| { command: "plan-update"; runId: string; prompt: string }
	| { command: "plan-versions"; runId: string }
	| { command: "plan-show" | "plan-restore"; runId: string; version: number }
	| { command: "plan-diff"; runId: string; from: number; to: number }
	| { command: "doctor" }
	| { command: "token" };

function runId(value: string | undefined): string {
	if (!value || value.startsWith("-")) throw new UsageError("run id required");
	return value;
}

function version(value: string | undefined): number {
	if (
		!value ||
		!/^[1-9]\d*$/.test(value) ||
		!Number.isSafeInteger(Number(value))
	)
		throw new UsageError("positive version number required");
	return Number(value);
}

function valueAfter(
	args: readonly string[],
	index: number,
	flag: string,
): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-"))
		throw new UsageError(`${flag} requires a value`);
	return value;
}

function parseStart(
	args: readonly string[],
): Extract<Command, { command: "start" }> {
	let ticketKey: string | undefined;
	let promptSeen = false;
	let promptParts: string[] = [];
	let repo: string | undefined;
	let baseBranch: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--") {
			if (!promptSeen)
				throw new UsageError("-- is only supported after --prompt");
			promptParts = [...promptParts, ...args.slice(index + 1)];
			break;
		}
		if (arg === "--prompt") {
			if (promptSeen) throw new UsageError("--prompt may be used only once");
			promptSeen = true;
		} else if (arg === "--repo") {
			repo = valueAfter(args, index, arg);
			index++;
		} else if (arg === "--base") {
			baseBranch = valueAfter(args, index, arg);
			index++;
		} else if (arg.startsWith("-")) {
			throw new UsageError(`unknown option ${arg}`);
		} else if (promptSeen) {
			promptParts.push(arg);
		} else if (ticketKey === undefined) {
			ticketKey = arg;
		} else {
			throw new UsageError("only one ticket key is allowed");
		}
	}

	if (promptSeen) {
		if (ticketKey !== undefined)
			throw new UsageError("prompt cannot be combined with a Jira ticket key");
		const text = promptParts.join(" ");
		if (!text.trim()) throw new UsageError("prompt text required");
		return {
			command: "start",
			workItemRequest: { source: "prompt", text },
			repo,
			baseBranch,
		};
	}
	if (!ticketKey) throw new UsageError("ticket key required");
	return {
		command: "start",
		workItemRequest: { source: "jira", key: ticketKey },
		repo,
		baseBranch,
	};
}

function parseImplement(
	args: readonly string[],
): Extract<Command, { command: "implement" }> {
	const sourceRunId = runId(args[0]);
	let prId: string | undefined;
	let base: string | undefined;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--pr") {
			if (prId !== undefined)
				throw new UsageError("--pr may be used only once");
			prId = valueAfter(args, index, arg);
			index++;
		} else if (arg === "--base") {
			if (base !== undefined)
				throw new UsageError("--base may be used only once");
			base = valueAfter(args, index, arg);
			index++;
		} else if (arg?.startsWith("-")) {
			throw new UsageError(`unknown option ${arg}`);
		} else {
			throw new UsageError("unexpected positional argument");
		}
	}
	if (!prId)
		throw new UsageError(
			"usage: payo implement <approved-run-id> --pr <pr-id> [--base <ref>]",
		);
	return { command: "implement", runId: sourceRunId, prId, base };
}

export function parseArgs(argv: readonly string[]): Command {
	const [command, ...rest] = argv;
	if (!command) throw new UsageError("usage: payo <command> [options]");

	switch (command) {
		case "plan-update": {
			const prompt = rest.slice(1).join(" ");
			if (!prompt.trim()) throw new UsageError("prompt text required");
			return { command, runId: runId(rest[0]), prompt };
		}
		case "plan-versions":
			if (rest.length !== 1)
				throw new UsageError("usage: payo plan-versions <run-id>");
			return { command, runId: runId(rest[0]) };
		case "plan-show":
		case "plan-restore":
			if (rest.length !== 2)
				throw new UsageError(`usage: payo ${command} <run-id> <version>`);
			return { command, runId: runId(rest[0]), version: version(rest[1]) };
		case "plan-diff":
			if (rest.length !== 3)
				throw new UsageError("usage: payo plan-diff <run-id> <from> <to>");
			return {
				command,
				runId: runId(rest[0]),
				from: version(rest[1]),
				to: version(rest[2]),
			};
		case "serve":
			return { command: "serve", args: [...rest] };
		case "start":
			return parseStart(rest);
		case "implement":
			return parseImplement(rest);
		case "status":
			if (rest.length !== 1)
				throw new UsageError("usage: payo status <run-id>");
			return { command: "status", runId: runId(rest[0]) };
		case "logs": {
			const follow = rest.includes("-f") || rest.includes("--follow");
			const positional = rest.filter(
				(arg) => arg !== "-f" && arg !== "--follow",
			);
			const unknown = positional.find((arg) => arg.startsWith("-"));
			if (unknown) throw new UsageError(`unknown option ${unknown}`);
			if (positional.length !== 1)
				throw new UsageError("usage: payo logs <run-id> [-f]");
			return { command: "logs", runId: runId(positional[0]), follow };
		}
		case "answer": {
			const [id, questionId, ...text] = rest;
			const joined = text.join(" ");
			if (!joined.trim())
				throw new UsageError(
					"usage: payo answer <run-id> <question-id> <answer...>",
				);
			const first = id;
			if (!first || first.startsWith("-"))
				throw new UsageError("run id required");
			const question = questionId;
			if (!question || question.startsWith("-"))
				throw new UsageError("question id required");
			return {
				command: "answer",
				runId: first,
				questionId: question,
				text: joined,
			};
		}
		case "approve":
		case "request-changes":
		case "resume":
		case "edit":
			if (rest.length !== 1)
				throw new UsageError(`usage: payo ${command} <run-id>`);
			return { command, runId: runId(rest[0]) };
		case "token":
			if (rest.length > 0) throw new UsageError("token takes no arguments");
			return { command: "token" };
		case "doctor":
			if (rest.length > 0) throw new UsageError("doctor takes no arguments");
			return { command: "doctor" };
		default:
			throw new UsageError(`unknown command ${command}`);
	}
}
