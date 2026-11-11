import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitExec } from "./exec.ts";
import { createRepositoryPublication } from "./publication.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "payo-publication-"));
	roots.push(root);
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const exec = createGitExec();
	const git = async (...args: string[]) => {
		const result = await exec(args, {});
		if (result.exitCode !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	await git("init", "-b", "main", repo);
	await git("init", "--bare", remote);
	await git("-C", repo, "config", "user.name", "Payo Test");
	await git("-C", repo, "config", "user.email", "payo@example.test");
	await git("-C", repo, "commit", "--allow-empty", "-m", "base");
	const base = await git("-C", repo, "rev-parse", "HEAD");
	await writeFile(join(repo, "result.txt"), "reviewed\n");
	await git("-C", repo, "add", "result.txt");
	await git(
		"-C",
		repo,
		"commit",
		"-m",
		"[ABC-1] Create reviewed result\n\nPayo-Execution: execution/phase",
	);
	const reviewed = await git("-C", repo, "rev-parse", "HEAD");
	await git("-C", repo, "remote", "add", "origin", remote);
	return {
		repo,
		remote,
		git,
		base,
		reviewed,
		port: createRepositoryPublication(),
		signal: new AbortController().signal,
	};
}

it("pushes exactly the supplied SHA without tags or current HEAD", async () => {
	const f = await fixture();
	await f.git("-C", f.repo, "tag", "-a", "do-not-push", "-m", "tag");
	await f.git("-C", f.repo, "config", "push.followTags", "true");
	await f.git(
		"-C",
		f.repo,
		"commit",
		"--allow-empty",
		"-m",
		"later unreviewed change",
	);
	expect(await f.port.resolveRemote(f.repo, "origin", f.signal)).toEqual({
		fetchUrl: f.remote,
		pushUrl: f.remote,
	});
	expect(
		await f.port.readRemoteHead(
			f.remote,
			"ABC-1/create-reviewed-result",
			f.signal,
		),
	).toBeNull();
	await f.port.pushCommit(
		f.repo,
		f.remote,
		"ABC-1/create-reviewed-result",
		f.reviewed,
		f.signal,
	);
	expect(
		await f.port.readRemoteHead(
			f.remote,
			"ABC-1/create-reviewed-result",
			f.signal,
		),
	).toBe(f.reviewed);
	expect(await f.git("--git-dir", f.remote, "tag", "--list")).toBe("");
	expect(
		await f.port.readCommits(f.repo, f.base, f.reviewed, f.signal),
	).toEqual([
		{
			sha: f.reviewed,
			subject: "[ABC-1] Create reviewed result",
			message:
				"[ABC-1] Create reviewed result\n\nPayo-Execution: execution/phase",
		},
	]);
});

it("atomically refuses any existing remote ref including an ancestor or equal SHA", async () => {
	const f = await fixture();
	await f.git(
		"-C",
		f.repo,
		"push",
		f.remote,
		`${f.base}:refs/heads/ABC-1/create-reviewed-result`,
	);
	await expect(
		f.port.pushCommit(
			f.repo,
			f.remote,
			"ABC-1/create-reviewed-result",
			f.reviewed,
			f.signal,
		),
	).rejects.toThrow();
	expect(
		await f.port.readRemoteHead(
			f.remote,
			"ABC-1/create-reviewed-result",
			f.signal,
		),
	).toBe(f.base);
	await expect(
		f.port.pushCommit(
			f.repo,
			f.remote,
			"ABC-1/create-reviewed-result",
			f.base,
			f.signal,
		),
	).rejects.toThrow();
});

it("distinguishes remote transport failure from an absent branch", async () => {
	const f = await fixture();
	await expect(
		f.port.readRemoteHead(join(f.remote, "missing"), "feature", f.signal),
	).rejects.toThrow();
});

it("refuses a ref created between its query and push, even when Git reports an equal ref as up to date", async () => {
	for (const equal of [false, true]) {
		const f = await fixture();
		const exec = createGitExec();
		const port = createRepositoryPublication({
			exec: async (args, options) => {
				if (args.includes("push"))
					await f.git(
						"-C",
						f.repo,
						"push",
						f.remote,
						`${equal ? f.reviewed : f.base}:refs/heads/racing`,
					);
				return exec(args, options);
			},
		});
		await expect(
			port.pushCommit(f.repo, f.remote, "racing", f.reviewed, f.signal),
		).rejects.toThrow();
		expect(await f.port.readRemoteHead(f.remote, "racing", f.signal)).toBe(
			equal ? f.reviewed : f.base,
		);
	}
});

it("rejects multiple push destinations, unsafe URLs and invalid refs", async () => {
	const f = await fixture();
	await f.git(
		"-C",
		f.repo,
		"config",
		"--add",
		"remote.origin.pushurl",
		f.remote,
	);
	await f.git(
		"-C",
		f.repo,
		"config",
		"--add",
		"remote.origin.pushurl",
		`${f.remote}-second`,
	);
	await expect(
		f.port.resolveRemote(f.repo, "origin", f.signal),
	).rejects.toThrow(/multiple/);
	for (const url of [
		"ext::evil",
		"https://token@github.com/owner/repo",
		"ssh://root@evil.test/repo",
		"--upload-pack=evil",
	])
		await expect(
			f.port.readRemoteHead(url, "feature", f.signal),
		).rejects.toThrow(/remote/);
	await expect(
		f.port.pushCommit(f.repo, f.remote, "bad..ref", f.reviewed, f.signal),
	).rejects.toThrow();
});
