#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunEvent, RunSummary } from "@payo/contracts";
import { type Command, parseArgs, UsageError } from "./args.ts";
import {
	CliClient,
	ClientError,
	readToken,
	resolveDataDir,
	serverUrl,
} from "./client.ts";
import { editPlan } from "./editor.ts";

export interface CliIo {
	env?: NodeJS.ProcessEnv;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

export async function runCli(
	argv: readonly string[],
	io: CliIo = {},
): Promise<number> {
	const env = io.env ?? process.env;
	const stdout = io.stdout ?? ((text) => process.stdout.write(text));
	const stderr = io.stderr ?? ((text) => process.stderr.write(text));

	let command: Command;
	try {
		command = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			stderr(`payo: ${error.message}\n`);
			return 2;
		}
		throw error;
	}

	try {
		if (command.command === "serve") return await serve(command.args, stderr);
		if (command.command === "token") {
			stdout(`${await readToken(resolveDataDir(env))}\n`);
			return 0;
		}

		const dataDir = resolveDataDir(env);
		const client = new CliClient(serverUrl(env), await readToken(dataDir));

		switch (command.command) {
			case "start": {
				const runId = await client.start({
					ticketKey: command.ticketKey,
					repo: command.repo,
					baseBranch: command.baseBranch,
				});
				stdout(`${runId}\n`);
				return 0;
			}
			case "status":
				stdout(formatSummary(await client.summary(command.runId)));
				return 0;
			case "logs":
				if (!command.follow) {
					for (const event of await client.events(command.runId))
						stdout(`${JSON.stringify(event)}\n`);
					return 0;
				}
				await follow(client, command.runId, stdout);
				return 0;
			case "answer":
				stdout(
					formatSummary(
						await client.answer(command.runId, {
							questionId: command.questionId,
							text: command.text,
						}),
					),
				);
				return 0;
			case "approve":
				stdout(formatSummary(await client.approve(command.runId)));
				return 0;
			case "request-changes":
				stdout(`${await client.requestChanges(command.runId)}\n`);
				return 0;
			case "resume":
				stdout(`${await client.resume(command.runId)}\n`);
				return 0;
			case "edit": {
				await client.summary(command.runId);
				return await editPlan({ dataDir, runId: command.runId, env });
			}
			case "doctor": {
				const report = await client.doctor();
				for (const check of report.checks)
					stdout(
						`${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}\n`,
					);
				return report.ok ? 0 : 1;
			}
			default:
				return 2;
		}
	} catch (error) {
		if (error instanceof ClientError) {
			stderr(`payo: ${error.code}: ${error.message}\n`);
			return 1;
		}
		const message = error instanceof Error ? error.message : String(error);
		stderr(`payo: ${message}\n`);
		return 1;
	}
}

export function formatSummary(summary: RunSummary): string {
	const lines = [
		`Run ${summary.runId}`,
		`repo: ${summary.repo} (base: ${summary.baseBranch})`,
		`status: ${summary.status}${summary.outcome ? ` (${summary.outcome})` : ""}`,
		`stage: ${summary.stage ?? "unknown"}`,
	];
	if (summary.openGates.length === 0) {
		lines.push("open gates: none");
	} else {
		lines.push("open gates:");
		for (const gate of summary.openGates)
			lines.push(
				`  ${gate.gateId} [${gate.kind}] ${gate.reason} (commands: ${gate.allowedCommands.join(", ")})`,
			);
	}
	return `${lines.join("\n")}\n`;
}

async function follow(
	client: CliClient,
	runId: string,
	stdout: (text: string) => void,
): Promise<void> {
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	try {
		await client.stream(
			runId,
			(event: RunEvent) => stdout(`${JSON.stringify(event)}\n`),
			{ signal: controller.signal, fromSeq: 1 },
		);
	} finally {
		process.removeListener("SIGINT", interrupt);
	}
}

async function serve(
	args: readonly string[],
	stderr: (text: string) => void,
): Promise<number> {
	const serverMain = fileURLToPath(
		new URL("../../server/src/main.ts", import.meta.url),
	);
	const child = spawn(process.execPath, [serverMain, ...args], {
		stdio: "inherit",
	});
	const forward = (signal: NodeJS.Signals) => child.kill(signal);
	process.on("SIGINT", forward);
	process.on("SIGTERM", forward);
	return new Promise<number>((resolve, reject) => {
		child.on("error", (error) => {
			stderr(`payo serve: ${error.message}\n`);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			process.removeListener("SIGINT", forward);
			process.removeListener("SIGTERM", forward);
			if (signal) {
				resolve(1);
				return;
			}
			resolve(code ?? 1);
		});
	});
}

function isEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return pathToFileURL(entry).href === import.meta.url;
	}
}

if (isEntryPoint()) {
	void runCli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
