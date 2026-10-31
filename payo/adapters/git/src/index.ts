import { execFile } from "node:child_process";
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

export type GitExec = (
	args: string[],
	options: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface GitWorkspaceOptions {
	root: string;
	bin?: string;
	exec?: GitExec;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_DETAIL = 512;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createGitExec(options?: {
	bin?: string;
	timeoutMs?: number;
}): GitExec {
	const bin = options?.bin ?? "git";
	const defaultTimeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return (args, { cwd, timeoutMs } = {}) =>
		new Promise((resolvePromise, reject) => {
			execFile(
				bin,
				args,
				{
					cwd,
					timeout: timeoutMs ?? defaultTimeout,
					maxBuffer: 16 * 1024 * 1024,
					shell: false,
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

export async function resolveBaseCommit(
	repo: string,
	base: string,
	exec: GitExec,
): Promise<string> {
	for (const ref of [
		`refs/heads/${base}^{commit}`,
		`refs/remotes/origin/${base}^{commit}`,
		`${base}^{commit}`,
	]) {
		const result = await exec(
			["-C", repo, "rev-parse", "--verify", "--quiet", ref],
			{},
		);
		const commit = result.stdout.trim();
		if (result.exitCode === 0 && commit.length > 0) return commit;
	}
	throw new Error(`base ${base} not found in ${repo}`);
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
