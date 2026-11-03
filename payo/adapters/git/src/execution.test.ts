import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionDiffTooLargeError } from "@payo/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionWorkspace } from "./execution.ts";

const dirs: string[] = [];
const executionId = "00000000-0000-4000-8000-000000000001";

async function tempDir(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			if (error === null) resolve(stdout);
			else reject(new Error(stderr.trim() || error.message));
		});
	});
}

async function fixture() {
	const repo = await tempDir("payo-execution-repo-");
	await git(repo, ["init", "-b", "main"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "Test"]);
	await writeFile(join(repo, "tracked.txt"), "base\n");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-m", "initial"]);
	const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
	const worktreeRoot = join(
		await tempDir("payo-execution-worktrees-"),
		"worktrees",
	);
	const workspace = createExecutionWorkspace({ root: worktreeRoot });
	const input = {
		executionId,
		repo,
		worktreeRoot,
		branch: `payo/${executionId}`,
		baseCommit,
	};
	return { repo, baseCommit, workspace, input };
}

const signal = () => new AbortController().signal;

describe("createExecutionWorkspace", () => {
	it("creates a named branch at the pinned base and reuses only its clean owned worktree", async () => {
		const { repo, baseCommit, workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		expect(prepared).toEqual({
			path: join(input.worktreeRoot, executionId),
			branch: input.branch,
			baseCommit,
		});
		expect(
			(await git(prepared.path, ["branch", "--show-current"])).trim(),
		).toBe(input.branch);
		expect((await git(prepared.path, ["rev-parse", "HEAD"])).trim()).toBe(
			baseCommit,
		);
		const reused = await workspace.prepare(input, signal());
		expect(reused).toEqual(prepared);
		await expect(readFile(join(repo, "tracked.txt"), "utf8")).resolves.toBe(
			"base\n",
		);
	});

	it("reconciles a clean deterministic worktree when preparation metadata was not persisted", async () => {
		const { workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		const metadataPath = join(
			input.worktreeRoot,
			".meta",
			`${executionId}.json`,
		);
		await rm(metadataPath);

		await expect(workspace.prepare(input, signal())).resolves.toEqual(prepared);
		await expect(readFile(metadataPath, "utf8")).resolves.toContain(
			executionId,
		);

		await writeFile(metadataPath, "invalid metadata");
		await expect(workspace.prepare(input, signal())).rejects.toThrow(
			/invalid.*metadata/i,
		);
	});

	it("removes the branch it created when preparation fails after worktree add", async () => {
		const { repo, workspace, input } = await fixture();
		await mkdir(input.worktreeRoot, { recursive: true });
		await writeFile(join(input.worktreeRoot, ".meta"), "not a directory");
		await expect(workspace.prepare(input, signal())).rejects.toThrow();
		await expect(
			git(repo, ["rev-parse", "--verify", "--quiet", input.branch]),
		).rejects.toThrow();
		await rm(join(input.worktreeRoot, ".meta"));
		await expect(workspace.prepare(input, signal())).resolves.toMatchObject({
			branch: input.branch,
		});
	});

	it("reports an unknown prerequisite ref as absent but propagates aborts", async () => {
		const { repo, baseCommit, workspace } = await fixture();
		const prerequisites = [{ description: "dep", ref: "nope" }];
		await expect(
			workspace.verifyPrerequisites(repo, baseCommit, prerequisites, signal()),
		).resolves.toMatchObject([
			{ present: false, reason: "ref nope cannot be resolved" },
		]);
		const aborted = AbortSignal.abort();
		await expect(
			workspace.verifyPrerequisites(repo, baseCommit, prerequisites, aborted),
		).rejects.toThrow();
	});

	it("refuses dirty reused worktrees without deleting their edits", async () => {
		const { workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		await writeFile(join(prepared.path, "partial.txt"), "keep\n");
		await expect(workspace.prepare(input, signal())).rejects.toThrow(/dirty/);
		await expect(
			readFile(join(prepared.path, "partial.txt"), "utf8"),
		).resolves.toBe("keep\n");
	});

	it("rejects branch and path collisions, invalid refs, and path escapes", async () => {
		const { repo, workspace, input } = await fixture();
		await git(repo, ["branch", input.branch, input.baseCommit]);
		await expect(workspace.prepare(input, signal())).rejects.toThrow(
			/branch.*exists|collision/i,
		);
		await git(repo, ["branch", "-D", input.branch]);
		await mkdir(join(input.worktreeRoot, executionId), { recursive: true });
		await expect(workspace.prepare(input, signal())).rejects.toThrow(
			/existing path|registered worktree/i,
		);
		await rm(join(input.worktreeRoot, executionId), {
			recursive: true,
			force: true,
		});
		await expect(
			workspace.prepare({ ...input, baseCommit: "--help" }, signal()),
		).rejects.toThrow(/base commit|invalid/i);
		await expect(
			workspace.prepare(
				{ ...input, worktreeRoot: join(input.worktreeRoot, "..", "outside") },
				signal(),
			),
		).rejects.toThrow(/worktree root|outside/i);
	});

	it("captures tracked and untracked content in diffs and changes the fingerprint", async () => {
		const { workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		const before = await workspace.inspect(prepared.path, signal());
		await writeFile(join(prepared.path, "tracked.txt"), "modified\n");
		await writeFile(join(prepared.path, "new file.txt"), "untracked content\n");
		const after = await workspace.inspect(prepared.path, signal());
		const diff = await workspace.diff(
			prepared.path,
			input.baseCommit,
			signal(),
		);
		expect(after.fingerprint).not.toBe(before.fingerprint);
		expect(after.changedPaths.sort()).toEqual(["new file.txt", "tracked.txt"]);
		expect(diff).toContain("modified");
		expect(diff).toContain("untracked content");
	});

	it("caps diff subprocess output before assembling an oversized diff", async () => {
		const { workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		await writeFile(
			join(prepared.path, "large.bin"),
			Buffer.alloc(5 * 1024 * 1024, 1),
		);

		await expect(
			workspace.diff(
				prepared.path,
				input.baseCommit,
				signal(),
				4 * 1024 * 1024,
			),
		).rejects.toBeInstanceOf(ExecutionDiffTooLargeError);
	});

	it("captures tracked repository instructions and local ref/reflog changes", async () => {
		const { repo, workspace, input } = await fixture();
		await mkdir(join(repo, "nested"), { recursive: true });
		await writeFile(join(repo, "AGENTS.md"), "root instructions\n");
		await writeFile(join(repo, "nested", "CLAUDE.md"), "nested instructions\n");
		await git(repo, ["add", "."]);
		await git(repo, ["commit", "-m", "repository instructions"]);
		const pinned = (await git(repo, ["rev-parse", "HEAD"])).trim();
		const instructions = await workspace.instructions(repo, pinned, signal());
		expect(instructions).toEqual({
			"AGENTS.md": "root instructions\n",
			"nested/CLAUDE.md": "nested instructions\n",
		});
		const prepared = await workspace.prepare(
			{ ...input, baseCommit: pinned },
			signal(),
		);
		const before = await workspace.inspect(prepared.path, signal());
		await git(repo, ["branch", "unrelated-local-branch"]);
		const after = await workspace.inspect(prepared.path, signal());
		expect(after.historyFingerprint).not.toBe(before.historyFingerprint);
	});

	it("escalates when repository instruction limits would omit required files", async () => {
		const { repo, workspace } = await fixture();
		for (let index = 0; index < 33; index++) {
			const directory = join(repo, `nested-${index}`);
			await mkdir(directory);
			await writeFile(join(directory, "AGENTS.md"), "instruction\n");
		}
		await git(repo, ["add", "."]);
		await git(repo, ["commit", "-m", "too many instructions"]);
		const pinned = (await git(repo, ["rev-parse", "HEAD"])).trim();
		await expect(
			workspace.instructions(repo, pinned, signal()),
		).rejects.toThrow(/32/);
	});

	it("rejects a stale snapshot before commit and commits the expected tree", async () => {
		const { workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		const initial = await workspace.inspect(prepared.path, signal());
		await writeFile(join(prepared.path, "change.txt"), "first\n");
		const expected = await workspace.inspect(prepared.path, signal());
		await writeFile(join(prepared.path, "change.txt"), "second\n");
		const trailer = `Payo-Execution: ${executionId}/phase-1`;
		await expect(
			workspace.commit(
				prepared.path,
				expected.fingerprint,
				`phase\n\n${trailer}`,
				signal(),
				{ parent: input.baseCommit, tree: "wrong-tree", trailer },
			),
		).rejects.toThrow(/snapshot/i);
		const current = await workspace.inspect(prepared.path, signal());
		const plan = await workspace.prepareCommit(
			prepared.path,
			current.fingerprint,
			signal(),
		);
		expect(plan).toMatchObject({ parent: input.baseCommit, changed: true });
		const message = `phase\n\n${trailer}`;
		await expect(
			workspace.commit(
				prepared.path,
				plan.expectedSnapshot,
				message,
				signal(),
				{ parent: plan.parent, tree: "wrong-tree", trailer },
			),
		).rejects.toThrow(/tree/i);
		const commit = await workspace.commit(
			prepared.path,
			plan.expectedSnapshot,
			message,
			signal(),
			{ parent: plan.parent, tree: plan.tree, trailer },
		);
		expect(commit).not.toBe(input.baseCommit);
		expect(
			await workspace.inspectCommit(prepared.path, signal()),
		).toMatchObject({
			head: commit,
			parent: input.baseCommit,
			tree: plan.tree,
			message,
		});
		expect((await git(prepared.path, ["status", "--porcelain"])).trim()).toBe(
			"",
		);
		await expect(
			workspace.commit(
				prepared.path,
				initial.fingerprint,
				`stale\n\n${trailer}`,
				signal(),
				{ parent: plan.parent, tree: plan.tree, trailer },
			),
		).rejects.toThrow(/snapshot/i);
	});

	it("creates an auditable empty commit when the durable phase intent has no tree changes", async () => {
		const { workspace, input } = await fixture();
		const prepared = await workspace.prepare(input, signal());
		const snapshot = await workspace.inspect(prepared.path, signal());
		const plan = await workspace.prepareCommit(
			prepared.path,
			snapshot.fingerprint,
			signal(),
		);
		expect(plan.changed).toBe(false);
		const trailer = `Payo-Execution: ${executionId}/phase-1`;
		const commit = await workspace.commit(
			prepared.path,
			plan.expectedSnapshot,
			`phase\n\n${trailer}`,
			signal(),
			{ parent: plan.parent, tree: plan.tree, trailer },
		);
		expect(commit).not.toBe(input.baseCommit);
		expect(
			await workspace.inspectCommit(prepared.path, signal()),
		).toMatchObject({
			parent: input.baseCommit,
			tree: plan.tree,
		});
	});

	it("honours abort before starting Git operations", async () => {
		const { workspace, input } = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(workspace.prepare(input, controller.signal)).rejects.toThrow(
			/abort/i,
		);
	});
});
