import { spawn as nodeSpawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { UsageError } from "./args.ts";

export function validateRunId(runId: string): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
		runId === "." ||
		runId === ".."
	)
		throw new UsageError("invalid run id");
}

export function planPath(dataDir: string, runId: string): string {
	validateRunId(runId);
	return join(dataDir, "runs", runId, "plan.md");
}

export function editorCommand(env: NodeJS.ProcessEnv): string[] {
	const editor = env.VISUAL?.trim() || env.EDITOR?.trim();
	if (!editor)
		throw new UsageError(
			"no editor configured: set VISUAL or EDITOR, then retry",
		);
	// shortcut: editor commands split on whitespace, so paths with spaces need a wrapper script; upgrade if that bites.
	return editor.split(/\s+/);
}

export async function editPlan(options: {
	dataDir: string;
	runId: string;
	env: NodeJS.ProcessEnv;
	spawn?: typeof nodeSpawn;
}): Promise<number> {
	const path = planPath(options.dataDir, options.runId);
	const [command, ...args] = editorCommand(options.env);
	if (!command) throw new UsageError("no editor configured");
	await access(path).catch(() => {
		throw new Error(`plan not found at ${path}`);
	});
	const spawn = options.spawn ?? nodeSpawn;
	const child = spawn(command, [...args, path], {
		stdio: "inherit",
		env: options.env,
	});
	return new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`editor terminated by ${signal}`));
				return;
			}
			resolve(code ?? 1);
		});
	});
}
