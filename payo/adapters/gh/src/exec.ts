import { execFile } from "node:child_process";

export type GhExec = (
	args: string[],
	options: {
		signal: AbortSignal;
		timeoutMs: number;
		maxBuffer: number;
		input?: string;
	},
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export function createGhExec(bin = "gh"): GhExec {
	return (args, { signal, timeoutMs, maxBuffer, input }) =>
		new Promise((resolve, reject) => {
			signal.throwIfAborted();
			const child = execFile(
				bin,
				args,
				{
					signal,
					timeout: timeoutMs,
					maxBuffer,
					shell: false,
					env: {
						...process.env,
						GH_HOST: "github.com",
						GH_PROMPT_DISABLED: "1",
						GH_PAGER: "cat",
						GH_NO_UPDATE_NOTIFIER: "1",
					},
				},
				(error, stdout, stderr) => {
					if (error === null) resolve({ stdout, stderr, exitCode: 0 });
					else if (typeof error.code === "number")
						resolve({ stdout, stderr, exitCode: error.code });
					else reject(error);
				},
			);
			child.stdin?.on("error", (error) => {
				if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
			});
			child.stdin?.end(input);
		});
}
