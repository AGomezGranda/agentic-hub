import { isAbsolute } from "node:path";
import { PublicationCommit } from "@payo/contracts";
import type { RepositoryPublication } from "@payo/kernel";
import { createGitExec, type GitExec } from "./exec.ts";

export interface RepositoryPublicationOptions {
	bin?: string;
	exec?: GitExec;
	timeoutMs?: number;
}

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function requireRemote(value: string): void {
	if (/[\p{Cc}\s]/u.test(value)) throw new Error("unsafe publication remote");
	if (isAbsolute(value)) return;
	if (
		/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)
	)
		return;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("unsupported publication remote");
	}
	if (
		url.hostname !== "github.com" ||
		url.port ||
		url.password ||
		url.search ||
		url.hash ||
		!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname) ||
		!(
			(url.protocol === "https:" && !url.username) ||
			(url.protocol === "ssh:" && url.username === "git")
		)
	)
		throw new Error("unsupported or credential-bearing publication remote");
}

export function createRepositoryPublication(
	options: RepositoryPublicationOptions = {},
): RepositoryPublication {
	const exec = options.exec ?? createGitExec(options);
	const run = async (args: string[], signal: AbortSignal, cwd?: string) => {
		signal.throwIfAborted();
		const result = await exec(
			[
				"-c",
				"protocol.ext.allow=never",
				"-c",
				"protocol.file.allow=always",
				...args,
			],
			{
				cwd,
				signal,
				timeoutMs: options.timeoutMs ?? 30_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		if (result.exitCode !== 0)
			throw new Error(
				`publication git ${args[0]} failed (exit ${result.exitCode})`,
			);
		return result.stdout;
	};
	const branchRef = async (branch: string, signal: AbortSignal) => {
		if (branch.startsWith("-")) throw new Error("invalid publication branch");
		await run(["check-ref-format", "--branch", branch], signal);
		return `refs/heads/${branch}`;
	};
	return {
		async resolveRemote(repo, remote, signal) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote))
				throw new Error("invalid publication remote name");
			const fetchUrls = (
				await run(["remote", "get-url", "--all", remote], signal, repo)
			)
				.trim()
				.split("\n");
			const pushUrls = (
				await run(
					["remote", "get-url", "--push", "--all", remote],
					signal,
					repo,
				)
			)
				.trim()
				.split("\n");
			if (fetchUrls.length !== 1 || pushUrls.length !== 1)
				throw new Error(
					"multiple publication remote destinations are unsupported",
				);
			const fetchUrl = fetchUrls[0] ?? "";
			const pushUrl = pushUrls[0] ?? "";
			requireRemote(fetchUrl);
			requireRemote(pushUrl);
			return { fetchUrl, pushUrl };
		},
		async readCommits(path, baseCommit, resultCommit, signal) {
			if (!SHA.test(baseCommit) || !SHA.test(resultCommit))
				throw new Error("invalid publication commit SHA");
			await run(
				["merge-base", "--is-ancestor", baseCommit, resultCommit],
				signal,
				path,
			);
			const text = await run(
				[
					"log",
					"--reverse",
					"--format=%H%x00%s%x00%B%x00",
					`${baseCommit}..${resultCommit}`,
					"--",
				],
				signal,
				path,
			);
			const fields = text.split("\0");
			const result = [];
			for (let index = 0; index + 2 < fields.length; index += 3)
				result.push(
					PublicationCommit.parse({
						sha: fields[index]?.trim(),
						subject: fields[index + 1],
						message: fields[index + 2]?.trimEnd(),
					}),
				);
			return result;
		},
		async readRemoteHead(pushUrl, branch, signal) {
			requireRemote(pushUrl);
			const ref = await branchRef(branch, signal);
			const text = (
				await run(["ls-remote", "--refs", "--", pushUrl, ref], signal)
			).trim();
			if (text === "") return null;
			const entries = text.split("\n");
			const [sha, name] = entries[0]?.split(/\s+/) ?? [];
			if (entries.length !== 1 || name !== ref || !sha || !SHA.test(sha))
				throw new Error("invalid publication remote head response");
			return sha;
		},
		async pushCommit(path, pushUrl, branch, commit, signal) {
			requireRemote(pushUrl);
			if (!SHA.test(commit)) throw new Error("invalid publication commit SHA");
			const ref = await branchRef(branch, signal);
			// Git skips leases for an identical ref, so reject already-present refs before the atomic create lease too.
			if ((await this.readRemoteHead(pushUrl, branch, signal)) !== null)
				throw new Error("publication remote branch already exists");
			const output = await run(
				[
					"-c",
					"push.followTags=false",
					"push",
					"--porcelain",
					"--no-follow-tags",
					"--recurse-submodules=no",
					`--force-with-lease=${ref}:`,
					"--",
					pushUrl,
					`${commit}:${ref}`,
				],
				signal,
				path,
			);
			if (
				!output
					.split("\n")
					.some((line) => line.startsWith("*\t") && line.includes(`:${ref}\t`))
			)
				throw new Error("publication push did not create a new remote branch");
		},
	};
}
