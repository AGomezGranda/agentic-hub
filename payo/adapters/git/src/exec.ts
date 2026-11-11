import { execFile } from "node:child_process";

export type GitExec = (
	args: string[],
	options: {
		cwd?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		maxBuffer?: number;
	},
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const DEFAULT_TIMEOUT_MS = 30000;

export function createGitExec(options?: {
	bin?: string;
	timeoutMs?: number;
}): GitExec {
	const bin = options?.bin ?? "git";
	const defaultTimeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return (args, { cwd, timeoutMs, signal, maxBuffer } = {}) =>
		new Promise((resolvePromise, reject) => {
			execFile(
				bin,
				args,
				{
					cwd,
					timeout: timeoutMs ?? defaultTimeout,
					maxBuffer: maxBuffer ?? 16 * 1024 * 1024,
					shell: false,
					signal,
				},
				(error, stdout, stderr) => {
					if (error === null) {
						resolvePromise({ stdout, stderr, exitCode: 0 });
						return;
					}
					if (typeof error.code === "number") {
						resolvePromise({ stdout, stderr, exitCode: error.code });
						return;
					}
					reject(error);
				},
			);
		});
}

export class BaseNotFoundError extends Error {}

export async function resolveBaseCommit(
	repo: string,
	base: string,
	exec: GitExec,
	signal?: AbortSignal,
): Promise<string> {
	for (const ref of [
		`refs/heads/${base}^{commit}`,
		`refs/remotes/origin/${base}^{commit}`,
		`${base}^{commit}`,
	]) {
		const result = await exec(
			["-C", repo, "rev-parse", "--verify", "--quiet", ref],
			{ signal },
		);
		const commit = result.stdout.trim();
		if (result.exitCode === 0 && commit.length > 0) return commit;
		if (result.exitCode !== 1)
			throw new Error(
				`git rev-parse ${ref} failed (exit ${result.exitCode}): ${result.stderr.trim() || "no commit returned"}`,
			);
	}
	throw new BaseNotFoundError(`base ${base} not found in ${repo}`);
}
