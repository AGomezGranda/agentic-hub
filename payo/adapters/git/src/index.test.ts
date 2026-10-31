import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkGit,
	createGitExec,
	createGitWorkspace,
	resolveBaseCommit,
} from "./index.ts";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			if (error === null) {
				resolve(stdout);
				return;
			}
			reject(new Error(stderr.trim() || error.message));
		});
	});
}

async function makeRepo(): Promise<{ repo: string; commit: string }> {
	const repo = await tempDir("payo-git-repo-");
	await git(repo, ["init", "-b", "main"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "Test"]);
	await writeFile(join(repo, "file.txt"), "hello");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-m", "init"]);
	const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
	return { repo, commit };
}

async function makeWorkspace(): Promise<{
	root: string;
	workspace: ReturnType<typeof createGitWorkspace>;
}> {
	const root = join(await tempDir("payo-worktrees-"), "worktrees");
	return { root, workspace: createGitWorkspace({ root }) };
}

async function worktreePaths(repo: string): Promise<string[]> {
	const raw = await git(repo, ["worktree", "list", "--porcelain"]);
	return raw
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

describe("createGitWorkspace.create", () => {
	it("creates a detached worktree at the base commit", async () => {
		const { repo, commit } = await makeRepo();
		const { root, workspace } = await makeWorkspace();

		const path = await workspace.create("run-1", repo, "main");

		expect(path).toBe(join(root, "run-1"));
		expect((await git(path, ["rev-parse", "HEAD"])).trim()).toBe(commit);
	});

	it("reuses a registered worktree for the same run", async () => {
		const { repo } = await makeRepo();
		const { workspace } = await makeWorkspace();

		const first = await workspace.create("run-1", repo, "main");
		await writeFile(join(first, "marker.txt"), "keep me");
		const second = await workspace.create("run-1", repo, "main");

		expect(second).toBe(first);
		expect(await readFile(join(second, "marker.txt"), "utf8")).toBe("keep me");
	});

	it("rejects an existing unregistered directory and leaves it alone", async () => {
		const { repo } = await makeRepo();
		const { root, workspace } = await makeWorkspace();
		const path = join(root, "run-1");
		await mkdir(path, { recursive: true });

		await expect(workspace.create("run-1", repo, "main")).rejects.toThrow(
			/not a registered worktree/,
		);
		expect((await stat(path)).isDirectory()).toBe(true);
	});

	it("rejects invalid run ids", async () => {
		const { repo } = await makeRepo();
		const { workspace } = await makeWorkspace();

		for (const runId of ["", ".", "..", "../escape", "a/b"]) {
			await expect(workspace.create(runId, repo, "main")).rejects.toThrow(
				/invalid run id|outside the worktree root/,
			);
		}
	});

	it("rejects a non-git repo and a missing base", async () => {
		const plain = await tempDir("payo-not-a-repo-");
		const { repo } = await makeRepo();
		const { workspace } = await makeWorkspace();

		await expect(workspace.create("run-1", plain, "main")).rejects.toThrow(
			/not a git repository/,
		);
		await expect(workspace.create("run-2", repo, "nope")).rejects.toThrow(
			/base nope not found/,
		);
	});
});

describe("createGitWorkspace.remove", () => {
	it("removes a worktree and its registration", async () => {
		const { repo } = await makeRepo();
		const { workspace } = await makeWorkspace();
		const path = await workspace.create("run-1", repo, "main");

		await workspace.remove(path);

		expect(await worktreePaths(repo)).toHaveLength(1);
		await expect(stat(path)).rejects.toThrow();
	});

	it("is idempotent for a missing directory", async () => {
		const { repo } = await makeRepo();
		const { root, workspace } = await makeWorkspace();
		const path = await workspace.create("run-1", repo, "main");
		await rm(path, { recursive: true, force: true });

		await expect(workspace.remove(path)).resolves.toBeUndefined();
		await expect(workspace.remove(path)).resolves.toBeUndefined();

		const paths = await worktreePaths(repo);
		expect(paths).toHaveLength(1);
		expect(paths).not.toContain(join(root, "run-1"));
	});

	it("rejects a path outside the root", async () => {
		const { workspace } = await makeWorkspace();
		const outside = await tempDir("payo-outside-");

		await expect(workspace.remove(join(outside, "run-1"))).rejects.toThrow(
			/outside the worktree root/,
		);
	});

	it("rejects a plain directory without touching it", async () => {
		const { root, workspace } = await makeWorkspace();
		const path = join(root, "run-1");
		await mkdir(path, { recursive: true });

		await expect(workspace.remove(path)).rejects.toThrow(
			/not a registered worktree/,
		);
		expect((await stat(path)).isDirectory()).toBe(true);
	});

	it("prunes a stale registration after the directory was deleted", async () => {
		const { repo } = await makeRepo();
		const { root, workspace } = await makeWorkspace();
		const path = await workspace.create("run-1", repo, "main");

		await rm(path, { recursive: true, force: true });
		await workspace.remove(path);
		const recreated = await workspace.create("run-1", repo, "main");

		expect(recreated).toBe(join(root, "run-1"));
		const paths = (await worktreePaths(repo)).map((entry) => resolve(entry));
		expect(paths).toContain(await realpath(recreated));
	});

	it("falls back to the meta repo when rev-parse in the worktree is broken", async () => {
		const { repo } = await makeRepo();
		const { workspace } = await makeWorkspace();
		const path = await workspace.create("run-1", repo, "main");
		await writeFile(join(path, ".git"), "broken");

		await workspace.remove(path);

		expect(await worktreePaths(repo)).toHaveLength(1);
		await expect(stat(path)).rejects.toThrow();
	});

	it("prunes via the persisted repo when the meta file exists", async () => {
		const { repo } = await makeRepo();
		const { root, workspace } = await makeWorkspace();
		const path = await workspace.create("run-1", repo, "main");
		const meta = JSON.parse(
			await readFile(join(root, ".meta", "run-1.json"), "utf8"),
		);

		expect(meta).toEqual({ repo });
		await rm(path, { recursive: true, force: true });
		await workspace.remove(path);

		expect(await worktreePaths(repo)).toHaveLength(1);
	});
});

describe("resolveBaseCommit", () => {
	it("resolves a local branch and rejects a missing base", async () => {
		const { repo, commit } = await makeRepo();
		const exec = createGitExec();

		await expect(resolveBaseCommit(repo, "main", exec)).resolves.toBe(commit);
		await expect(resolveBaseCommit(repo, "nope", exec)).rejects.toThrow(
			/base nope not found/,
		);
	});
});

describe("checkGit", () => {
	it("reports the resolved commit", async () => {
		const { repo, commit } = await makeRepo();

		const check = await checkGit({ repo, base: "main" });

		expect(check.ok).toBe(true);
		expect(check.detail).toContain(commit);
	});

	it("fails for a bad base", async () => {
		const { repo } = await makeRepo();

		const check = await checkGit({ repo, base: "nope" });

		expect(check.ok).toBe(false);
		expect(check.detail).toContain("base nope not found");
	});

	it("fails for a missing binary", async () => {
		const { repo } = await makeRepo();

		const check = await checkGit({
			repo,
			base: "main",
			exec: createGitExec({ bin: "/nonexistent-payo-git" }),
		});

		expect(check.ok).toBe(false);
	});
});
