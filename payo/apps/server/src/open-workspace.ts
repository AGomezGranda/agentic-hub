import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { OpenWorkspaceRequest } from "@payo/contracts";
import { ApiFailure } from "./errors.ts";

export type WorkspaceOpener = (
	path: string,
	target: OpenWorkspaceRequest["target"],
) => Promise<void>;

export const openWorkspace: WorkspaceOpener = async (path, target) => {
	if (!isAbsolute(path) || !(await stat(path).catch(() => null))?.isDirectory())
		throw new ApiFailure(
			409,
			"workspace_unavailable",
			"Workspace directory is unavailable.",
		);

	let command: string;
	let args: string[];
	if (process.platform === "darwin") {
		command = "open";
		args = [
			"-a",
			target === "terminal" ? "Terminal" : "Visual Studio Code",
			path,
		];
	} else if (process.platform === "linux") {
		command = target === "terminal" ? "x-terminal-emulator" : "code";
		args =
			target === "terminal"
				? [
						"-e",
						"sh",
						"-c",
						'cd -- "$1" && exec "$2"',
						"sh",
						path,
						process.env.SHELL ?? "/bin/sh",
					]
				: ["--new-window", path];
	} else {
		// shortcut: macOS and Linux launchers only; add other platforms when needed.
		throw new ApiFailure(
			501,
			"unsupported",
			"Opening a workspace is supported on macOS and Linux.",
		);
	}
	await new Promise<void>((resolve, reject) => {
		if (process.platform === "linux" && target === "terminal") {
			const child = spawn(command, args, {
				cwd: path,
				detached: true,
				stdio: "ignore",
			});
			child.once("error", () =>
				reject(
					new ApiFailure(
						503,
						"launch_failed",
						"Could not open Terminal. Check that x-terminal-emulator is installed and a desktop session is available.",
					),
				),
			);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
			return;
		}
		execFile(command, args, { cwd: path, timeout: 10_000 }, (error) => {
			if (error)
				reject(
					new ApiFailure(
						503,
						"launch_failed",
						`Could not open ${target === "terminal" ? "Terminal" : "VS Code"}. Check that it is installed${process.platform === "linux" ? " and its launcher is on PATH" : ""}.`,
					),
				);
			else resolve();
		});
	});
};
