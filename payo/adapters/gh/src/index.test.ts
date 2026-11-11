import { readFile } from "node:fs/promises";
import type { GitHubTarget } from "@payo/contracts";
import { expect, it, vi } from "vitest";
import type { GhExec } from "./exec.ts";
import { createGitHubCodeHost, parseGitHubRemote } from "./index.ts";

const signal = new AbortController().signal;
const target: GitHubTarget = {
	host: "github.com",
	owner: "Owner",
	name: "repo",
	repositoryId: "123",
	baseBranch: "main",
	baseCommit: "a".repeat(40),
};
const fixture = async (name: string) =>
	readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
function executor(outputs: string[]) {
	return vi.fn<GhExec>(async () => ({
		stdout: outputs.shift() ?? "",
		stderr: "",
		exitCode: 0,
	}));
}
it("accepts supported GitHub identities and rejects credentials and other targets", () => {
	for (const remote of [
		"git@github.com:Owner/repo.git",
		"https://github.com/Owner/repo.git",
		"ssh://git@github.com/Owner/repo",
	])
		expect(parseGitHubRemote(remote)).toEqual({ owner: "Owner", name: "repo" });
	for (const remote of [
		"https://token@github.com/Owner/repo",
		"https://github.example/Owner/repo",
		"ssh://root@github.com/Owner/repo",
		"https://github.com/Owner/repo?token=secret",
		"ext::evil",
		"https://github.com/Owner/repo/extra",
	])
		expect(() => parseGitHubRemote(remote)).toThrow();
});
it("resolves repository and exact named base lazily with read-only queries", async () => {
	const exec = executor([await fixture("repository"), await fixture("branch")]);
	const port = createGitHubCodeHost({ exec });
	expect(exec).not.toHaveBeenCalled();
	expect(
		await port.resolveRepository(
			"git@github.com:Owner/repo.git",
			"main",
			signal,
		),
	).toEqual(target);
	expect(exec.mock.calls.map(([args]) => args)).toEqual([
		["api", "--hostname", "github.com", "repos/Owner/repo"],
		["api", "--hostname", "github.com", "repos/Owner/repo/branches/main"],
	]);
});
it("queries every PR state and preserves identity, head, draft and content", async () => {
	const raw = JSON.parse(await fixture("pull-requests"));
	for (const [state, merged_at, expected] of [
		["open", null, "OPEN"],
		["closed", null, "CLOSED"],
		["closed", "2026-11-11T00:00:00Z", "MERGED"],
	]) {
		raw[0][0].state = state;
		raw[0][0].merged_at = merged_at;
		const exec = executor([JSON.stringify(raw)]);
		const records = await createGitHubCodeHost({ exec }).findPullRequests(
			target,
			"ABC-1/create-reviewed-result",
			signal,
		);
		expect(records[0]).toMatchObject({
			owner: "Owner",
			name: "repo",
			state: expected,
			draft: true,
			headCommit: "b".repeat(40),
			body: "Summary\n\n<!-- payo-publication:child -->",
		});
		expect(exec.mock.calls[0]?.[0]).toContain("state=all");
		expect(exec.mock.calls[0]?.[0]).toContain("--paginate");
	}
});
it("creates only an explicitly targeted draft with multiline content through stdin", async () => {
	const exec = executor(["https://github.com/Owner/repo/pull/1\n"]);
	await createGitHubCodeHost({ exec }).createDraftPullRequest(
		target,
		{
			headBranch: "ABC-1/create-reviewed-result",
			title: "[ABC-1] Create result",
			body: "one\ntwo",
		},
		signal,
	);
	expect(exec).toHaveBeenCalledWith(
		[
			"pr",
			"create",
			"--repo",
			"github.com/Owner/repo",
			"--base",
			"main",
			"--head",
			"ABC-1/create-reviewed-result",
			"--title",
			"[ABC-1] Create result",
			"--body-file",
			"-",
			"--draft",
		],
		expect.objectContaining({
			input: "one\ntwo",
			signal,
			timeoutMs: 30_000,
			maxBuffer: 4 * 1024 * 1024,
		}),
	);
});
it("preserves query/authentication/effect uncertainty and cancellation", async () => {
	for (const stdout of ["not-json", "{}", "[[]", "[[{}]]", '[{"number":1}]']) {
		await expect(
			createGitHubCodeHost({ exec: executor([stdout]) }).findPullRequests(
				target,
				"feature",
				signal,
			),
		).rejects.toThrow();
	}
	const failure: GhExec = async () => ({
		stdout: "",
		stderr: "authentication required",
		exitCode: 4,
	});
	await expect(
		createGitHubCodeHost({ exec: failure }).findPullRequests(
			target,
			"feature",
			signal,
		),
	).rejects.toThrow();
	const lost: GhExec = async () => {
		throw new Error("response lost");
	};
	await expect(
		createGitHubCodeHost({ exec: lost }).createDraftPullRequest(
			target,
			{ headBranch: "feature", title: "title", body: "body" },
			signal,
		),
	).rejects.toThrow("response lost");
	const exec = executor([]);
	await expect(
		createGitHubCodeHost({ exec }).findPullRequests(
			target,
			"feature",
			AbortSignal.abort(),
		),
	).rejects.toThrow();
	expect(exec).not.toHaveBeenCalled();
});

it("rejects partial repository/base facts and retains content whitespace for exact reconciliation", async () => {
	for (const outputs of [
		["{}"],
		[await fixture("repository"), "{}"],
		[
			await fixture("repository"),
			JSON.stringify({ name: "other", commit: { sha: "a".repeat(40) } }),
		],
	])
		await expect(
			createGitHubCodeHost({ exec: executor(outputs) }).resolveRepository(
				"https://github.com/Owner/repo",
				"main",
				signal,
			),
		).rejects.toThrow();
	const raw = JSON.parse(await fixture("pull-requests"));
	raw[0][0].title = " [ABC-1] Create result ";
	raw[0][0].body += "\n";
	const records = await createGitHubCodeHost({
		exec: executor([JSON.stringify(raw)]),
	}).findPullRequests(target, "ABC-1/create-reviewed-result", signal);
	expect(records[0]?.title).toBe(" [ABC-1] Create result ");
	expect(records[0]?.body.endsWith("\n")).toBe(true);
});
