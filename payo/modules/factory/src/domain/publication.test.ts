import { PhaseReceipt, PublicationFinalResult } from "@payo/contracts";
import { expect, it } from "vitest";
import { initialExecutionCheckpoint } from "./execution.ts";
import { validatePublicationPolicy } from "./naming.ts";
import {
	assertPublicationBase,
	assertPublicationCheckpoint,
	assertPublicationManifest,
	assertPublicationReceipts,
	assertPublicationResult,
	assertPublicationResumable,
	assertPublicationWorkspace,
	publicationContent,
	publicationEligibility,
	publicationResumeCommand,
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

it("requires final evidence to match the checkpoint and reviewed head", () => {
	const ref = {
		sha256: "a".repeat(64),
		size: 1,
		kind: "evidence",
		mediaType: "application/json",
	};
	const checkpoint = {
		...initialExecutionCheckpoint(),
		receipts: [ref],
		evidence: { checks: ref, review: ref, diff: ref },
	};
	const result = PublicationFinalResult.parse({
		resultCommit: "head",
		summary: "Done",
		report: ref,
		checks: ref,
		review: ref,
		phaseReceipts: [ref],
	});
	expect(() =>
		assertPublicationResult(result, "head", checkpoint),
	).not.toThrow();
	for (const patch of [
		{ resultCommit: "other" },
		{ phaseReceipts: [] },
		{ checks: { ...ref, sha256: "b".repeat(64) } },
		{ review: { ...ref, sha256: "b".repeat(64) } },
	])
		expect(() =>
			assertPublicationResult({ ...result, ...patch }, "head", checkpoint),
		).toThrow("Final evidence differs");
});

it("requires matching manifest counts and an ordered receipt chain for the approved plan", () => {
	const ref = {
		sha256: "a".repeat(64),
		size: 1,
		kind: "evidence",
		mediaType: "application/json",
	};
	const manifest = {
		pr: { id: "pr" },
		phases: [{ id: "phase-1" }, { id: "phase-2" }],
	};
	expect(() =>
		assertPublicationManifest(
			manifest,
			{ prId: "pr" },
			{ receipts: [ref, ref] },
		),
	).not.toThrow();
	expect(() =>
		assertPublicationManifest(
			manifest,
			{ prId: "other" },
			{ receipts: [ref, ref] },
		),
	).toThrow("incomplete");
	expect(() =>
		assertPublicationManifest(manifest, { prId: "pr" }, { receipts: [ref] }),
	).toThrow("incomplete");
	const first = PhaseReceipt.parse({
		phaseId: "phase-1",
		phaseIndex: 0,
		planHash: ref.sha256,
		startCommit: "base",
		resultCommit: "one",
		report: ref,
		checks: ref,
		review: ref,
		summary: "Done",
		acceptedCriteria: [],
		deviations: [],
	});
	const second = {
		...first,
		phaseId: "phase-2",
		phaseIndex: 1,
		startCommit: "one",
		resultCommit: "two",
	};
	const config = { baseCommit: "base", plan: ref };
	expect(() =>
		assertPublicationReceipts([first, second], manifest, config),
	).not.toThrow();
	for (const patch of [
		{ phaseIndex: 0 },
		{ phaseId: "other" },
		{ planHash: "b".repeat(64) },
		{ startCommit: "base" },
	])
		expect(() =>
			assertPublicationReceipts(
				[first, { ...second, ...patch }],
				manifest,
				config,
			),
		).toThrow("Phase receipt identity");
});

const target = {
	host: "github.com" as const,
	owner: "org",
	name: "repo",
	repositoryId: "id",
	baseBranch: "main",
	baseCommit: "base",
};
it("uses the same pinned-base policy for preview and publication rechecks", () => {
	expect(() => assertPublicationBase(target, "base")).not.toThrow();
	expect(() =>
		assertPublicationBase(target, "base", { ...target, owner: "ORG" }),
	).not.toThrow();
	expect(() =>
		assertPublicationBase({ ...target, baseCommit: "moved" }, "base"),
	).toThrow(/base moved/);
	expect(() =>
		assertPublicationBase(target, "base", { ...target, repositoryId: "other" }),
	).toThrow(/base moved/);
});
it("requires a completed checkpoint and the exact clean reviewed workspace", () => {
	const workspace = {
		path: "/repo",
		branch: "branch",
		baseCommit: "base",
		head: "head",
		fingerprint: "fingerprint",
		historyFingerprint: "history",
	};
	const ref = {
		sha256: "a".repeat(64),
		size: 1,
		kind: "manifest",
		mediaType: "application/json",
	};
	const checkpoint = {
		...initialExecutionCheckpoint(),
		stage: "Completed" as const,
		workspace,
		manifest: ref,
	};
	expect(assertPublicationCheckpoint(checkpoint)).toEqual({
		workspace,
		manifest: ref,
	});
	for (const patch of [
		{ stage: "Review" as const },
		{ manifest: null },
		{ workspace: null },
	])
		expect(() =>
			assertPublicationCheckpoint({ ...checkpoint, ...patch }),
		).toThrow(/incomplete/);
	const snapshot = {
		branch: "branch",
		head: "head",
		changedPaths: [],
		fingerprint: "fingerprint",
	};
	expect(() =>
		assertPublicationWorkspace(snapshot, workspace, "branch"),
	).not.toThrow();
	for (const patch of [
		{ branch: "other" },
		{ head: "other" },
		{ changedPaths: ["file"] },
		{ fingerprint: "other" },
	])
		expect(() =>
			assertPublicationWorkspace(
				{ ...snapshot, ...patch },
				workspace,
				"branch",
			),
		).toThrow(/cleanliness changed/);
	expect(() =>
		assertPublicationWorkspace(snapshot, workspace, "other"),
	).toThrow(/cleanliness changed/);
});
it("owns publication content defaults, title validation and the durable marker", () => {
	const preview = { title: "[A2_B-003] Change", body: "Description" };
	const request = { previewHash: "a".repeat(64) };
	expect(publicationContent(preview, request, naming, "child")).toEqual({
		title: preview.title,
		body: "Description\n\n<!-- payo-publication:child -->",
	});
	expect(
		publicationContent(
			preview,
			{ ...request, title: "[A2_B-003] Custom", body: "Custom" },
			naming,
			"child",
		).title,
	).toBe("[A2_B-003] Custom");
	expect(() => publicationContent({}, request, naming, "child")).toThrow(
		/incomplete/,
	);
	expect(() =>
		publicationContent(
			preview,
			{ ...request, title: "wrong ticket" },
			naming,
			"child",
		),
	).toThrow(/ticket prefix/);
	expect(() =>
		publicationContent(
			preview,
			{ ...request, body: "<!-- payo-publication:foreign -->" },
			naming,
			"child",
		),
	).toThrow(/owned by the factory/);
});

it("owns publication resume eligibility and gate command selection", () => {
	expect(
		assertPublicationResumable("active", {
			stage: "Escalated",
			pausedOperation: "Push",
		}),
	).toBe("Push");
	expect(() =>
		assertPublicationResumable("ended", {
			stage: "Escalated",
			pausedOperation: "Push",
		}),
	).toThrow("not resumable");
	expect(() =>
		assertPublicationResumable("active", {
			stage: "Push",
			pausedOperation: null,
		}),
	).toThrow("not resumable");
	expect(publicationResumeCommand(["retry", "resume"])).toBe("resume");
	expect(publicationResumeCommand(["retry"])).toBe("retry");
	expect(() => publicationResumeCommand(["abandon"])).toThrow(
		"cannot be resumed",
	);
});
