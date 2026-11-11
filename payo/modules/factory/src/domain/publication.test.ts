import { expect, it } from "vitest";
import { validatePublicationPolicy } from "./naming.ts";
import {
	publicationEligibility,
	reconcilePullRequests,
	reconcileRemote,
	validatePublicationCommits,
} from "./publication.ts";

const naming = {
	version: 1 as const,
	ticketId: "A2_B-003",
	slug: "create-todo-entity",
	branch: "A2_B-003/create-todo-entity",
	policy: validatePublicationPolicy({}),
};
it("refuses legacy, unfinished and empty results without rewriting history", () => {
	expect(publicationEligibility("ended", "reviewed", undefined)).toMatch(
		/Legacy/,
	);
	expect(publicationEligibility("active", null, naming)).toMatch(/reviewed/);
	expect(() => validatePublicationCommits([], naming, "execution")).toThrow(
		/empty/,
	);
	expect(() =>
		validatePublicationCommits(
			[
				{
					sha: "s",
					subject: "[ABC-3] Thing",
					message: "[ABC-3] Thing\n\nPayo-Execution: execution/phase",
				},
			],
			naming,
			"execution",
		),
	).toThrow(/ticket/);
	expect(() =>
		validatePublicationCommits(
			[
				{
					sha: "s",
					subject: "[A2_B-003] Thing",
					message: "[A2_B-003] Thing\n\nPayo-Execution: foreign/phase",
				},
			],
			naming,
			"execution",
		),
	).toThrow(/ownership/);
});
it("never adopts a pre-existing equal remote without durable intent", () => {
	expect(() => reconcileRemote("sha", "sha", false)).toThrow(/pre-existing/);
	expect(reconcileRemote(null, "sha", true)).toBe("push");
	expect(reconcileRemote("sha", "sha", true)).toBe("confirmed");
	expect(() => reconcileRemote("other", "sha", true)).toThrow(/different/);
});
it("accepts only a single exact owned open draft and gates every mismatch", () => {
	const target = {
		host: "github.com" as const,
		owner: "org",
		name: "repo",
		repositoryId: "id",
		baseBranch: "main",
		baseCommit: "base",
	};
	const expected = {
		target,
		branch: "branch",
		reviewedCommit: "sha",
		title: "title",
		body: "body\n<!-- payo-publication:child -->",
	};
	const pr = {
		number: 1,
		url: "https://github.com/org/repo/pull/1",
		owner: "org",
		name: "repo",
		baseBranch: "main",
		headBranch: "branch",
		headCommit: "sha",
		state: "OPEN" as const,
		draft: true,
		title: expected.title,
		body: expected.body,
	};
	expect(reconcilePullRequests([], expected)).toBeNull();
	expect(reconcilePullRequests([pr], expected)).toEqual(pr);
	for (const patch of [
		{ draft: false },
		{ state: "CLOSED" },
		{ state: "MERGED" },
		{ body: "unrelated" },
		{ title: "changed" },
		{ headCommit: "other" },
		{ owner: "other" },
		{ baseBranch: "other" },
	])
		expect(() =>
			reconcilePullRequests([{ ...pr, ...patch } as typeof pr], expected),
		).toThrow(/conflict/);
	expect(() => reconcilePullRequests([pr, pr], expected)).toThrow(/multiple/);
});
