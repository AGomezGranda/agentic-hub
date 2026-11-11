import { GitHubTarget, PullRequestRecord } from "@payo/contracts";
import type { CodeHost } from "@payo/kernel";
import { createGhExec, type GhExec } from "./exec.ts";

export { createGhExec, type GhExec } from "./exec.ts";
export interface GitHubCodeHostOptions {
	bin?: string;
	exec?: GhExec;
	timeoutMs?: number;
}

export function parseGitHubRemote(value: string): {
	owner: string;
	name: string;
} {
	const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
		value,
	);
	let owner: string | undefined;
	let name: string | undefined;
	if (scp) [, owner, name] = scp;
	else {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error("unsupported GitHub remote");
		}
		if (
			url.hostname !== "github.com" ||
			url.port ||
			url.password ||
			url.search ||
			url.hash ||
			!(
				(url.protocol === "https:" && !url.username) ||
				(url.protocol === "ssh:" && url.username === "git")
			)
		)
			throw new Error("unsupported or credential-bearing GitHub remote");
		const path = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
		if (path) [, owner, name] = path;
	}
	name = name?.replace(/\.git$/, "");
	if (
		!owner ||
		!name ||
		owner === "." ||
		owner === ".." ||
		name === "." ||
		name === ".." ||
		/[\p{Cc}\s]/u.test(value)
	)
		throw new Error("unsupported GitHub remote");
	return { owner, name };
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("malformed GitHub response");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error("malformed GitHub response string");
	return value;
}
function identity(value: unknown) {
	const repo = record(value);
	if (!Number.isSafeInteger(repo.id) || (repo.id as number) < 1)
		throw new Error("malformed GitHub repository ID");
	return {
		repositoryId: String(repo.id),
		owner: text(record(repo.owner).login),
		name: text(repo.name),
	};
}
function requireRef(branch: string) {
	if (!branch || branch.startsWith("-") || /[\p{Cc}\s]/u.test(branch))
		throw new Error("invalid GitHub branch");
}

export function createGitHubCodeHost(
	options: GitHubCodeHostOptions = {},
): CodeHost {
	const exec = options.exec ?? createGhExec(options.bin);
	const run = async (args: string[], signal: AbortSignal, input?: string) => {
		signal.throwIfAborted();
		const result = await exec(args, {
			signal,
			input,
			timeoutMs: options.timeoutMs ?? 30_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		if (result.exitCode !== 0)
			throw new Error(
				`GitHub ${args[0]} failed (exit ${result.exitCode}); outcome may be unknown`,
			);
		return result.stdout;
	};
	const query = async (
		endpoint: string,
		signal: AbortSignal,
		args: string[] = [],
	) =>
		JSON.parse(
			await run(["api", "--hostname", "github.com", endpoint, ...args], signal),
		) as unknown;
	return {
		async resolveRepository(remoteUrl, baseBranch, signal) {
			const requested = parseGitHubRemote(remoteUrl);
			requireRef(baseBranch);
			const repo = identity(
				await query(`repos/${requested.owner}/${requested.name}`, signal),
			);
			if (
				repo.owner.toLowerCase() !== requested.owner.toLowerCase() ||
				repo.name.toLowerCase() !== requested.name.toLowerCase()
			)
				throw new Error("GitHub repository identity changed");
			const branch = record(
				await query(
					`repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(baseBranch)}`,
					signal,
				),
			);
			if (branch.name !== baseBranch)
				throw new Error("GitHub base branch mismatch");
			return GitHubTarget.parse({
				host: "github.com",
				...repo,
				baseBranch,
				baseCommit: record(branch.commit).sha,
			});
		},
		async findPullRequests(targetInput, headBranch, signal) {
			const target = GitHubTarget.parse(targetInput);
			requireRef(headBranch);
			const pages = await query(
				`repos/${target.owner}/${target.name}/pulls`,
				signal,
				[
					"--method",
					"GET",
					"--paginate",
					"--slurp",
					"--raw-field",
					"state=all",
					"--raw-field",
					`head=${target.owner}:${headBranch}`,
					"--raw-field",
					`base=${target.baseBranch}`,
					"--raw-field",
					"per_page=100",
				],
			);
			if (!Array.isArray(pages) || !pages.every(Array.isArray))
				throw new Error("malformed GitHub PR query pages");
			return pages.flat().map((raw: unknown) => {
				const pr = record(raw);
				const head = record(pr.head);
				const base = record(pr.base);
				const baseRepo = identity(base.repo);
				const headRepo = identity(head.repo);
				if (
					baseRepo.repositoryId !== target.repositoryId ||
					baseRepo.owner !== target.owner ||
					baseRepo.name !== target.name
				)
					throw new Error("GitHub PR base repository mismatch");
				if (
					(pr.state !== "open" && pr.state !== "closed") ||
					(pr.merged_at !== null && typeof pr.merged_at !== "string")
				)
					throw new Error("malformed GitHub PR state");
				const normalized = PullRequestRecord.parse({
					number: pr.number,
					url: pr.html_url,
					owner: headRepo.owner,
					name: headRepo.name,
					baseBranch: base.ref,
					headBranch: head.ref,
					headCommit: head.sha,
					state:
						pr.merged_at !== null
							? "MERGED"
							: pr.state === "open"
								? "OPEN"
								: "CLOSED",
					draft: pr.draft,
					title: pr.title,
					body: pr.body,
				});
				if (
					normalized.url !==
					`https://github.com/${target.owner}/${target.name}/pull/${normalized.number}`
				)
					throw new Error("GitHub PR URL mismatch");
				return normalized;
			});
		},
		async createDraftPullRequest(targetInput, input, signal) {
			const target = GitHubTarget.parse(targetInput);
			requireRef(input.headBranch);
			requireRef(target.baseBranch);
			if (
				!input.title.trim() ||
				/\p{Cc}/u.test(input.title) ||
				input.body.includes("\0")
			)
				throw new Error("invalid GitHub PR content");
			await run(
				[
					"pr",
					"create",
					"--repo",
					`${target.host}/${target.owner}/${target.name}`,
					"--base",
					target.baseBranch,
					"--head",
					input.headBranch,
					"--title",
					input.title,
					"--body-file",
					"-",
					"--draft",
				],
				signal,
				input.body,
			);
		},
	};
}
