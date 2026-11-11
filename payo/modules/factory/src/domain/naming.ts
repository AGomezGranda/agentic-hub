import type { PublicationPolicy, WorkItemOrigin } from "@payo/contracts";
import { CommandError } from "../errors.ts";

const ticketPattern = /^[A-Z][A-Z0-9_]*-\d+$/;
const controls = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const defaults: PublicationPolicy = {
	remote: "origin",
	branchTemplate: "{ticketId}/{slug}",
	commitTemplate: "[{ticketId}] {description}",
	prTitleTemplate: "[{ticketId}] {description}",
	prBodyTemplate:
		"## Summary\n{summary}\n\n## Changes\n{changes}\n\n## Validation\n{checks}",
};

function invalid(field: string, message: string): never {
	throw new CommandError("invalid_request", `${field}: ${message}`);
}

export function detectTicketIds(description: string): string[] {
	return [
		...new Set(
			description.match(
				/(?<![\p{L}\p{N}_])[A-Z][A-Z0-9_]*-\d+(?![\p{L}\p{N}_])/gu,
			) ?? [],
		),
	];
}

function assertTicket(ticketId: string): void {
	if (!ticketPattern.test(ticketId))
		invalid("ticketId", "use an uppercase ticket key such as ABC-123");
}

export function resolveTicketSelection(
	origin: WorkItemOrigin,
	description: string,
	selection?: string | null,
): { candidates: string[]; ticketId: string | null } {
	const candidates =
		origin.source === "jira" ? [origin.key] : detectTicketIds(description);
	if (origin.source === "jira") {
		assertTicket(origin.key);
		if (selection !== undefined && selection !== origin.key)
			invalid("ticketId", "Jira identity cannot be overridden");
		return { candidates, ticketId: origin.key };
	}
	if (selection === undefined && candidates.length > 1)
		invalid(
			"ticketId",
			"choose a candidate, enter an ID or explicitly select no ticket",
		);
	const ticketId =
		selection === undefined ? (candidates[0] ?? null) : selection;
	if (ticketId !== null) assertTicket(ticketId);
	return { candidates, ticketId };
}

function templateTokens(
	template: string,
	allowed: string[],
	field: string,
): string[] {
	const tokens: string[] = [];
	const remainder = template.replace(
		/\{([^{}]*)\}/g,
		(_match, token: string) => {
			if (!allowed.includes(token))
				invalid(field, `unsupported placeholder {${token}}`);
			tokens.push(token);
			return "";
		},
	);
	if (/[{}]/.test(remainder)) invalid(field, "malformed placeholder");
	return tokens;
}

export function validatePublicationPolicy(
	overrides: Partial<PublicationPolicy>,
): PublicationPolicy {
	const policy = { ...defaults, ...overrides };
	if (!policy.remote.trim() || controls.test(policy.remote))
		invalid("publication.remote", "must be a nonblank single-line remote name");
	const branchField = "publication.branch_template";
	const branchTokens = templateTokens(
		policy.branchTemplate,
		["ticketId", "slug"],
		branchField,
	);
	if (
		branchTokens.filter((t) => t === "ticketId").length !== 1 ||
		branchTokens.filter((t) => t === "slug").length !== 1 ||
		!policy.branchTemplate.startsWith("{ticketId}/") ||
		!/^[a-z-]*\{slug\}[a-z-]*$/.test(
			policy.branchTemplate.slice("{ticketId}/".length),
		)
	) {
		invalid(
			branchField,
			"must start with {ticketId}/ followed by lowercase hyphenated words and one {slug}",
		);
	}
	// A template must leave room for at least one slug word within the six-word suffix.
	const suffix = policy.branchTemplate
		.slice("{ticketId}/".length)
		.replace("{slug}", "word");
	if (!/^[a-z]+(?:-[a-z]+)*$/.test(suffix) || suffix.split("-").length > 6)
		invalid(branchField, "suffix must allow 3–6 lowercase words");
	for (const [template, field] of [
		[policy.commitTemplate, "publication.commit_template"],
		[policy.prTitleTemplate, "publication.pr_title_template"],
	] as const) {
		const tokens = templateTokens(template, ["ticketId", "description"], field);
		if (
			controls.test(template) ||
			!template.startsWith("[{ticketId}] ") ||
			tokens.filter((t) => t === "ticketId").length !== 1 ||
			tokens.filter((t) => t === "description").length !== 1
		)
			invalid(
				field,
				"must retain the exact [{ticketId}] prefix and one {description} on a single line",
			);
	}
	templateTokens(
		policy.prBodyTemplate,
		["ticketId", "prTitle", "summary", "changes", "checks", "executionId"],
		"publication.pr_body_template",
	);
	return policy;
}

export function suggestSlug(title: string): string {
	return (
		title
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.match(/[a-z]+/g)
			?.slice(0, 6)
			.join("-") ?? ""
	);
}

function substitute(template: string, values: Record<string, string>): string {
	return template.replace(
		/\{([^{}]+)\}/g,
		(_match, key: string) => values[key] ?? "",
	);
}

export function renderBranch(
	policy: PublicationPolicy,
	ticketId: string | null,
	slug: string,
	executionId: string,
): string {
	if (ticketId === null) return `payo/${executionId}`;
	assertTicket(ticketId);
	const branch = substitute(policy.branchTemplate, { ticketId, slug });
	const suffix = branch.slice(ticketId.length + 1);
	if (
		!branch.startsWith(`${ticketId}/`) ||
		!/^[a-z]+(?:-[a-z]+){2,5}$/.test(suffix)
	)
		invalid(
			"slug",
			"rendered suffix must contain 3–6 lowercase ASCII words separated by hyphens",
		);
	return branch;
}

function subject(
	template: string,
	ticketId: string | null,
	description: string,
): string {
	if (controls.test(description) || !description.trim())
		invalid(
			"description",
			"must be nonblank and single-line without control characters",
		);
	const normalized = description.trim().replace(/\s+/g, " ");
	if (ticketId !== null) assertTicket(ticketId);
	return ticketId === null
		? normalized
		: substitute(template, { ticketId, description: normalized })
				.trim()
				.replace(/\s+/g, " ");
}

export function renderCommitSubject(
	policy: PublicationPolicy,
	ticketId: string | null,
	description: string,
): string {
	return subject(policy.commitTemplate, ticketId, description);
}
export function renderPrTitle(
	policy: PublicationPolicy,
	ticketId: string | null,
	description: string,
): string {
	return subject(policy.prTitleTemplate, ticketId, description);
}
export function renderPrBody(
	policy: PublicationPolicy,
	values: {
		ticketId: string | null;
		prTitle: string;
		summary: string;
		changes: string;
		checks: string;
		executionId: string;
	},
): string {
	return substitute(policy.prBodyTemplate, {
		...values,
		ticketId: values.ticketId ?? "",
	});
}
