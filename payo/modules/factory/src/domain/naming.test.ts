import { describe, expect, it } from "vitest";
import {
	detectTicketIds,
	renderBranch,
	renderCommitSubject,
	renderPrBody,
	renderPrTitle,
	resolveTicketSelection,
	suggestSlug,
	validatePublicationPolicy,
} from "./naming.ts";

const prompt = { source: "prompt" as const };
const policy = () => validatePublicationPolicy({});

describe("ticket identity", () => {
	it("detects distinct uppercase keys with identifier boundaries", () => {
		expect(detectTicketIds("ABC-12, ABC-12; A2_B-003 and OTHER-4")).toEqual([
			"ABC-12",
			"A2_B-003",
			"OTHER-4",
		]);
		expect(detectTicketIds("xABC-1 ABC-1x _ABC-1 ABC-1_ abc-2 2ABC-3")).toEqual(
			[],
		);
	});
	it("preselects one candidate, requires a choice for several, and allows manual/no ticket", () => {
		expect(resolveTicketSelection(prompt, "ABC-1 ABC-1")).toEqual({
			candidates: ["ABC-1"],
			ticketId: "ABC-1",
		});
		expect(() => resolveTicketSelection(prompt, "ABC-1 DEF-2")).toThrow(
			/ticketId/,
		);
		expect(
			resolveTicketSelection(prompt, "ABC-1 DEF-2", null).ticketId,
		).toBeNull();
		expect(resolveTicketSelection(prompt, "", "A2_B-003").ticketId).toBe(
			"A2_B-003",
		);
		expect(resolveTicketSelection(prompt, "").ticketId).toBeNull();
		expect(() => resolveTicketSelection(prompt, "", "abc-1")).toThrow(
			/ticketId/,
		);
	});
	it("preserves canonical Jira identity and refuses overrides", () => {
		const origin = { source: "jira" as const, key: "A2_B-003", url: null };
		expect(resolveTicketSelection(origin, "OTHER-1").ticketId).toBe("A2_B-003");
		for (const id of [null, "OTHER-1"])
			expect(() => resolveTicketSelection(origin, "", id)).toThrow(/ticketId/);
	});
});

describe("naming policy", () => {
	it("normalizes suggestions and never pads short titles", () => {
		expect(suggestSlug("Créer: TÓDO entity / with a very long title")).toBe(
			"creer-todo-entity-with-a-very",
		);
		expect(suggestSlug("Fix it")).toBe("fix-it");
		expect(() => renderBranch(policy(), "ABC-1", "fix-it", "id")).toThrow(
			/slug/,
		);
		expect(renderBranch(policy(), "A2_B-003", "create-todo-entity", "id")).toBe(
			"A2_B-003/create-todo-entity",
		);
	});
	it.each([
		"{slug}/{ticketId}",
		"{ticketId}/{ticketId}-{slug}",
		"{ticketId}/x/{slug}",
		"{ticketId}/{unknown}",
		"{ticketId}/{slug",
	])("rejects invalid branch template %s", (branchTemplate) => {
		expect(() => validatePublicationPolicy({ branchTemplate })).toThrow(
			/publication.branch_template/,
		);
	});
	it("counts literal words in the whole branch suffix", () => {
		const custom = validatePublicationPolicy({
			branchTemplate: "{ticketId}/fix-{slug}",
		});
		expect(renderBranch(custom, "ABC-1", "todo-entity", "id")).toBe(
			"ABC-1/fix-todo-entity",
		);
		expect(() =>
			renderBranch(custom, "ABC-1", "one-two-three-four-five-six", "id"),
		).toThrow(/slug/);
	});
	it.each([
		"{description}",
		"X [{ticketId}] {description}",
		"[{ticketId}] [{ticketId}] {description}",
		"[{ticketId}] ",
		"[{ticketId}] {other}",
		"[{ticketId}] {description}\nmore",
	])("rejects invalid subject template %s", (commitTemplate) => {
		expect(() => validatePublicationPolicy({ commitTemplate })).toThrow(
			/publication.commit_template/,
		);
		expect(() =>
			validatePublicationPolicy({ prTitleTemplate: commitTemplate }),
		).toThrow(/publication.pr_title_template/);
	});
	it("renders exact prefixes and collapses spaces while rejecting controls and empty descriptions", () => {
		expect(
			renderCommitSubject(policy(), "A2_B-003", " Create   todo entity "),
		).toBe("[A2_B-003] Create todo entity");
		expect(renderPrTitle(policy(), "ABC-1", "Create todo entity")).toBe(
			"[ABC-1] Create todo entity",
		);
		for (const description of [
			"",
			" ",
			"hello\nworld",
			"hello\tworld",
			"hello\u0000world",
			"hello\u007fworld",
			"hello\u2028world",
		]) {
			expect(() =>
				renderCommitSubject(policy(), "ABC-1", description),
			).toThrow();
		}
	});
	it("ignores ticket templates for ticketless branches and subjects", () => {
		expect(renderBranch(policy(), null, "", "execution-id")).toBe(
			"payo/execution-id",
		);
		expect(renderCommitSubject(policy(), null, "Fix bug")).toBe("Fix bug");
		expect(renderPrTitle(policy(), null, "Fix bug")).toBe("Fix bug");
	});
	it("substitutes body tokens literally, without expanding replacement text", () => {
		const values = {
			ticketId: null,
			prTitle: "A title",
			summary: "{checks} $&",
			changes: "- change",
			checks: "passed",
			executionId: "id",
		};
		expect(renderPrBody(policy(), values)).toBe(
			"## Summary\n{checks} $&\n\n## Changes\n- change\n\n## Validation\npassed",
		);
		expect(() =>
			validatePublicationPolicy({ prBodyTemplate: "{prompt}" }),
		).toThrow(/publication.pr_body_template/);
		expect(() =>
			validatePublicationPolicy({ prBodyTemplate: "{summary.x}" }),
		).toThrow();
		expect(() => validatePublicationPolicy({ remote: " " })).toThrow(
			/publication.remote/,
		);
	});
});

it("rejects trailing newlines in selected IDs, slugs and branch templates", () => {
	expect(() => resolveTicketSelection(prompt, "", "ABC-1\n")).toThrow(
		/ticketId/,
	);
	expect(() =>
		renderBranch(policy(), "ABC-1", "create-todo-entity\n", "id"),
	).toThrow(/slug/);
	expect(() =>
		validatePublicationPolicy({ branchTemplate: "{ticketId}/{slug}\n" }),
	).toThrow(/branch_template/);
});
