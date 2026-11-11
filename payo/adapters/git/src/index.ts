import {
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { DoctorCheck } from "@payo/contracts";
import type { Workspace } from "@payo/kernel";
import { createGitExec, type GitExec, resolveBaseCommit } from "./exec.ts";

export {
	BaseNotFoundError,
	createGitExec,
	type GitExec,
	resolveBaseCommit,
} from "./exec.ts";
export type { ExecutionGitOptions } from "./execution.ts";
export { createExecutionWorkspace } from "./execution.ts";
export {
	createRepositoryPublication,
	type RepositoryPublicationOptions,
} from "./publication.ts";

export interface GitWorkspaceOptions {
	root: string;
	bin?: string;
	exec?: GitExec;
	timeoutMs?: number;
}

const MAX_DETAIL = 512;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createGitWorkspace(options: GitWorkspaceOptions): Workspace {
	const exec =
		options.exec ??
		createGitExec({ bin: options.bin, timeoutMs: options.timeoutMs });
	const root = resolve(options.root);
	const run = (args: string[]) => exec(args, {});

	return {
		async create(runId, repo, base) {
			if (!RUN_ID.test(runId) || runId === "." || runId === "..") {
				throw new Error(`invalid run id: ${runId}`);
			}
			const path = resolve(join(root, runId));
			requireInside(root, path);
			if (!isAbsolute(repo)) throw new Error(`repo must be absolute: ${repo}`);
			const top = await run(["-C", repo, "rev-parse", "--show-toplevel"]);
			if (top.exitCode !== 0) {
				throw new Error(`not a git repository: ${repo}`);
			}
			const commit = await resolveBaseCommit(repo, base, exec);

			if (await exists(path)) {
				await requireRealInside(root, await realpath(path));
				if (!(await isRegistered(repo, path, exec))) {
					throw new Error(
						`existing path is not a registered worktree: ${path}`,
					);
				}
				await writeMeta(root, runId, repo);
				return path;
			}

			await writeMeta(root, runId, repo);
			await run(["-C", repo, "worktree", "prune"]);
			const added = await run([
				"-C",
				repo,
				"worktree",
				"add",
				"--detach",
				path,
				commit,
			]);
			if (added.exitCode !== 0) {
				throw new Error(
					`git worktree add ${path} failed (exit ${added.exitCode}): ${added.stderr.trim()}`,
				);
			}
			return path;
		},

		async remove(target) {
			const path = resolve(target);
			const runId = basename(path);
			requireInside(root, path);

			const present = await exists(path);
			if (present) await requireRealInside(root, await realpath(path));
			const metaRepo = await readMetaRepo(root, runId);
			const metaPath = metaFile(root, runId);

			if (!present) {
				if (metaRepo !== null) {
					await run(["-C", metaRepo, "worktree", "prune"]).catch(() => {});
					await rm(metaPath, { force: true });
				}
				return;
			}

			const common = await resolveCommonDir(path, metaRepo, exec);
			if (common === null) {
				throw new Error(`not a registered worktree: ${path}`);
			}
			if (!(await isRegisteredHere(common, path, exec))) {
				throw new Error(`not a registered worktree: ${path}`);
			}
			const removed = await run([
				`--git-dir=${common}`,
				"worktree",
				"remove",
				"--force",
				path,
			]);
			if (removed.exitCode !== 0) {
				await rm(path, { recursive: true, force: true });
				await run([`--git-dir=${common}`, "worktree", "prune"]);
			}
			await rm(metaPath, { force: true });
		},
	};
}

/**
 * The file blob at `path` in `commit`. Returns null when git exits non-zero for
 * `commit:path` (missing, or not a file such as a directory) or the content is blank.
 * Rejects when git cannot run (spawn error, timeout, maxBuffer).
 */
export async function readBlobAt(
	repo: string,
	commit: string,
	path: string,
	exec: GitExec,
): Promise<{ sha: string; content: string } | null> {
	const spec = `${commit}:${path}`;
	const sha = await exec(["-C", repo, "rev-parse", spec], {});
	const content = await exec(["-C", repo, "cat-file", "blob", spec], {});
	if (
		sha.exitCode !== 0 ||
		content.exitCode !== 0 ||
		content.stdout.trim().length === 0
	)
		return null;
	return { sha: sha.stdout.trim(), content: content.stdout };
}

export async function checkGit(options: {
	bin?: string;
	repo: string;
	base: string;
	exec?: GitExec;
}): Promise<DoctorCheck> {
	const exec = options.exec ?? createGitExec({ bin: options.bin });
	try {
		const version = await exec(["--version"], {});
		if (version.exitCode !== 0) {
			return {
				name: "git",
				ok: false,
				detail: clamp(
					`git --version failed (exit ${version.exitCode}): ${excerpt(version.stderr || version.stdout)}`,
					MAX_DETAIL,
				),
			};
		}
		const commit = await resolveBaseCommit(options.repo, options.base, exec);
		return {
			name: "git",
			ok: true,
			detail: clamp(`base ${options.base} at ${commit}`, MAX_DETAIL),
		};
	} catch (error) {
		return {
			name: "git",
			ok: false,
			detail: clamp(describeError(error), MAX_DETAIL),
		};
	}
}

async function resolveCommonDir(
	path: string,
	metaRepo: string | null,
	exec: GitExec,
): Promise<string | null> {
	const fromPath = await exec(
		["-C", path, "rev-parse", "--git-common-dir"],
		{},
	);
	if (fromPath.exitCode === 0 && fromPath.stdout.trim().length > 0) {
		return resolve(path, fromPath.stdout.trim());
	}
	if (metaRepo !== null) {
		const fromRepo = await exec(
			["-C", metaRepo, "rev-parse", "--git-common-dir"],
			{},
		);
		if (fromRepo.exitCode === 0 && fromRepo.stdout.trim().length > 0) {
			return resolve(metaRepo, fromRepo.stdout.trim());
		}
	}
	return null;
}

async function isRegistered(
	repo: string,
	path: string,
	exec: GitExec,
): Promise<boolean> {
	const list = await exec(["-C", repo, "worktree", "list", "--porcelain"], {});
	return list.exitCode === 0 && (await listsPath(list.stdout, path));
}

async function isRegisteredHere(
	common: string,
	path: string,
	exec: GitExec,
): Promise<boolean> {
	const list = await exec(
		[`--git-dir=${common}`, "worktree", "list", "--porcelain"],
		{},
	);
	return list.exitCode === 0 && (await listsPath(list.stdout, path));
}

async function listsPath(porcelain: string, path: string): Promise<boolean> {
	const target = resolve(path);
	const realTarget = await realpath(path).catch(() => target);
	for (const line of porcelain.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const entry = resolve(line.slice("worktree ".length).trim());
		if (entry === target) return true;
		const realEntry = await realpath(entry).catch(() => entry);
		if (realEntry === realTarget) return true;
	}
	return false;
}

function requireInside(root: string, path: string): void {
	if (!isInside(root, path)) {
		throw new Error(`path is outside the worktree root: ${path}`);
	}
}

async function requireRealInside(root: string, path: string): Promise<void> {
	let realRoot = root;
	try {
		realRoot = await realpath(root);
	} catch {}
	if (!isInside(root, path) && !isInside(realRoot, path)) {
		throw new Error(`path is outside the worktree root: ${path}`);
	}
}

function isInside(root: string, path: string): boolean {
	const prefix = root.endsWith(sep) ? root : root + sep;
	return path.startsWith(prefix);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function metaFile(root: string, runId: string): string {
	return join(root, ".meta", `${runId}.json`);
}

async function writeMeta(
	root: string,
	runId: string,
	repo: string,
): Promise<void> {
	await mkdir(join(root, ".meta"), { recursive: true, mode: 0o700 });
	await writeFile(metaFile(root, runId), JSON.stringify({ repo }), {
		mode: 0o600,
	});
}

async function readMetaRepo(
	root: string,
	runId: string,
): Promise<string | null> {
	try {
		const raw = JSON.parse(await readFile(metaFile(root, runId), "utf8"));
		return typeof raw === "object" &&
			raw !== null &&
			typeof (raw as Record<string, unknown>).repo === "string"
			? ((raw as Record<string, unknown>).repo as string)
			: null;
	} catch {
		return null;
	}
}

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function excerpt(value: string): string {
	const text = value.trim();
	return text.length > 0 ? text : "no output";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
