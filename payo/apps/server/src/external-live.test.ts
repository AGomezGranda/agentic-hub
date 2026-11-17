import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitHubCodeHost } from "@payo/gh";
import { createAcliTicketSource } from "@payo/jira-acli";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe.runIf(process.env.PAYO_EXTERNAL_LIVE === "1")(
	"read-only external contracts",
	() => {
		it("resolves a GitHub repository/base and parses an existing PR", async () => {
			const remote = process.env.PAYO_SMOKE_GITHUB_REMOTE;
			const head = process.env.PAYO_SMOKE_GITHUB_HEAD;
			if (!remote || !head)
				throw new Error(
					"Set PAYO_SMOKE_GITHUB_REMOTE and PAYO_SMOKE_GITHUB_HEAD to an existing PR's repository and head branch",
				);
			const version = await exec("gh", ["--version"], { timeout: 5000 });
			console.info(version.stdout.trim());
			const codeHost = createGitHubCodeHost({ env: { ...process.env } });
			const base = process.env.PAYO_SMOKE_GITHUB_BASE ?? "main";
			const signal = AbortSignal.timeout(30000);
			const target = await codeHost.resolveRepository(remote, base, signal);
			expect(target.baseBranch).toBe(base);
			const prs = await codeHost.findPullRequests(target, head, signal);
			expect(prs.length).toBeGreaterThan(0);
			for (const pr of prs) {
				expect(pr.headBranch).toBe(head);
				expect(pr.baseBranch).toBe(base);
			}
		}, 40000);

		it("resolves a Jira ticket through the installed acli", async () => {
			const key = process.env.PAYO_SMOKE_JIRA_KEY;
			if (!key)
				throw new Error("Set PAYO_SMOKE_JIRA_KEY to an existing ticket");
			const version = await exec("acli", ["--version"], { timeout: 5000 });
			console.info(version.stdout.trim());
			const ticket = await createAcliTicketSource({}).resolve({
				source: "jira",
				key,
			});
			expect(ticket.origin).toMatchObject({ source: "jira", key });
			expect(ticket.title.trim()).not.toBe("");
		}, 40000);
	},
);
