import { isAbsolute, posix } from "node:path";
import type { AgentInput, AgentSpec, ArtifactRef } from "@payo/contracts";
import type { RunStore } from "@payo/kernel";
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
		!source.path.trim()
	)
		throw new Error("invalid role source");
	return store.putArtifact(new TextEncoder().encode(JSON.stringify(source)), {
		kind: "factory-role-source-v1",
		mediaType: "application/json",
	});
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
		roleSpecSha: source.sha,
		...config,
		outputContract: contracts[role],
		inputs: [{ name: "role-source", ref }, ...inputs],
		instructions: [
			`Skill: ${source.path}\n${source.content}`,
			...Object.entries(source.resources).map(
				([path, content]) => `Resource: ${path}\n${content}`,
			),
			"Use read-only tools. Do not converse with the user or spawn agents. Return only the JSON envelope required by the output contract. The engine owns artifacts.",
			output[role],
			"Question IDs must remain stable; use a new ID when a question's meaning changes.",
			...(lens
				? [`Review the plan through the ${lens} lens: ${lenses[lens]}.`]
				: []),
		].join("\n\n"),
	};
}
