export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export type Command =
	| { command: "serve"; args: string[] }
	| { command: "start"; ticketKey: string; repo?: string; baseBranch?: string }
	| { command: "status"; runId: string }
	| { command: "logs"; runId: string; follow: boolean }
	| { command: "answer"; runId: string; questionId: string; text: string }
	| { command: "approve"; runId: string }
	| { command: "request-changes"; runId: string }
	| { command: "resume"; runId: string }
	| { command: "edit"; runId: string }
	| { command: "doctor" }
	| { command: "token" };

function runId(value: string | undefined): string {
	if (!value || value.startsWith("-")) throw new UsageError("run id required");
	return value;
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

export function parseArgs(argv: readonly string[]): Command {
	const [command, ...rest] = argv;
	if (!command) throw new UsageError("usage: payo <command> [options]");

	switch (command) {
		case "serve":
			return { command: "serve", args: [...rest] };
		case "start": {
			let ticketKey: string | undefined;
			let repo: string | undefined;
			let baseBranch: string | undefined;
			for (let index = 0; index < rest.length; index++) {
				const arg = rest[index];
				if (arg === undefined) continue;
				if (arg === "--repo") {
					repo = valueAfter(rest, index, arg);
					index++;
				} else if (arg === "--base") {
					baseBranch = valueAfter(rest, index, arg);
					index++;
				} else if (arg.startsWith("-")) {
					throw new UsageError(`unknown option ${arg}`);
				} else if (ticketKey === undefined) {
					ticketKey = arg;
				} else {
					throw new UsageError("only one ticket key is allowed");
				}
			}
			if (!ticketKey) throw new UsageError("ticket key required");
			return { command: "start", ticketKey, repo, baseBranch };
		}
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
