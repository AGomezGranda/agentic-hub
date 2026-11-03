import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	ExecutionDiffTooLargeError,
	type ExecutionWorkspace as ExecutionWorkspacePort,
	type ExecutionWorkspacePrepareInput,
	type ExecutionWorkspaceSnapshot,
	type PreparedExecutionWorkspace,
} from "@payo/kernel";
import {
	BaseNotFoundError,
	createGitExec,
	type GitExec,
	resolveBaseCommit,
} from "./index.ts";

export interface ExecutionGitOptions {
	root: string;
	bin?: string;
	exec?: GitExec;
	timeoutMs?: number;
}

interface Ownership {
	executionId: string;
	repo: string;
	path: string;
	branch: string;
	baseCommit: string;
}

const EXECUTION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const MAX_INSTRUCTION_FILES = 32;
const MAX_INSTRUCTION_BYTES = 256 * 1024;

/** Execution worktrees use named branches and are never routed through forced cleanup. */
export function createExecutionWorkspace(
	options: ExecutionGitOptions,
): ExecutionWorkspacePort {
	const configuredRoot = resolve(options.root);
	const exec =
		options.exec ??
		createGitExec({ bin: options.bin, timeoutMs: options.timeoutMs });
	const git = async (
		args: string[],
		cwd: string | undefined,
		signal: AbortSignal,
		maxBuffer?: number,
	) => {
		assertNotAborted(signal);
		const result = await exec(args, { cwd, signal, maxBuffer });
		assertNotAborted(signal);
		return result;
	};
	const run = async (
		cwd: string,
		args: string[],
		signal: AbortSignal,
		maxBuffer?: number,
	) => {
		const result = await git(args, cwd, signal, maxBuffer);
		if (result.exitCode !== 0)
			throw new Error(
				`git ${args.join(" ")} failed (exit ${result.exitCode}): ${excerpt(result.stderr || result.stdout)}`,
			);
		return result.stdout;
	};

	return {
		async resolveBase(repo, ref, signal) {
			assertNotAborted(signal);
			if (!isAbsolute(repo)) throw new Error(`repo must be absolute: ${repo}`);
			const resolved = await resolveBaseCommit(repo, ref, exec, signal);
			assertNotAborted(signal);
			return resolved;
		},

		async prepare(input, signal): Promise<PreparedExecutionWorkspace> {
			assertNotAborted(signal);
			validatePrepareInput(input, configuredRoot);
			const root = input.worktreeRoot;
			await mkdir(root, { recursive: true, mode: 0o700 });
			const realRoot = await realpath(root);
			const repo = await realpath(input.repo);
			const path = resolve(root, input.executionId);
			assertInside(root, path);
			const realPath = (await exists(path))
				? await realpath(path)
				: resolve(realRoot, input.executionId);
			assertInside(realRoot, realPath);
			const metaPath = join(root, ".meta", `${input.executionId}.json`);
			const meta = await readOwnership(metaPath);
			const metadataExists = await exists(metaPath);
			const worktrees = await run(
				repo,
				["worktree", "list", "--porcelain"],
				signal,
			);
			const listed = parseWorktrees(worktrees);
			const pathEntry = await findWorktreeByPath(listed, path);
			const branchEntry = listed.find(
				(entry) => entry.branch === `refs/heads/${input.branch}`,
			);
			const branchResult = await git(
				["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
				repo,
				signal,
			);
			const branchExists = branchResult.exitCode === 0;
			const pathExists = await exists(path);

			if (
				pathEntry ||
				branchEntry ||
				branchExists ||
				pathExists ||
				metadataExists
			) {
				if (pathExists && !pathEntry)
					throw new Error(
						`existing execution path is not a registered worktree: ${path}`,
					);
				if (branchExists && !branchEntry)
					throw new Error(`execution branch collision: ${input.branch}`);
				if (!pathEntry || !branchEntry || !branchExists || !pathExists)
					throw new Error(
						`execution workspace ownership collision for ${input.executionId}`,
					);
				if (metadataExists && !meta)
					throw new Error(
						`invalid execution workspace ownership metadata for ${input.executionId}`,
					);
				const expected: Ownership = {
					executionId: input.executionId,
					repo,
					path,
					branch: input.branch,
					baseCommit: input.baseCommit,
				};
				if (
					(meta && !sameOwnership(meta, expected)) ||
					!(await pathsEqual(pathEntry.path, path)) ||
					!(await pathsEqual(branchEntry.path, path))
				)
					throw new Error(
						`execution workspace ownership mismatch for ${input.executionId}`,
					);
				const snapshot = await this.inspect(path, signal);
				if (
					snapshot.branch !== input.branch ||
					snapshot.head !== input.baseCommit
				)
					throw new Error(
						`unexpected HEAD or branch in reused execution workspace ${path}`,
					);
				if (snapshot.changedPaths.length > 0)
					throw new Error(`refusing dirty reused execution worktree ${path}`);
				if (!meta) {
					await mkdir(join(root, ".meta"), {
						recursive: true,
						mode: 0o700,
					});
					await writeOwnership(metaPath, expected);
				}
				return { path, branch: input.branch, baseCommit: input.baseCommit };
			}

			if (!isAbsolute(input.repo))
				throw new Error(`repo must be absolute: ${input.repo}`);
			const top = (
				await run(repo, ["rev-parse", "--show-toplevel"], signal)
			).trim();
			if (!(await stat(top)).isDirectory())
				throw new Error(`not a git repository: ${input.repo}`);
			const resolvedBase = (
				await run(
					repo,
					[
						"rev-parse",
						"--verify",
						"--quiet",
						"--end-of-options",
						`${input.baseCommit}^{commit}`,
					],
					signal,
				)
			).trim();
			if (resolvedBase !== input.baseCommit)
				throw new Error(`invalid base commit ${input.baseCommit}`);
			const added = await git(
				["worktree", "add", "-b", input.branch, path, input.baseCommit],
				repo,
				signal,
			);
			if (added.exitCode !== 0)
				throw new Error(
					`git worktree add ${path} failed (exit ${added.exitCode}): ${excerpt(added.stderr || added.stdout)}`,
				);
			try {
				const actualPath = await realpath(path);
				assertInside(realRoot, actualPath);
				const actual = await this.inspect(path, signal);
				if (actual.head !== input.baseCommit || actual.branch !== input.branch)
					throw new Error(
						`created execution worktree has unexpected HEAD or branch: ${path}`,
					);
				await mkdir(join(root, ".meta"), { recursive: true, mode: 0o700 });
				await writeOwnership(metaPath, {
					executionId: input.executionId,
					repo,
					path,
					branch: input.branch,
					baseCommit: input.baseCommit,
				});
			} catch (error) {
				// Only undo the worktree created by this invocation; never remove a pre-existing path.
				await run(repo, ["worktree", "remove", path], signal).catch(() => {});
				// The branch was created by the `worktree add -b` above; leaving it makes every retry collide.
				await run(repo, ["branch", "-D", input.branch], signal).catch(() => {});
				throw error;
			}
			return { path, branch: input.branch, baseCommit: input.baseCommit };
		},

		async inspect(path, signal): Promise<ExecutionWorkspaceSnapshot> {
			const workspacePath = await checkedWorktreePath(configuredRoot, path);
			const head = (
				await run(workspacePath, ["rev-parse", "HEAD"], signal)
			).trim();
			const branch = (
				await run(workspacePath, ["branch", "--show-current"], signal)
			).trim();
			if (!branch)
				throw new Error(`execution worktree is detached: ${workspacePath}`);
			const status = await run(
				workspacePath,
				[
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
					"--no-renames",
				],
				signal,
			);
			const changedPaths = parseChangedPaths(status);
			const trackedDiff = await run(
				workspacePath,
				["diff", "HEAD", "--binary", "--no-ext-diff", "--"],
				signal,
			);
			const untracked = await untrackedDigests(workspacePath, changedPaths);
			const refs = await run(
				workspacePath,
				[
					"for-each-ref",
					"--format=%(refname) %(objectname)",
					"refs/heads",
					"refs/remotes",
				],
				signal,
			);
			const reflogs = await run(
				workspacePath,
				["reflog", "show", "--all", "--format=%H:%gD"],
				signal,
			);
			const historyFingerprint = createHash("sha256")
				.update(`${refs}\0${reflogs}`)
				.digest("hex");
			const fingerprint = createHash("sha256")
				.update(
					JSON.stringify({
						head,
						branch,
						status,
						trackedDiff,
						untracked,
						historyFingerprint,
					}),
				)
				.digest("hex");
			return { head, branch, fingerprint, changedPaths, historyFingerprint };
		},

		async diff(path, baseCommit, signal, maxBytes): Promise<string> {
			const workspacePath = await checkedWorktreePath(configuredRoot, path);
			if (!COMMIT.test(baseCommit))
				throw new Error(`invalid base commit ${baseCommit}`);
			if (
				maxBytes !== undefined &&
				(!Number.isInteger(maxBytes) || maxBytes < 1)
			)
				throw new RangeError("maxBytes must be a positive integer");

			const diffs: string[] = [];
			let capturedBytes = 0;
			const capture = async (args: string[]) => {
				const separatorBytes = diffs.some((diff) => diff.length > 0) ? 1 : 0;
				const remaining =
					maxBytes === undefined
						? undefined
						: Math.max(1, maxBytes - capturedBytes - separatorBytes);
				let output: string;
				try {
					output = await run(workspacePath, args, signal, remaining);
				} catch (error) {
					if (isMaxBufferError(error) && maxBytes !== undefined)
						throw new ExecutionDiffTooLargeError(maxBytes);
					throw error;
				}
				const bytes = Buffer.byteLength(output, "utf8");
				const separator = output.length > 0 && separatorBytes > 0 ? 1 : 0;
				if (
					maxBytes !== undefined &&
					capturedBytes + separator + bytes > maxBytes
				)
					throw new ExecutionDiffTooLargeError(maxBytes);
				capturedBytes += separator + bytes;
				diffs.push(output);
			};

			await capture([
				"diff",
				"--binary",
				"--no-ext-diff",
				`${baseCommit}...HEAD`,
				"--",
			]);
			await capture(["diff", "--binary", "--no-ext-diff", "--"]);
			await capture(["diff", "--cached", "--binary", "--no-ext-diff", "--"]);
			const status = await run(
				workspacePath,
				[
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
					"--no-renames",
				],
				signal,
			);
			const untracked = await untrackedDiffs(
				workspacePath,
				status,
				signal,
				git,
				maxBytes,
				capturedBytes,
			);
			for (const diff of untracked) {
				const separator =
					diff.length > 0 && diffs.some((item) => item.length > 0) ? 1 : 0;
				const bytes = Buffer.byteLength(diff, "utf8");
				if (
					maxBytes !== undefined &&
					capturedBytes + separator + bytes > maxBytes
				)
					throw new ExecutionDiffTooLargeError(maxBytes);
				capturedBytes += separator + bytes;
				diffs.push(diff);
			}
			return joinDiffs(...diffs);
		},

		async verifyPrerequisites(repo, baseCommit, prerequisites, signal) {
			const results = [];
			for (const prerequisite of prerequisites) {
				let reason: string | null = null;
				if (prerequisite.ref) {
					try {
						const refCommit = await resolveBaseCommit(
							repo,
							prerequisite.ref,
							exec,
							signal,
						);
						const ancestor = await git(
							["merge-base", "--is-ancestor", refCommit, baseCommit],
							repo,
							signal,
						);
						if (ancestor.exitCode !== 0)
							reason = `ref ${prerequisite.ref} is not an ancestor of the pinned base`;
					} catch (error) {
						// Only "not found" is a fact about the ref; timeouts, aborts and spawn errors propagate.
						if (!(error instanceof BaseNotFoundError)) throw error;
						reason = `ref ${prerequisite.ref} cannot be resolved`;
					}
				}
				if (reason === null && prerequisite.paths) {
					for (const path of prerequisite.paths) {
						if (
							!path.trim() ||
							isAbsolute(path) ||
							path.split(/[\\/]/).includes("..")
						) {
							reason = `invalid prerequisite path ${path}`;
							break;
						}
						const exists = await git(
							["cat-file", "-e", `${baseCommit}:${path}`],
							repo,
							signal,
						);
						if (exists.exitCode !== 0) {
							reason = `path ${path} is absent at the pinned base`;
							break;
						}
					}
				}
				results.push({
					description: prerequisite.description,
					present: reason === null,
					reason,
				});
			}
			return results;
		},

		async instructions(
			repo,
			baseCommit,
			signal,
		): Promise<Record<string, string>> {
			if (!COMMIT.test(baseCommit))
				throw new Error(`invalid base commit ${baseCommit}`);
			const paths = (
				await run(
					repo,
					["ls-tree", "-r", "--name-only", "-z", baseCommit],
					signal,
				)
			)
				.split("\0")
				.filter(
					(path) =>
						path.length > 0 &&
						["AGENTS.md", "CLAUDE.md"].includes(path.split("/").at(-1) ?? ""),
				)
				.sort();
			if (paths.length > MAX_INSTRUCTION_FILES)
				throw new Error(
					`repository instruction limit exceeded: found ${paths.length}, maximum ${MAX_INSTRUCTION_FILES}`,
				);
			const instructions: Record<string, string> = {};
			let totalBytes = 0;
			for (const path of paths) {
				const content = await run(
					repo,
					["show", `${baseCommit}:${path}`],
					signal,
				);
				totalBytes += Buffer.byteLength(content, "utf8");
				if (totalBytes > MAX_INSTRUCTION_BYTES)
					throw new Error(
						`repository instruction size limit exceeded: maximum ${MAX_INSTRUCTION_BYTES} bytes`,
					);
				instructions[path] = content;
			}
			return instructions;
		},

		async prepareCommit(path, expectedSnapshot, signal) {
			const workspacePath = await checkedWorktreePath(configuredRoot, path);
			const before = await this.inspect(workspacePath, signal);
			if (before.fingerprint !== expectedSnapshot)
				throw new Error("workspace snapshot changed before staging");
			await run(workspacePath, ["add", "--all"], signal);
			const unstaged = await git(
				["diff", "--quiet", "--"],
				workspacePath,
				signal,
			);
			if (unstaged.exitCode !== 0)
				throw new Error("workspace changed while preparing commit");
			const staged = await git(
				["diff", "--cached", "--quiet", "HEAD", "--"],
				workspacePath,
				signal,
			);
			if (staged.exitCode !== 0 && staged.exitCode !== 1)
				throw new Error(`git diff --cached failed (exit ${staged.exitCode})`);
			const [parent, tree] = await Promise.all([
				run(workspacePath, ["rev-parse", "HEAD"], signal).then((value) =>
					value.trim(),
				),
				run(workspacePath, ["write-tree"], signal).then((value) =>
					value.trim(),
				),
			]);
			const after = await this.inspect(workspacePath, signal);
			return {
				parent,
				tree,
				expectedSnapshot: after.fingerprint,
				changed: staged.exitCode === 1,
			};
		},

		async inspectCommit(path, signal) {
			const workspacePath = await checkedWorktreePath(configuredRoot, path);
			const [head, tree, parentResult, message] = await Promise.all([
				run(workspacePath, ["rev-parse", "HEAD"], signal).then((value) =>
					value.trim(),
				),
				run(workspacePath, ["rev-parse", "HEAD^{tree}"], signal).then((value) =>
					value.trim(),
				),
				git(["rev-parse", "--verify", "HEAD^"], workspacePath, signal),
				run(workspacePath, ["show", "-s", "--format=%B", "HEAD"], signal),
			]);
			return {
				head,
				parent: parentResult.exitCode === 0 ? parentResult.stdout.trim() : null,
				tree,
				message: message.trimEnd(),
			};
		},

		async commit(
			path,
			expectedSnapshot,
			message,
			signal,
			expectation,
		): Promise<string> {
			if (!message.trim()) throw new Error("commit message must not be blank");
			const workspacePath = await checkedWorktreePath(configuredRoot, path);
			const before = await this.inspect(workspacePath, signal);
			if (before.fingerprint !== expectedSnapshot)
				throw new Error("workspace snapshot changed before commit");
			const parent = (
				await run(workspacePath, ["rev-parse", "HEAD"], signal)
			).trim();
			const tree = (await run(workspacePath, ["write-tree"], signal)).trim();
			if (parent !== expectation.parent || tree !== expectation.tree)
				throw new Error("commit parent or tree does not match durable intent");
			if (!message.split(/\r?\n/).includes(expectation.trailer))
				throw new Error("commit message does not contain the intent trailer");
			const meta = (
				await run(workspacePath, ["rev-parse", "--git-common-dir"], signal)
			).trim();
			const common = resolve(workspacePath, meta);
			const listed = parseWorktrees(
				await run(workspacePath, ["worktree", "list", "--porcelain"], signal),
			);
			const ownership = await findWorktreeByPath(listed, workspacePath);
			if (!ownership?.branch?.startsWith("refs/heads/payo/"))
				throw new Error("refusing to commit outside a Payo execution branch");
			await run(workspacePath, ["add", "--all"], signal);
			const unstaged = await git(
				["diff", "--quiet", "--"],
				workspacePath,
				signal,
			);
			if (unstaged.exitCode !== 0)
				throw new Error("workspace changed while staging commit");
			const staged = await git(
				["diff", "--cached", "--quiet", "HEAD", "--"],
				workspacePath,
				signal,
			);
			if (staged.exitCode !== 0 && staged.exitCode !== 1)
				throw new Error(`git diff --cached failed (exit ${staged.exitCode})`);
			const [stagedParent, stagedTree] = await Promise.all([
				run(workspacePath, ["rev-parse", "HEAD"], signal).then((value) =>
					value.trim(),
				),
				run(workspacePath, ["write-tree"], signal).then((value) =>
					value.trim(),
				),
			]);
			if (
				stagedParent !== expectation.parent ||
				stagedTree !== expectation.tree
			)
				throw new Error(
					"staged commit parent or tree does not match durable intent",
				);
			await run(
				workspacePath,
				staged.exitCode === 0
					? ["commit", "--allow-empty", "-m", message]
					: ["commit", "-m", message],
				signal,
			);
			const after = await this.inspect(workspacePath, signal);
			if (after.changedPaths.length > 0)
				throw new Error("commit hook modified the execution workspace");
			const committed = await this.inspectCommit(workspacePath, signal);
			if (
				committed.parent !== expectation.parent ||
				committed.tree !== expectation.tree ||
				!committed.message.split(/\r?\n/).includes(expectation.trailer)
			)
				throw new Error("created commit does not match durable intent");
			const finalCommon = resolve(
				workspacePath,
				(
					await run(workspacePath, ["rev-parse", "--git-common-dir"], signal)
				).trim(),
			);
			if (common !== finalCommon)
				throw new Error(
					"execution worktree Git ownership changed during commit",
				);
			return after.head;
		},
	};
}

function validatePrepareInput(
	input: ExecutionWorkspacePrepareInput,
	root: string,
): void {
	if (!EXECUTION_ID.test(input.executionId))
		throw new Error(`invalid execution id ${input.executionId}`);
	if (!isAbsolute(input.repo))
		throw new Error(`repo must be absolute: ${input.repo}`);
	if (resolve(input.worktreeRoot) !== root)
		throw new Error(`worktree root mismatch: ${input.worktreeRoot}`);
	if (input.branch !== `payo/${input.executionId}`)
		throw new Error(`invalid execution branch ${input.branch}`);
	if (!COMMIT.test(input.baseCommit))
		throw new Error(`invalid base commit ${input.baseCommit}`);
}

async function checkedWorktreePath(
	root: string,
	path: string,
): Promise<string> {
	const target = resolve(path);
	assertInside(root, target);
	const [realRoot, realTarget] = await Promise.all([
		realpath(root),
		realpath(target),
	]);
	assertInside(realRoot, realTarget);
	const statInfo = await lstat(target);
	if (!statInfo.isDirectory())
		throw new Error(`execution worktree is not a directory: ${target}`);
	return target;
}

function assertInside(root: string, target: string): void {
	const relativePath = relative(resolve(root), resolve(target));
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	)
		throw new Error(`path escapes worktree root: ${target}`);
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted)
		throw signal.reason instanceof Error
			? signal.reason
			: new Error("Git operation aborted");
}

function parseWorktrees(
	text: string,
): Array<{ path: string; branch: string | null }> {
	const entries: Array<{ path: string; branch: string | null }> = [];
	for (const block of text.trim().split(/\n\s*\n/)) {
		const lines = block.split("\n");
		const worktree = lines.find((line) => line.startsWith("worktree "));
		if (!worktree) continue;
		const branch =
			lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
		entries.push({ path: worktree.slice(9), branch });
	}
	return entries;
}

function parseChangedPaths(status: string): string[] {
	const parts = status.split("\0");
	return parts
		.flatMap((part) => (part.length >= 4 ? [part.slice(3)] : []))
		.sort();
}

async function untrackedDigests(
	root: string,
	paths: string[],
): Promise<Array<[string, string]>> {
	const values: Array<[string, string]> = [];
	for (const path of paths) {
		const status = await lstat(join(root, path)).catch(() => null);
		if (!status) {
			values.push([path, "missing"]);
		} else if (status.isSymbolicLink()) {
			values.push([path, `symlink:${await readlink(join(root, path))}`]);
		} else if (status.isFile()) {
			const digest = createHash("sha256");
			for await (const chunk of createReadStream(join(root, path)))
				digest.update(chunk);
			values.push([path, digest.digest("hex")]);
		} else {
			values.push([path, `mode:${status.mode}`]);
		}
	}
	return values;
}

async function untrackedDiffs(
	root: string,
	status: string,
	signal: AbortSignal,
	git: (
		args: string[],
		cwd: string | undefined,
		signal: AbortSignal,
		maxBuffer?: number,
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
	maxBytes?: number,
	alreadyCapturedBytes = 0,
): Promise<string[]> {
	const paths = status
		.split("\0")
		.flatMap((entry) =>
			entry.startsWith("?? ") && entry.length >= 4 ? [entry.slice(3)] : [],
		);
	const diffs: string[] = [];
	let capturedBytes = 0;
	let hasDiff = alreadyCapturedBytes > 0;
	for (const path of paths) {
		assertNotAborted(signal);
		const target = resolve(root, path);
		assertInside(root, target);
		const info = await lstat(target);
		if (!info.isFile()) continue;
		const separatorBytes = hasDiff ? 1 : 0;
		const remaining =
			maxBytes === undefined
				? undefined
				: Math.max(
						1,
						maxBytes - alreadyCapturedBytes - capturedBytes - separatorBytes,
					);
		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await git(
				[
					"diff",
					"--no-index",
					"--binary",
					"--no-ext-diff",
					"--",
					"/dev/null",
					path,
				],
				root,
				signal,
				remaining,
			);
		} catch (error) {
			if (isMaxBufferError(error) && maxBytes !== undefined)
				throw new ExecutionDiffTooLargeError(maxBytes);
			throw error;
		}
		if (result.exitCode !== 1 && result.stdout.length === 0)
			throw new Error(
				`could not diff untracked file ${path}: ${result.stderr}`,
			);
		const bytes = Buffer.byteLength(result.stdout, "utf8");
		const separator = result.stdout.length > 0 && hasDiff ? 1 : 0;
		if (
			maxBytes !== undefined &&
			alreadyCapturedBytes + capturedBytes + separator + bytes > maxBytes
		)
			throw new ExecutionDiffTooLargeError(maxBytes);
		capturedBytes += separator + bytes;
		hasDiff ||= result.stdout.length > 0;
		diffs.push(result.stdout);
	}
	return diffs;
}

function joinDiffs(...values: string[]): string {
	return values.filter((value) => value.length > 0).join("\n");
}

async function pathsEqual(left: string, right: string): Promise<boolean> {
	if (resolve(left) === resolve(right)) return true;
	const [realLeft, realRight] = await Promise.all([
		realpath(left).catch(() => resolve(left)),
		realpath(right).catch(() => resolve(right)),
	]);
	return realLeft === realRight;
}

async function findWorktreeByPath(
	entries: Array<{ path: string; branch: string | null }>,
	path: string,
): Promise<{ path: string; branch: string | null } | undefined> {
	for (const entry of entries)
		if (await pathsEqual(entry.path, path)) return entry;
	return undefined;
}

function sameOwnership(left: Ownership, right: Ownership): boolean {
	return (
		left.executionId === right.executionId &&
		left.repo === right.repo &&
		resolve(left.path) === resolve(right.path) &&
		left.branch === right.branch &&
		left.baseCommit === right.baseCommit
	);
}

async function writeOwnership(
	path: string,
	ownership: Ownership,
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(ownership), {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

async function readOwnership(path: string): Promise<Ownership | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const value = parsed as Partial<Ownership>;
		if (
			typeof value.executionId !== "string" ||
			typeof value.repo !== "string" ||
			typeof value.path !== "string" ||
			typeof value.branch !== "string" ||
			typeof value.baseCommit !== "string"
		)
			return null;
		return value as Ownership;
	} catch {
		return null;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isMaxBufferError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
	);
}

function excerpt(value: string): string {
	const text = value.trim();
	return text.length > 0 ? text.slice(0, 512) : "no output";
}
