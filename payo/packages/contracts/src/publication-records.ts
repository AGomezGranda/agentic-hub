import { z } from "zod";

const nonBlank = z
	.string()
	.refine((value) => value.trim().length > 0, "must not be blank");
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const owner = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
const name = z
	.string()
	.regex(/^[A-Za-z0-9_.-]+$/)
	.refine((value) => value !== "." && value !== "..");
export const GitHubTarget = z.strictObject({
	host: z.literal("github.com"),
	owner,
	name,
	repositoryId: nonBlank,
	baseBranch: nonBlank,
	baseCommit: sha,
});
export type GitHubTarget = z.infer<typeof GitHubTarget>;

export const PullRequestRecord = z.strictObject({
	number: z.int().positive(),
	url: z.url(),
	owner,
	name,
	baseBranch: nonBlank,
	headBranch: nonBlank,
	headCommit: sha,
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	draft: z.boolean(),
	title: nonBlank,
	body: z.string(),
});
export type PullRequestRecord = z.infer<typeof PullRequestRecord>;

export const PublicationCommit = z.strictObject({
	sha,
	subject: nonBlank,
	message: nonBlank,
});
export type PublicationCommit = z.infer<typeof PublicationCommit>;
