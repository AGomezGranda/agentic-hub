import { isAbsolute, posix } from "node:path";
import type { AgentInput, AgentSpec, ArtifactRef } from "@payo/contracts";
import { type RunStore, sha256Hex } from "@payo/kernel";
import { readArtifact } from "./artifacts.ts";
import type { RoleSource } from "./types.ts";

export const lenses = {
	architecture: "modularity, coupling, scalability, tradeoffs",
	security: "authn/authz, input handling, secrets, STRIDE/OWASP",
	"test-coverage":
		"test-first/TDD, pyramid balance, edge cases, isolation, right-level coverage",
	"code-quality": "design principles, error handling, complexity",
	correctness: "logical validity, boundaries, state, concurrency",
	simplicity:
		"YAGNI: work nobody asked for, speculative abstraction/config/options, phases or steps that can be cut or merged, building what the codebase, stdlib or an installed dep already provides",
	compatibility: "API contracts, deps, versioning",
} as const;

export const architectureRubricPaths = [
	"skills/architecture-audit/references/standard.md",
	"skills/architecture-audit/references/checks.md",
] as const;

export const codeQualityRubricPaths = [
	"skills/code-quality-audit/references/checks.md",
] as const;

export const reviewContractPath = "skills/_shared/review.md";

export const planLensResourcePaths = [
	"skills/review-plan/references/lenses.md",
] as const;

function composedContent(source: Omit<RoleSource, "composedSha">): string {
	return [
		`Skill: ${source.path}\n${source.content}`,
		...Object.entries(source.resources)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([path, content]) => `Resource: ${path}\n${content}`),
		...(source.addendum ? [source.addendum] : []),
	].join("\n\n");
}

export async function snapshotRole(
	store: RunStore,
	source: RoleSource,
): Promise<ArtifactRef> {
	if (
		!source.sha.trim() ||
		!source.content.trim() ||
		isAbsolute(source.path) ||
		source.path.includes("\\") ||
		posix.normalize(source.path).startsWith("../") ||
		source.path === ".." ||
		!source.path.trim() ||
		(source.addendum !== undefined && !source.addendum.trim())
	)
		throw new Error("invalid role source");
	const stored: RoleSource = {
		path: source.path,
		sha: source.sha,
		content: source.content,
		resources: source.resources,
		...(source.addendum === undefined
			? {}
			: {
					addendum: source.addendum,
					composedSha: sha256Hex(
						new TextEncoder().encode(
							composedContent({
								path: source.path,
								sha: source.sha,
								content: source.content,
								resources: source.resources,
								addendum: source.addendum,
							}),
						),
					),
				}),
	};
	return store.putArtifact(new TextEncoder().encode(JSON.stringify(stored)), {
		kind: "factory-role-source-v1",
		mediaType: "application/json",
	});
}

/** Only the lens material relevant to the role and lens reaches the prompt. */
function selectedResources(
	role: "planner" | "reviewer" | "verifier" | "reviser",
	lens: keyof typeof lenses | undefined,
	resources: Record<string, string>,
): Array<[string, string]> {
	const architecture = new Set<string>(architectureRubricPaths);
	const quality = new Set<string>(codeQualityRubricPaths);
	const lensMaterial = new Set<string>(planLensResourcePaths);
	const rubrics = new Set([...architecture, ...quality]);
	let allowed: Set<string>;
	if (role === "planner" || role === "reviser") allowed = rubrics;
	else if (role === "verifier")
		allowed = new Set([...lensMaterial, ...rubrics]);
	else if (lens === "architecture")
		allowed = new Set([...lensMaterial, ...architecture]);
	else if (lens === "code-quality")
		allowed = new Set([...lensMaterial, ...quality]);
	else allowed = lensMaterial;
	const known = new Set([...lensMaterial, ...rubrics]);
	return Object.entries(resources).filter(
		([path]) => allowed.has(path) || !known.has(path),
	);
}

export async function roleSpec(
	store: RunStore,
	ref: ArtifactRef,
	role: "planner" | "reviewer" | "verifier" | "reviser",
	cwd: string,
	config: { model: string | null; timeoutMs: number },
	inputs: AgentInput[],
	lens?: keyof typeof lenses,
): Promise<AgentSpec> {
	const source = JSON.parse(
		new TextDecoder().decode(await readArtifact(store, ref)),
	) as RoleSource;
	const contracts = {
		planner: "factory-plan-v1",
		reviewer: "factory-review-v1",
		verifier: "factory-verified-v1",
		reviser: "factory-revision-v1",
	};
	const output = {
		planner:
			'Return {"markdown": string, "prStrategy": [{"id": string, "title": string, "phases": string[]}], "openQuestions": [{"id": string, "question": string}]}.',
		reviewer:
			'Return {"findings": [{"id": string, "severity": "P0"|"P1"|"P2", "title": string, "path": string|null, "line": positive integer|null, "evidence": string, "consequence": string, "suggestedFix": string}]}. Finding IDs must be unique across lenses; prefix each with the lens name.',
		verifier:
			'Return {"verdicts": [{"sourceIds": string[], "classification": "BLOCKER"|"NON-BLOCKER"|"STALE"|"INVALID"|"SPECULATIVE", "severity": "P0"|"P1"|"P2", "reason": string, "counterEvidence": string|null}]}. Cover each finding once, list every merged ID, and supply counter-evidence for INVALID. NON-BLOCKER means outside this slice.',
		reviser:
			'Return {"plan": {"markdown": string, "prStrategy": [{"id": string, "title": string, "phases": string[]}], "openQuestions": [{"id": string, "question": string}]}, "unreconciledFindingIds": string[]}.',
	};
	return {
		role,
		cwd,
		tools: "read-only",
		roleSpecSha: source.composedSha ?? source.sha,
		...config,
		outputContract: contracts[role],
		inputs: [{ name: "role-source", ref }, ...inputs],
		instructions: [
			`Skill: ${source.path}\n${source.content}`,
			...selectedResources(role, lens, source.resources).map(
				([path, content]) => `Resource: ${path}\n${content}`,
			),
			...(source.addendum ? [source.addendum] : []),
			"Use read-only tools. Do not converse with the user or spawn agents. Return only the JSON envelope required by the output contract. The engine owns artifacts.",
			output[role],
			...(role === "planner" || role === "reviser"
				? [
						"Use a unique Markdown heading '## Phase N — Title' per implementation phase. Assign every phase to exactly one PR, in execution order, including single-PR plans. Each prStrategy phase string must copy the full heading text without the leading hashes. Update the mapping when revising the plan.",
					]
				: []),
			"Question IDs must remain stable; use a new ID when a question's meaning changes.",
			...(lens
				? [`Review the plan through the ${lens} lens: ${lenses[lens]}.`]
				: []),
		].join("\n\n"),
	};
}
