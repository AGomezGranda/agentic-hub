import {
	type AgentEvent,
	type AgentSpec,
	type ArtifactRef,
	ExecutionManifest,
	ExecutionRunConfig,
	FactoryCheckpoint,
	type PlanOutput,
	PlanVersion,
} from "@payo/contracts";
import {
	type AgentRunner,
	type Checks,
	commit,
	createLimiter,
	createMemoryRunStore,
	type ExecutionWorkspace,
	fold,
	type RunStore,
	startRun,
} from "@payo/kernel";
import { describe, expect, it } from "vitest";
import { readArtifact, savePlanVersion, storeCheckpoint } from "./artifacts.ts";
import {
	beginExecution,
	executeExecution,
	openExecution,
	readExecutionSummary,
	resumeExecution,
} from "./execution.ts";

const roleSettings = { model: null, timeoutMs: 1000 };
const roles = {
	planner: roleSettings,
	reviewer: roleSettings,
	verifier: roleSettings,
	reviser: roleSettings,
};
const executionRoles = {
	preparer: roleSettings,
	implementer: roleSettings,
	scout: roleSettings,
	reviewer: roleSettings,
	verifier: roleSettings,
};

function artifact(seed: string): ArtifactRef {
	return {
		sha256: seed.repeat(64),
		size: 1,
		kind: "test",
		mediaType: "application/json",
	};
}

const roleArtifacts = {
	preparer: artifact("a"),
	implementer: artifact("b"),
	scout: artifact("1"),
	reviewer: artifact("2"),
	verifier: artifact("3"),
};

const roleProvenance = {
	preparer: { path: "skills/implement-plan/SKILL.md", sha: "preparer-sha" },
	implementer: {
		path: "skills/implement-plan/SKILL.md",
		sha: "implementer-sha",
	},
	scout: { path: "skills/review-implementation/SKILL.md", sha: "scout-sha" },
	reviewer: {
		path: "skills/review-implementation/SKILL.md",
		sha: "reviewer-sha",
	},
	verifier: {
		path: "skills/review-implementation/SKILL.md",
		sha: "verifier-sha",
	},
};

const checks = [
	{ name: "unit", command: "pnpm", args: ["test"], timeout_ms: 1000 },
];

const markdown = `# Plan

## Phase 1
Add the boundary.

Acceptance: domain policy stays inward.
`;

async function sourceRun(
	store: RunStore,
	options: {
		runId?: string;
		ended?: boolean;
		outcome?: string;
		phases?: string[];
		markdown?: string;
	} = {},
) {
	const runId = options.runId ?? "source-run";
	const state = await startRun(store, {
		runId,
		repo: "/repo",
		baseBranch: "main",
		config: {
			factory: {
				workItemRequest: { source: "jira", key: "T" },
				roles,
				maxConcurrentAgents: 1,
				roleArtifacts: {
					planner: artifact("c"),
					reviewer: artifact("d"),
					verifier: artifact("e"),
					reviser: artifact("f"),
				},
				lenses: ["architecture"],
				roleProvenance: {
					planner: { path: "p", sha: "p" },
					reviewer: { path: "r", sha: "r" },
					verifier: { path: "v", sha: "v" },
					reviser: { path: "q", sha: "q" },
				},
			},
		},
	});
	const plan: PlanOutput = {
		markdown: options.markdown ?? markdown,
		prStrategy: [
			{
				id: "pr-1",
				title: "One",
				phases: options.phases ?? ["Phase 1"],
			},
			{ id: "pr-empty", title: "Empty", phases: [] },
		],
		openQuestions: [],
	};
	const saved = await savePlanVersion(store, {
		number: 1,
		source: "human",
		plan,
		answers: {},
	});
	const planEvent = saved[1];
	if (planEvent?.type !== "artifact.recorded")
		throw new Error("plan version artifact expected");
	const checkpoint = FactoryCheckpoint.parse({
		revision: 0,
		stage: "Approved",
		cycle: 1,
		round: 0,
		workItem: null,
		workspace: null,
		plan: planEvent.artifact,
		lastAgentPlan: planEvent.artifact,
		answers: {},
		review: null,
		approvalMetric: null,
		inFlight: null,
	});
	await commit(store, state, [
		...saved,
		await storeCheckpoint(store, checkpoint),
		...(options.ended === false
			? []
			: [
					{
						type: "run.ended" as const,
						outcome: options.outcome ?? "approved",
					},
				]),
	]);
	return { runId, plan, ref: planEvent.artifact };
}

function input(sourceRunId = "source-run") {
	return {
		sourceRunId,
		prId: "pr-1",
		baseBranch: "main",
		baseCommit: "abc123",
		checks,
		roles: { ...roles, ...executionRoles },
		roleArtifacts,
		roleProvenance,
		maxConcurrentAgents: 2,
	};
}

async function roleRefs(store: RunStore) {
	const make = async (name: string) =>
		store.putArtifact(
			new TextEncoder().encode(
				JSON.stringify({
					path:
						name === "implementer"
							? "skills/implement-plan/SKILL.md"
							: "skills/review-implementation/SKILL.md",
					sha: `${name}-sha`,
					content: `${name} role`,
					resources: {},
				}),
			),
			{ kind: "factory-role-source-v1", mediaType: "application/json" },
		);
	return Object.fromEntries(
		await Promise.all(
			Object.keys(executionRoles).map(async (name) => [name, await make(name)]),
		),
	) as typeof roleArtifacts;
}

function workspacePort(
	options: {
		initialChanges?: boolean;
		failAfterCommit?: boolean;
		failAfterCommitAt?: number;
	} = {},
) {
	let path = "/worktrees/execution";
	let branch = "payo/execution";
	let revision = options.initialChanges ? 1 : 0;
	let head = "abc123";
	let commitNumber = 0;
	const committedPaths = new Set<string>();
	let committedParent: string | null = null;
	let committedTree = "tree-base";
	let committedMessage = "";
	let failAfterCommitAt = options.failAfterCommit
		? 1
		: (options.failAfterCommitAt ?? 0);
	const port: ExecutionWorkspace = {
		async resolveBase() {
			return head;
		},
		async prepare(input) {
			path = `${input.worktreeRoot}/${input.executionId}`;
			branch = input.branch;
			return { path, branch, baseCommit: input.baseCommit };
		},
		async inspect() {
			return {
				head,
				branch,
				fingerprint: `snapshot-${revision}`,
				changedPaths: revision > 0 ? ["partial.ts"] : [],
				historyFingerprint: `history-${commitNumber}`,
			};
		},
		async diff(_path, baseCommit) {
			const paths = new Set(baseCommit === "abc123" ? committedPaths : []);
			if (revision > 0) paths.add("partial.ts");
			return [...paths]
				.map(
					(changedPath) =>
						`diff --git a/${changedPath} b/${changedPath}\n+partial\n`,
				)
				.join("");
		},
		async verifyPrerequisites(_repo, _base, prerequisites) {
			return prerequisites.map((item) => ({
				description: item.description,
				present: true,
				reason: null,
			}));
		},
		async instructions() {
			return { "AGENTS.md": "follow repository instructions" };
		},
		async prepareCommit(_path, expectedSnapshot) {
			return {
				parent: head,
				tree: `tree-${revision}-${commitNumber}`,
				expectedSnapshot,
				changed: revision > 0,
			};
		},
		async inspectCommit() {
			return {
				head,
				parent: committedParent,
				tree: committedTree,
				message: committedMessage,
			};
		},
		async commit(_path, _expected, message, _signal, expectation) {
			committedParent = head;
			committedTree = expectation?.tree ?? `tree-${revision}-${commitNumber}`;
			committedMessage = message;
			if (revision > 0) committedPaths.add("partial.ts");
			commitNumber++;
			head = `result-commit-${commitNumber}`;
			revision = 0;
			if (commitNumber === failAfterCommitAt) {
				failAfterCommitAt = 0;
				throw new Error("simulated process loss after Git commit");
			}
			return head;
		},
	};
	return {
		port,
		mutate() {
			revision++;
		},
		moveHead() {
			head = "unexpected-commit";
		},
		get path() {
			return path;
		},
	};
}

function scriptedRunner(
	outputs: Array<
		| unknown
		| ((spec: AgentSpec, signal: AbortSignal) => AsyncIterable<AgentEvent>)
	>,
	store: RunStore,
) {
	const calls: AgentSpec[] = [];
	let index = 0;
	const runner: AgentRunner = {
		id: "execution-script",
		run(spec, signal) {
			calls.push(spec);
			const output = outputs[index++];
			if (typeof output === "function") return output(spec, signal);
			const fallback = spec.role.startsWith("implementation-reviewer:")
				? { checked: ["reviewed supplied evidence"], findings: [] }
				: spec.role === "implementation-verifier"
					? { verdicts: [], planIssues: [] }
					: spec.outputContract === "factory-execution-repair-v1"
						? {
								summary: "Repaired the validation failure.",
								addressedFindingIds: [],
								unresolvedFindingIds: [],
								planIssues: [],
							}
						: output;
			return (async function* () {
				let value = fallback;
				if (
					spec.role === "implementation-scout" &&
					!(typeof output === "object" && output !== null && "files" in output)
				) {
					const diffRef = spec.inputs.find(
						(item) => item.name === "engine-diff",
					)?.ref;
					const instructionRef = spec.inputs.find(
						(item) => item.name === "repository-instructions",
					)?.ref;
					const diff = diffRef
						? new TextDecoder().decode(await readArtifact(store, diffRef))
						: "";
					const instructions = instructionRef
						? (JSON.parse(
								new TextDecoder().decode(
									await readArtifact(store, instructionRef),
								),
							) as Record<string, string>)
						: {};
					const paths = [
						...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm),
					].map((match) => match[2] ?? match[1] ?? "");
					value = {
						summary: "Scoped the supplied diff.",
						files: [...new Set(paths)].map((path) => ({
							path,
							purpose: "changed by this phase",
							instructionPaths: Object.keys(instructions).filter(
								(instruction) => {
									const dir = instruction.includes("/")
										? instruction.slice(0, instruction.lastIndexOf("/"))
										: "";
									return !dir || path.startsWith(`${dir}/`);
								},
							),
						})),
						planIssues: [],
					};
				}
				yield { type: "result", text: JSON.stringify(value) } as const;
			})();
		},
	};
	return { runner, calls };
}

const manifestOutput = {
	pr: { id: "pr-1", title: "One" },
	phases: [
		{
			id: "phase-1",
			title: "Boundary",
			planExcerpt: ["## Phase 1", "Add the boundary."].join("\n"),
			acceptanceCriteria: ["Acceptance: domain policy stays inward."],
		},
	],
	prerequisites: [],
	issues: [],
};
const implementationOutput = {
	summary: "Implemented the boundary.",
	completedCriteria: ["Acceptance: domain policy stays inward."],
	planIssues: [],
};

function reviewRepairRunner(
	options: {
		unresolved?: boolean;
		finding?: boolean;
		onArchitectureReview?: () => void;
		onImplementation?: () => void;
		scoutFiles?: Array<{
			path: string;
			purpose: string;
			instructionPaths: string[];
		}>;
	} = {},
) {
	const calls: AgentSpec[] = [];
	const lensRuns = new Map<string, number>();
	let verifierRuns = 0;
	let implementerRuns = 0;
	const finding = {
		id: "architecture:domain-policy-boundary",
		severity: "P2",
		title: "Domain policy leaks into an adapter",
		path: "src/domain.ts",
		line: 12,
		evidence: "The adapter imports and applies the domain rule.",
		consequence:
			"The invariant is coupled to infrastructure and cannot be tested independently.",
		suggestedFix: "Move the policy decision behind the application boundary.",
	};
	const runner: AgentRunner = {
		id: "review-repair-script",
		run(spec) {
			calls.push(spec);
			let value: unknown;
			if (spec.role === "execution-preparer") value = manifestOutput;
			else if (spec.role === "implementer") {
				implementerRuns++;
				if (implementerRuns === 1) options.onImplementation?.();
				value =
					implementerRuns === 1
						? implementationOutput
						: {
								summary: "Addressed architecture:domain-policy-boundary",
								addressedFindingIds: options.unresolved ? [] : [finding.id],
								unresolvedFindingIds: options.unresolved ? [finding.id] : [],
								planIssues: [],
							};
			} else if (spec.role === "implementation-scout") {
				value = {
					summary: "Scoped the phase diff.",
					files: options.scoutFiles ?? [],
					planIssues: [],
				};
			} else if (spec.role.startsWith("implementation-reviewer:")) {
				const lens = spec.role.slice("implementation-reviewer:".length);
				const count = (lensRuns.get(lens) ?? 0) + 1;
				lensRuns.set(lens, count);
				if (lens === "architecture" && count === 1)
					options.onArchitectureReview?.();
				value = {
					checked: [`checked ${lens} evidence`],
					findings:
						options.finding !== false && lens === "architecture" && count === 1
							? [finding]
							: [],
				};
			} else if (spec.role === "implementation-verifier") {
				verifierRuns++;
				value = {
					verdicts:
						options.finding !== false && verifierRuns === 1
							? [
									{
										sourceIds: [finding.id],
										classification: "BLOCKER",
										severity: "P2",
										reason: "Concrete dependency-direction violation.",
										counterEvidence: null,
									},
								]
							: [],
					planIssues: [],
				};
			} else throw new Error(`unexpected agent role ${spec.role}`);
			return (async function* () {
				yield { type: "result", text: JSON.stringify(value) } as const;
			})();
		},
	};
	return { runner, calls, findingId: finding.id };
}

function passingChecks(): Checks {
	return {
		run: async (_cwd, commands) =>
			commands.map((command) => ({
				name: command.name,
				status: "passed" as const,
				exitCode: 0,
				stdout: "passed",
				stderr: "",
				truncated: false,
			})),
	};
}

function multiPhaseRunner(
	store: RunStore,
	workspace: ReturnType<typeof workspacePort>,
	manifest: typeof manifestOutput,
	options: {
		finalBlocker?: boolean;
		repeatFinalBlocker?: boolean;
		interruptSecondWriter?: boolean;
	} = {},
) {
	const calls: AgentSpec[] = [];
	let implementationRuns = 0;
	let finalFindingReported = false;
	let finalFindingPending = false;
	const finalFinding = {
		id: "architecture:final-design",
		severity: "P2",
		title: "Final PR has a concrete boundary violation",
		path: "partial.ts",
		line: 1,
		evidence: "The final diff shows policy owned by the adapter.",
		consequence: "The invariant is coupled to infrastructure.",
		suggestedFix: "Move the policy inward.",
	};
	const runner: AgentRunner = {
		id: "multi-phase-script",
		run(spec, signal) {
			calls.push(spec);
			return (async function* () {
				let value: unknown;
				if (spec.role === "execution-preparer") value = manifest;
				else if (spec.role === "implementer") {
					workspace.mutate();
					implementationRuns++;
					if (options.interruptSecondWriter && implementationRuns === 2) {
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return;
					}
					const phaseRecovery =
						options.interruptSecondWriter && implementationRuns === 3;
					if (implementationRuns > manifest.phases.length && !phaseRecovery) {
						value = {
							summary: "Addressed the final verification finding.",
							addressedFindingIds: [finalFinding.id],
							unresolvedFindingIds: [],
							planIssues: [],
						};
						yield { type: "result", text: JSON.stringify(value) } as const;
						return;
					}
					const phaseInput = JSON.parse(
						new TextDecoder().decode(
							await readArtifact(
								store,
								spec.inputs.find((item) => item.name === "phase")?.ref ??
									artifact("f"),
							),
						),
					) as {
						phase: { id: string; acceptanceCriteria: string[] };
						receipts: Array<{ phaseId: string }>;
					};
					value = {
						summary: `Implemented ${phaseInput.phase.id}`,
						completedCriteria: phaseInput.phase.acceptanceCriteria,
						planIssues: [],
					};
				} else if (spec.role === "implementation-scout") {
					const diffRef = spec.inputs.find(
						(item) => item.name === "engine-diff",
					)?.ref;
					const instructionsRef = spec.inputs.find(
						(item) => item.name === "repository-instructions",
					)?.ref;
					const diff = diffRef
						? new TextDecoder().decode(await readArtifact(store, diffRef))
						: "";
					const instructions = instructionsRef
						? (JSON.parse(
								new TextDecoder().decode(
									await readArtifact(store, instructionsRef),
								),
							) as Record<string, string>)
						: {};
					const paths = [
						...new Set(
							[...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
								(match) => match[2] ?? match[1] ?? "",
							),
						),
					];
					value = {
						summary: "Scoped captured changes.",
						files: paths.map((path) => ({
							path,
							purpose: "implemented phase",
							instructionPaths: Object.keys(instructions).filter(
								(instruction) => {
									const directory = instruction.includes("/")
										? instruction.slice(0, instruction.lastIndexOf("/"))
										: "";
									return !directory || path.startsWith(`${directory}/`);
								},
							),
						})),
						planIssues: [],
					};
				} else if (spec.role.startsWith("implementation-reviewer:")) {
					const phaseRef = spec.inputs.find(
						(item) => item.name === "phase",
					)?.ref;
					const scope = phaseRef
						? (
								JSON.parse(
									new TextDecoder().decode(await readArtifact(store, phaseRef)),
								) as { scope?: string }
							).scope
						: "phase";
					const finding =
						options.finalBlocker &&
						scope === "final" &&
						spec.role.endsWith(":architecture") &&
						(!finalFindingReported || options.repeatFinalBlocker === true);
					if (finding) {
						finalFindingReported = true;
						finalFindingPending = true;
					}
					value = {
						checked: ["checked evidence"],
						findings: finding ? [finalFinding] : [],
					};
				} else if (spec.role === "implementation-verifier") {
					value = {
						verdicts: finalFindingPending
							? [
									{
										sourceIds: [finalFinding.id],
										classification: "BLOCKER",
										severity: "P2",
										reason: "Concrete in-scope boundary violation.",
										counterEvidence: null,
									},
								]
							: [],
						planIssues: [],
					};
					finalFindingPending = false;
				} else throw new Error(`unexpected agent role ${spec.role}`);
				yield { type: "result", text: JSON.stringify(value) } as const;
			})();
		},
	};
	return { runner, calls };
}

async function executionSetup(
	store: RunStore,
	outputs: Array<
		| unknown
		| ((spec: AgentSpec, signal: AbortSignal) => AsyncIterable<AgentEvent>)
	>,
	options: {
		checks?: Checks;
		workspace?: ReturnType<typeof workspacePort>;
	} = {},
) {
	const workspace = options.workspace ?? workspacePort();
	const scripted = scriptedRunner(outputs, store);
	const refs = await roleRefs(store);
	const deps = {
		newId: () => crypto.randomUUID(),
		store,
		runner: scripted.runner,
		limiter: createLimiter(2),
		workspace: workspace.port,
		checks: options.checks ?? passingChecks(),
		dataDir: "/tmp/payo-execution-tests",
	};
	return {
		deps,
		workspace,
		runner: scripted.runner,
		calls: scripted.calls,
		input: { ...input(), roleArtifacts: refs },
	};
}

async function executionConfig(store: RunStore, runId: string) {
	const state = fold(await store.read(runId));
	return ExecutionRunConfig.parse(state.config.factory);
}

describe("execution acceptance", () => {
	it("pins the approved plan and all supplied execution roles", async () => {
		const store = createMemoryRunStore();
		const source = await sourceRun(store);
		const before = await store.read(source.runId);
		const handle = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			input(),
		);
		const runId = handle.log.current().runId;

		expect(runId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(handle.checkpoint).toMatchObject({
			revision: 0,
			stage: "Prepare",
			manifest: null,
			workspace: null,
			inFlight: null,
			escalation: null,
		});
		const config = await executionConfig(store, runId);
		expect(config).toMatchObject({
			kind: "factory-execution",
			sourceRunId: source.runId,
			sourceBaseBranch: "main",
			prId: "pr-1",
			baseCommit: "abc123",
			checks,
			roleArtifacts,
			roleProvenance,
			maxConcurrentAgents: 2,
		});
		expect(config.plan.sha256).toBe(source.ref.sha256);

		const state = handle.log.current();
		expect(state.steps.size).toBe(0);
		expect(state.attempts.size).toBe(0);
		expect(state.gates.size).toBe(0);
		for (const ref of [source.ref, ...Object.values(roleArtifacts)])
			expect(state.artifacts).toContainEqual(ref);
		expect(await store.read(source.runId)).toEqual(before);
	});

	it("keeps the approved artifact authoritative after later plan versions", async () => {
		const store = createMemoryRunStore();
		const source = await sourceRun(store);
		const later = await savePlanVersion(store, {
			number: 2,
			source: "human",
			plan: { ...source.plan, markdown: "# Edited after approval\n" },
			answers: {},
		});
		const laterEvent = later[1];
		if (laterEvent?.type !== "artifact.recorded")
			throw new Error("plan version artifact expected");
		const handle = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			input(),
		);

		const config = await executionConfig(store, handle.log.current().runId);
		expect(config.plan.sha256).toBe(source.ref.sha256);
		expect(config.plan.sha256).not.toBe(laterEvent.artifact.sha256);
		const pinned = PlanVersion.parse(
			JSON.parse(
				new TextDecoder().decode(await readArtifact(store, config.plan)),
			),
		);
		expect(pinned.plan.markdown).toBe(markdown);
	});

	it("returns the existing execution for a duplicate identity", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const first = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			input(),
		);
		const second = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			input(),
		);

		expect(second.log.current().runId).toBe(first.log.current().runId);
		expect((await store.listRunIds()).sort()).toEqual(
			["source-run", first.log.current().runId].sort(),
		);
		const runId = first.log.current().runId;
		const implicit = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			{ ...input(), baseCommit: "advanced" },
		);
		expect(implicit.log.current().runId).toBe(runId);
		expect((await executionConfig(store, runId)).baseCommit).toBe("abc123");
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				{ ...input(), baseCommit: "other", explicitBase: true },
			),
		).rejects.toMatchObject({
			code: "conflict",
			message: expect.stringContaining(runId),
		});
	});

	it("serializes concurrent duplicate acceptance", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const [first, second] = await Promise.all([
			beginExecution({ store, newId: () => crypto.randomUUID() }, input()),
			beginExecution({ store, newId: () => crypto.randomUUID() }, input()),
		]);
		expect(second.log.current().runId).toBe(first.log.current().runId);
		expect(
			(await store.listRunIds()).filter((id) => id !== "source-run"),
		).toHaveLength(1);
	});

	it("rejects missing, unapproved, unknown, and empty PR sources", async () => {
		const store = createMemoryRunStore();
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				input("missing"),
			),
		).rejects.toMatchObject({ code: "invalid_request" });

		await sourceRun(store, { runId: "active", ended: false });
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				input("active"),
			),
		).rejects.toThrow(/not been approved/);

		await sourceRun(store, { runId: "escalated", outcome: "escalated" });
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				input("escalated"),
			),
		).rejects.toThrow(/not been approved/);

		await sourceRun(store, { runId: "approved" });
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				{ ...input("approved"), prId: "missing" },
			),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				{ ...input("approved"), prId: "pr-empty" },
			),
		).rejects.toThrow(/no phases/);
		await expect(
			beginExecution(
				{ store, newId: () => crypto.randomUUID() },
				{ ...input("approved"), checks: [] },
			),
		).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("accepts an ordered multi-phase PR unit", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store, {
			markdown: `${markdown}\n## Phase 2 — Review\n`,
			phases: ["Phase 1", "Phase 2"],
		});

		const handle = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			input(),
		);

		expect(handle.checkpoint.stage).toBe("Prepare");
		expect(handle.log.current().status).toBe("active");
	});

	it("opens only execution runs", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		await expect(
			openExecution({ store, newId: () => crypto.randomUUID() }, "source-run"),
		).rejects.toThrow(/not an execution run/);
	});
});

describe("execution lifecycle", () => {
	it("executes ordered phases with receipt handoffs and a final PR-wide review", async () => {
		const store = createMemoryRunStore();
		const planMarkdown = [
			"# Plan",
			"",
			"## Phase 1",
			"Foundation.",
			"Acceptance: foundation works.",
			"",
			"## Phase 2",
			"Integration.",
			"Acceptance: integration works.",
			"",
		].join("\n");
		await sourceRun(store, {
			phases: ["Foundation", "Integration"],
			markdown: planMarkdown,
		});
		const manifest = {
			pr: { id: "pr-1", title: "One" },
			phases: [
				{
					id: "phase-1",
					title: "Foundation",
					planExcerpt: "## Phase 1\nFoundation.",
					acceptanceCriteria: ["Acceptance: foundation works."],
				},
				{
					id: "phase-2",
					title: "Integration",
					planExcerpt: "## Phase 2\nIntegration.",
					acceptanceCriteria: ["Acceptance: integration works."],
				},
			],
			prerequisites: [],
			issues: [],
		};
		const workspace = workspacePort();
		const fixture = await executionSetup(store, [manifestOutput]);
		fixture.deps.workspace = workspace.port;
		const script = multiPhaseRunner(store, workspace, manifest);
		fixture.deps.runner = script.runner;
		const handle = await beginExecution(fixture.deps, fixture.input);
		const completed = await executeExecution(handle, {
			signal: new AbortController().signal,
		});

		expect(completed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		expect(await readExecutionSummary(completed)).toMatchObject({
			phaseCount: 2,
			phases: [
				{ id: "phase-1", title: "Phase 1" },
				{ id: "phase-2", title: "Phase 2" },
			],
			completedPhases: [
				{ id: "phase-1", title: "Phase 1" },
				{ id: "phase-2", title: "Phase 2" },
			],
			resultCommit: "result-commit-2",
		});
		expect(completed.checkpoint).toMatchObject({
			stage: "Completed",
			phaseIndex: 1,
			scope: "final",
			receipts: [expect.anything(), expect.anything()],
		});
		const receipts = await Promise.all(
			completed.checkpoint.receipts.map(async (ref) =>
				JSON.parse(new TextDecoder().decode(await readArtifact(store, ref))),
			),
		);
		expect(receipts.map((receipt) => receipt.phaseId)).toEqual([
			"phase-1",
			"phase-2",
		]);
		const implementers = script.calls.filter(
			(call) => call.role === "implementer",
		);
		expect(implementers).toHaveLength(2);
		const secondPhaseRef = implementers[1]?.inputs.find(
			(item) => item.name === "phase",
		)?.ref;
		if (!secondPhaseRef) throw new Error("second-phase input is missing");
		const secondPhaseInput = JSON.parse(
			new TextDecoder().decode(await readArtifact(store, secondPhaseRef)),
		);
		expect(secondPhaseInput.phase.id).toBe("phase-2");
		expect(secondPhaseInput.receipts).toMatchObject([
			{ phaseId: "phase-1", resultCommit: receipts[0].resultCommit },
		]);
		const attempts = completed.log.current().attempts;
		expect(new Set([...attempts.keys()]).size).toBe(attempts.size);
		const finalDiff = completed.checkpoint.evidence.diff;
		if (!finalDiff) throw new Error("final PR diff evidence is missing");
		expect(
			new TextDecoder().decode(await readArtifact(store, finalDiff)),
		).toContain("partial.ts");
	});

	it("recovers an interrupted later phase without replaying an accepted phase", async () => {
		const store = createMemoryRunStore();
		const planMarkdown =
			"# Plan\n\n## Phase 1\nFoundation.\nAcceptance: foundation works.\n\n## Phase 2\nIntegration.\nAcceptance: integration works.\n";
		await sourceRun(store, {
			phases: ["Foundation", "Integration"],
			markdown: planMarkdown,
		});
		const manifest = {
			pr: { id: "pr-1", title: "One" },
			phases: [
				{
					id: "phase-1",
					title: "Foundation",
					planExcerpt: "## Phase 1\nFoundation.",
					acceptanceCriteria: ["Acceptance: foundation works."],
				},
				{
					id: "phase-2",
					title: "Integration",
					planExcerpt: "## Phase 2\nIntegration.",
					acceptanceCriteria: ["Acceptance: integration works."],
				},
			],
			prerequisites: [],
			issues: [],
		};
		const workspace = workspacePort();
		const fixture = await executionSetup(store, [], { workspace });
		const script = multiPhaseRunner(store, workspace, manifest, {
			interruptSecondWriter: true,
		});
		fixture.deps.runner = script.runner;
		const handle = await beginExecution(fixture.deps, fixture.input);
		const controller = new AbortController();
		const running = executeExecution(handle, { signal: controller.signal });
		while (
			script.calls.filter((call) => call.role === "implementer").length < 2
		)
			await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const interrupted = await running;
		expect(interrupted.checkpoint).toMatchObject({
			stage: "Escalated",
			phaseIndex: 1,
			receipts: [expect.anything()],
		});

		const reopened = await openExecution(
			fixture.deps,
			handle.log.current().runId,
		);
		const resumed = await resumeExecution(reopened, {
			signal: new AbortController().signal,
		});
		expect(resumed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		expect(resumed.checkpoint.receipts).toHaveLength(2);
		const implementers = script.calls.filter(
			(call) => call.role === "implementer",
		);
		expect(implementers).toHaveLength(3);
		const recoveryInputs = implementers[2]?.inputs ?? [];
		const diffRef = recoveryInputs.find(
			(item) => item.name === "current-diff",
		)?.ref;
		if (!diffRef) throw new Error("recovery diff input is missing");
		expect(
			new TextDecoder().decode(await readArtifact(store, diffRef)),
		).toContain("partial.ts");
	});

	it("reconciles a final repair commit after a crash without writing another receipt", async () => {
		const store = createMemoryRunStore();
		const planMarkdown =
			"# Plan\n\n## Phase 1\nFoundation.\nAcceptance: foundation works.\n\n## Phase 2\nIntegration.\nAcceptance: integration works.\n";
		await sourceRun(store, {
			phases: ["Foundation", "Integration"],
			markdown: planMarkdown,
		});
		const manifest = {
			pr: { id: "pr-1", title: "One" },
			phases: [
				{
					id: "phase-1",
					title: "Foundation",
					planExcerpt: "## Phase 1\nFoundation.",
					acceptanceCriteria: ["Acceptance: foundation works."],
				},
				{
					id: "phase-2",
					title: "Integration",
					planExcerpt: "## Phase 2\nIntegration.",
					acceptanceCriteria: ["Acceptance: integration works."],
				},
			],
			prerequisites: [],
			issues: [],
		};
		const workspace = workspacePort({ failAfterCommitAt: 3 });
		const fixture = await executionSetup(store, [], { workspace });
		const script = multiPhaseRunner(store, workspace, manifest, {
			finalBlocker: true,
		});
		fixture.deps.runner = script.runner;
		const interrupted = await executeExecution(
			await beginExecution(fixture.deps, fixture.input),
			{ signal: new AbortController().signal },
		);
		expect(interrupted.checkpoint).toMatchObject({
			stage: "Escalated",
			commitIntent: { scope: "final", phaseId: "final" },
			receipts: [expect.anything(), expect.anything()],
		});

		const reopened = await openExecution(
			fixture.deps,
			interrupted.log.current().runId,
		);
		const resumed = await resumeExecution(reopened, {
			signal: new AbortController().signal,
		});
		expect(resumed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		expect(resumed.checkpoint.receipts).toHaveLength(2);
		expect(resumed.checkpoint.workspace?.head).toBe("result-commit-3");
		expect(
			(
				await workspace.port.inspectCommit(
					workspace.path,
					new AbortController().signal,
				)
			).message,
		).toContain("/final");
	});

	it("bounds final repairs separately and never creates another phase receipt", async () => {
		const store = createMemoryRunStore();
		const planMarkdown = [
			"# Plan",
			"",
			"## Phase 1",
			"Foundation.",
			"Acceptance: foundation works.",
			"",
			"## Phase 2",
			"Integration.",
			"Acceptance: integration works.",
			"",
		].join("\n");
		await sourceRun(store, {
			phases: ["Foundation", "Integration"],
			markdown: planMarkdown,
		});
		const manifest = {
			pr: { id: "pr-1", title: "One" },
			phases: [
				{
					id: "phase-1",
					title: "Foundation",
					planExcerpt: "## Phase 1\nFoundation.",
					acceptanceCriteria: ["Acceptance: foundation works."],
				},
				{
					id: "phase-2",
					title: "Integration",
					planExcerpt: "## Phase 2\nIntegration.",
					acceptanceCriteria: ["Acceptance: integration works."],
				},
			],
			prerequisites: [],
			issues: [],
		};
		const workspace = workspacePort();
		let checkRuns = 0;
		const checks: Checks = {
			run: async (_cwd, commands) => {
				checkRuns++;
				return commands.map((command) => ({
					name: command.name,
					status: "passed" as const,
					exitCode: 0,
					stdout: "passed",
					stderr: "",
					truncated: false,
				}));
			},
		};
		const fixture = await executionSetup(store, [], { workspace, checks });
		const script = multiPhaseRunner(store, workspace, manifest, {
			finalBlocker: true,
		});
		fixture.deps.runner = script.runner;
		const completed = await executeExecution(
			await beginExecution(fixture.deps, fixture.input),
			{ signal: new AbortController().signal },
		);

		expect(completed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		expect(completed.checkpoint.receipts).toHaveLength(2);
		expect(checkRuns).toBe(4);
		expect(
			script.calls.filter(
				(call) => call.outputContract === "factory-execution-repair-v1",
			),
		).toHaveLength(1);
		const finalRepair = script.calls.find(
			(call) => call.outputContract === "factory-execution-repair-v1",
		);
		const scopeRef = finalRepair?.inputs.find(
			(item) => item.name === "phase",
		)?.ref;
		if (!scopeRef) throw new Error("final repair scope input is missing");
		expect(
			JSON.parse(new TextDecoder().decode(await readArtifact(store, scopeRef))),
		).toMatchObject({
			scope: "final",
			phases: [{ id: "phase-1" }, { id: "phase-2" }],
		});
		expect(completed.checkpoint.workspace?.head).toBe("result-commit-3");
		expect(
			(
				await workspace.port.inspectCommit(
					workspace.path,
					new AbortController().signal,
				)
			).message,
		).toContain("Payo-Execution:");
	});

	it("exhausts only the final validation budget without replaying accepted phases", async () => {
		const store = createMemoryRunStore();
		const planMarkdown =
			"# Plan\n\n## Phase 1\nFoundation.\nAcceptance: foundation works.\n\n## Phase 2\nIntegration.\nAcceptance: integration works.\n";
		await sourceRun(store, {
			phases: ["Foundation", "Integration"],
			markdown: planMarkdown,
		});
		const manifest = {
			pr: { id: "pr-1", title: "One" },
			phases: [
				{
					id: "phase-1",
					title: "Foundation",
					planExcerpt: "## Phase 1\nFoundation.",
					acceptanceCriteria: ["Acceptance: foundation works."],
				},
				{
					id: "phase-2",
					title: "Integration",
					planExcerpt: "## Phase 2\nIntegration.",
					acceptanceCriteria: ["Acceptance: integration works."],
				},
			],
			prerequisites: [],
			issues: [],
		};
		const workspace = workspacePort();
		let checkRuns = 0;
		const checks: Checks = {
			run: async (_cwd, commands) => {
				checkRuns++;
				return commands.map((command) => ({
					name: command.name,
					status: "passed" as const,
					exitCode: 0,
					stdout: "passed",
					stderr: "",
					truncated: false,
				}));
			},
		};
		const fixture = await executionSetup(store, [], { workspace, checks });
		const script = multiPhaseRunner(store, workspace, manifest, {
			finalBlocker: true,
			repeatFinalBlocker: true,
		});
		fixture.deps.runner = script.runner;
		const escalated = await executeExecution(
			await beginExecution(fixture.deps, fixture.input),
			{ signal: new AbortController().signal },
		);

		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			scope: "final",
			statusDetail: "review-repair-budget-exhausted",
			unresolvedFindingIds: ["architecture:final-design"],
		});
		expect(escalated.checkpoint.receipts).toHaveLength(2);
		expect(checkRuns).toBe(5);
		expect(
			script.calls.filter((call) => call.role === "implementer"),
		).toHaveLength(4);
		expect(escalated.log.current().status).toBe("active");
	});

	it("prepares, implements, checks, reviews every lens, and accepts one phase", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, [
			manifestOutput,
			implementationOutput,
		]);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const completed = await executeExecution(handle, {
			signal: new AbortController().signal,
		});

		expect(completed.checkpoint).toMatchObject({
			stage: "Completed",
			statusDetail: null,
			evidence: {
				diff: expect.anything(),
				checks: expect.anything(),
				review: expect.anything(),
			},
		});
		expect(completed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		const manifestRef = completed.checkpoint.manifest;
		if (!manifestRef) throw new Error("manifest artifact expected");
		const manifest = ExecutionManifest.parse(
			JSON.parse(
				new TextDecoder().decode(await readArtifact(store, manifestRef)),
			),
		);
		expect(manifest.phases).toMatchObject([{ id: "phase-1" }]);
		expect(fixture.calls.slice(0, 2).map((call) => call.role)).toEqual([
			"execution-preparer",
			"implementer",
		]);
		expect(
			fixture.calls.filter((call) =>
				call.role.startsWith("implementation-reviewer:"),
			),
		).toHaveLength(16);
		expect(fixture.calls.map((call) => call.role)).toContain(
			"implementation-verifier",
		);
		expect(fixture.calls[1]?.inputs.map((item) => item.name)).toEqual([
			"role-source",
			"approved-plan",
			"phase",
			"repository-instructions",
		]);
		expect(
			[...completed.log.current().gates.values()].filter(
				(gate) => gate.status === "open",
			),
		).toEqual([]);
	});

	it("repairs a verified P2 architecture blocker and accepts only after clean re-review", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, []);
		const script = reviewRepairRunner();
		fixture.deps.runner = script.runner;
		const handle = await beginExecution(fixture.deps, fixture.input);
		const completed = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(completed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		expect(completed.checkpoint.acceptedFindingIds).toEqual([script.findingId]);
		expect(
			script.calls.filter(
				(call) => call.outputContract === "factory-execution-repair-v1",
			),
		).toHaveLength(1);
		expect(completed.checkpoint.receipts).toHaveLength(1);
	});

	it("discards review evidence if a reviewer mutates the workspace", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, []);
		const script = reviewRepairRunner({
			onArchitectureReview: () => fixture.workspace.mutate(),
		});
		fixture.deps.runner = script.runner;
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "workspace-mutated-during-review",
			evidence: { diff: null, checks: null, review: null },
		});
	});

	it("escalates rather than dropping a finding left unresolved by repair", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, []);
		const script = reviewRepairRunner({ unresolved: true });
		fixture.deps.runner = script.runner;
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(escalated.checkpoint.stage).toBe("Escalated");
		expect(escalated.checkpoint.unresolvedFindingIds).toEqual([
			script.findingId,
		]);
		expect(escalated.log.current().status).toBe("active");
	});

	it("reconciles a matching commit after a crash before receipt persistence", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const workspace = workspacePort({ failAfterCommit: true });
		const fixture = await executionSetup(store, [], { workspace });
		const script = reviewRepairRunner({
			finding: false,
			onImplementation: () => workspace.mutate(),
			scoutFiles: [
				{
					path: "partial.ts",
					purpose: "phase change",
					instructionPaths: ["AGENTS.md"],
				},
			],
		});
		fixture.deps.runner = script.runner;
		const handle = await beginExecution(fixture.deps, fixture.input);
		const interrupted = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(interrupted.checkpoint).toMatchObject({
			stage: "Escalated",
			commitIntent: {
				parent: "abc123",
				tree: "tree-1-0",
				trailer: expect.stringContaining(interrupted.log.current().runId),
			},
		});
		const reopened = await openExecution(
			fixture.deps,
			interrupted.log.current().runId,
		);
		const resumed = await resumeExecution(reopened, {
			signal: new AbortController().signal,
		});
		expect(resumed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
		expect(resumed.checkpoint).toMatchObject({
			stage: "Completed",
			commitIntent: null,
		});
		expect(resumed.checkpoint.receipts).toHaveLength(1);
	});

	it("rejects a preparer manifest that diverges from the approved plan before writing", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, [
			{ ...manifestOutput, pr: { id: "pr-empty", title: "Empty" } },
			implementationOutput,
		]);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: expect.stringContaining("manifest"),
		});
		expect(fixture.calls.map((call) => call.role)).toEqual([
			"execution-preparer",
		]);
		await expect(
			resumeExecution(escalated, { signal: new AbortController().signal }),
		).rejects.toThrow(
			/pinned approved plan.*create and approve a corrected planning run/,
		);
		expect(fixture.calls.map((call) => call.role)).toEqual([
			"execution-preparer",
		]);
	});

	it("escalates implementation output that fails the schema on both attempts", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const invalidImplementation = { summary: "Implemented the boundary." };
		const fixture = await executionSetup(store, [
			manifestOutput,
			invalidImplementation,
			invalidImplementation,
		]);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(
			fixture.calls.filter((call) => call.role === "implementer"),
		).toHaveLength(2);
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "implementation-report-invalid",
			escalation: {
				reason:
					"implementation report could not be validated; edits are preserved for reconciliation",
			},
		});
	});

	it("escalates repair output that fails the schema on both attempts", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const failedChecks: Checks = {
			run: async (_cwd, commands) =>
				commands.map((command) => ({
					name: command.name,
					status: "failed" as const,
					exitCode: 1,
					stdout: "",
					stderr: "failure",
					truncated: false,
				})),
		};
		// A function output is required: the scripted runner replaces object outputs for repair with a valid report.
		const invalidRepair = (_spec: AgentSpec, _signal: AbortSignal) =>
			(async function* () {
				yield {
					type: "result",
					text: JSON.stringify({ summary: "fixed" }),
				} as const;
			})();
		const fixture = await executionSetup(
			store,
			[manifestOutput, implementationOutput, invalidRepair, invalidRepair],
			{ checks: failedChecks },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(
			fixture.calls.filter(
				(call) => call.outputContract === "factory-execution-repair-v1",
			),
		).toHaveLength(2);
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "repair-report-invalid",
		});
	});

	it("does not accept failed checks as completion evidence", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const failedChecks: Checks = {
			run: async (_cwd, commands) =>
				commands.map((command) => ({
					name: command.name,
					status: "failed" as const,
					exitCode: 1,
					stdout: "",
					stderr: "failure",
					truncated: false,
				})),
		};
		const fixture = await executionSetup(
			store,
			[manifestOutput, implementationOutput],
			{ checks: failedChecks },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "checks-repair-budget-exhausted",
		});
		expect([...escalated.log.current().gates.values()][0]).toMatchObject({
			kind: "execution-escalation",
			status: "open",
		});
		fixture.workspace.moveHead();
		await expect(
			resumeExecution(escalated, { signal: new AbortController().signal }),
		).rejects.toThrow(/unexpected HEAD/);
		expect([...escalated.log.current().gates.values()][0]?.status).toBe("open");
	});

	it("keeps a failed execution gated when the retained workspace is lost", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const failedChecks: Checks = {
			run: async (_cwd, commands) =>
				commands.map((command) => ({
					name: command.name,
					status: "failed" as const,
					exitCode: 1,
					stdout: "",
					stderr: "failure",
					truncated: false,
				})),
		};
		const workspace = workspacePort();
		const fixture = await executionSetup(
			store,
			[manifestOutput, implementationOutput],
			{ checks: failedChecks, workspace },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		workspace.port.inspect = async () => {
			throw new Error("worktree missing");
		};
		await expect(
			resumeExecution(escalated, { signal: new AbortController().signal }),
		).rejects.toThrow(/workspace is unavailable/);
		expect([...escalated.log.current().gates.values()][0]?.status).toBe("open");
	});

	it("gates a resumed execution whose reconciliation diff throws instead of rejecting", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const workspace = workspacePort();
		const controller = new AbortController();
		const cancelAfterEdit = (_spec: AgentSpec, _signal: AbortSignal) => {
			workspace.mutate();
			controller.abort();
			return (async function* () {})();
		};
		const fixture = await executionSetup(
			store,
			[manifestOutput, cancelAfterEdit],
			{ workspace },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: controller.signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "execution-cancelled",
		});
		workspace.port.diff = async () => {
			throw new Error("diff unavailable");
		};

		const reopened = await openExecution(
			fixture.deps,
			handle.log.current().runId,
		);
		const resumed = await resumeExecution(reopened, {
			signal: new AbortController().signal,
		});
		expect(resumed.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "execution-failed",
			escalation: { reason: "execution failed safely: diff unavailable" },
		});
		const openGates = [...resumed.log.current().gates.values()].filter(
			(gate) => gate.status === "open",
		);
		expect(openGates).toHaveLength(1);
	});

	it("repairs a check failure, reruns checks, and proceeds through independent review", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		let shouldPass = false;
		let checkRuns = 0;
		const changingChecks: Checks = {
			run: async (_cwd, commands) => {
				checkRuns++;
				return commands.map((command) => ({
					name: command.name,
					status: shouldPass ? ("passed" as const) : ("failed" as const),
					exitCode: shouldPass ? 0 : 1,
					stdout: "",
					stderr: shouldPass ? "" : "failure",
					truncated: false,
				}));
			},
		};
		const repair: (spec: AgentSpec) => AsyncIterable<AgentEvent> = (_spec) =>
			(async function* () {
				shouldPass = true;
				yield {
					type: "result",
					text: JSON.stringify({
						summary: "fixed check failure",
						addressedFindingIds: [],
						unresolvedFindingIds: [],
						planIssues: [],
					}),
				} as const;
			})();
		const fixture = await executionSetup(
			store,
			[manifestOutput, implementationOutput, repair],
			{ checks: changingChecks },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const completed = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(checkRuns).toBe(3);
		expect(
			fixture.calls.filter((call) => call.role === "implementer"),
		).toHaveLength(2);
		expect(completed.log.current()).toMatchObject({
			status: "ended",
			outcome: "reviewed",
		});
	});

	it("reconciles edits left by an interrupted writer and resumes from the current diff", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const workspace = workspacePort();
		const interrupted: (
			spec: AgentSpec,
			signal: AbortSignal,
		) => AsyncIterable<AgentEvent> = (_spec, signal) =>
			(async function* () {
				workspace.mutate();
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			})();
		const scopedPaths = {
			summary: "Partial implementation touches one file.",
			files: [
				{
					path: "partial.ts",
					purpose: "partial work",
					instructionPaths: ["AGENTS.md"],
				},
			],
			planIssues: [],
		};
		const fixture = await executionSetup(
			store,
			[manifestOutput, interrupted, implementationOutput, scopedPaths],
			{ workspace },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const controller = new AbortController();
		const running = executeExecution(handle, { signal: controller.signal });
		while (fixture.calls.length < 2)
			await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const interruptedRun = await running;
		expect(interruptedRun.checkpoint.stage).toBe("Escalated");

		const reopened = await openExecution(
			fixture.deps,
			handle.log.current().runId,
		);
		const resumed = await resumeExecution(reopened, {
			signal: new AbortController().signal,
		});
		expect(resumed.checkpoint.stage).toBe("Completed");
		const currentDiffRef = fixture.calls[2]?.inputs.find(
			(item) => item.name === "current-diff",
		)?.ref;
		if (!currentDiffRef)
			throw new Error("reconciliation diff artifact expected");
		expect(
			new TextDecoder().decode(await readArtifact(store, currentDiffRef)),
		).toContain("partial.ts");
	});

	it("restarts checks when they mutate the worktree and escalates after three dirty cycles", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const workspace = workspacePort();
		let runs = 0;
		const mutatingChecks: Checks = {
			run: async (_cwd, commands) => {
				runs++;
				workspace.mutate();
				return commands.map((command) => ({
					name: command.name,
					status: "passed" as const,
					exitCode: 0,
					stdout: "passed",
					stderr: "",
					truncated: false,
				}));
			},
		};
		const fixture = await executionSetup(
			store,
			[
				manifestOutput,
				implementationOutput,
				implementationOutput,
				implementationOutput,
			],
			{ workspace, checks: mutatingChecks },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(runs).toBe(3);
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "checks-kept-modifying-workspace",
		});
		expect(
			fixture.calls.filter((call) => call.role === "implementer"),
		).toHaveLength(1);
	});

	it("gates on an unexpected branch head without discarding the implementation", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const workspace = workspacePort();
		const moveHeadDuringWrite = (_spec: AgentSpec, _signal: AbortSignal) =>
			(async function* () {
				workspace.mutate();
				workspace.moveHead();
				yield {
					type: "result",
					text: JSON.stringify(implementationOutput),
				} as const;
			})();
		const outputs = [manifestOutput, moveHeadDuringWrite];
		const fixture = await executionSetup(store, outputs, { workspace });
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: new AbortController().signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "unexpected-git-history",
		});
		expect(
			(
				await fixture.workspace.port.inspect(
					fixture.workspace.path,
					new AbortController().signal,
				)
			).changedPaths,
		).toContain("partial.ts");
	});

	it("records an operator cancel during implementation as cancelled, not invalid output", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const controller = new AbortController();
		const cancelDuringWrite = (_spec: AgentSpec, _signal: AbortSignal) => {
			controller.abort();
			return (async function* () {})();
		};
		const fixture = await executionSetup(store, [
			manifestOutput,
			cancelDuringWrite,
		]);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: controller.signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "execution-cancelled",
			escalation: {
				reason:
					"execution cancelled during Implement; inspect the retained workspace and resume",
			},
		});
	});

	it("records an operator cancel during manifest preparation as cancelled, not invalid output", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const controller = new AbortController();
		const cancelDuringPreparer = (_spec: AgentSpec, _signal: AbortSignal) => {
			controller.abort();
			return (async function* () {})();
		};
		const fixture = await executionSetup(store, [cancelDuringPreparer]);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: controller.signal,
		});
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "execution-cancelled",
			escalation: {
				reason:
					"execution cancelled during Prepare; inspect the retained workspace and resume",
			},
		});
	});

	it("rejects a pre-aborted execution before any writer or failure gate", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, [
			manifestOutput,
			implementationOutput,
		]);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const controller = new AbortController();
		controller.abort();

		await expect(
			executeExecution(handle, { signal: controller.signal }),
		).rejects.toThrow(/execution cancelled/);
		expect(handle.checkpoint.stage).not.toBe("Escalated");
		expect(handle.log.current().gates.size).toBe(0);
		expect(fixture.calls).toEqual([]);
	});

	it("records an operator cancel during repair as cancelled, not invalid output", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const failedChecks: Checks = {
			run: async (_cwd, commands) =>
				commands.map((command) => ({
					name: command.name,
					status: "failed" as const,
					exitCode: 1,
					stdout: "",
					stderr: "failure",
					truncated: false,
				})),
		};
		const controller = new AbortController();
		const cancelDuringRepair = (_spec: AgentSpec, _signal: AbortSignal) => {
			controller.abort();
			return (async function* () {})();
		};
		const fixture = await executionSetup(
			store,
			[manifestOutput, implementationOutput, cancelDuringRepair],
			{ checks: failedChecks },
		);
		const handle = await beginExecution(fixture.deps, fixture.input);
		const escalated = await executeExecution(handle, {
			signal: controller.signal,
		});
		expect(fixture.calls).toHaveLength(3);
		expect(fixture.calls[2]?.outputContract).toBe(
			"factory-execution-repair-v1",
		);
		expect(escalated.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "execution-cancelled",
			escalation: {
				reason:
					"execution cancelled during Repair; inspect the retained workspace and resume",
			},
		});
	});

	it("reconciles a worktree created before preparation checkpoint persistence", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const workspace = workspacePort();
		const prepare = workspace.port.prepare.bind(workspace.port);
		let failAfterCreate = true;
		workspace.port.prepare = async (input, signal) => {
			const prepared = await prepare(input, signal);
			if (failAfterCreate) {
				failAfterCreate = false;
				throw new Error("simulated crash after worktree creation");
			}
			return prepared;
		};
		const fixture = await executionSetup(
			store,
			[manifestOutput, implementationOutput],
			{ workspace },
		);
		const accepted = await beginExecution(fixture.deps, fixture.input);
		const interrupted = await executeExecution(accepted, {
			signal: new AbortController().signal,
		});
		expect(interrupted.checkpoint).toMatchObject({
			stage: "Escalated",
			workspace: null,
			statusDetail: "workspace-preparation-failed",
		});

		const reopened = await openExecution(
			fixture.deps,
			accepted.log.current().runId,
		);
		const resumed = await resumeExecution(reopened, {
			signal: new AbortController().signal,
		});
		expect(resumed.checkpoint.stage).toBe("Completed");
		expect(fixture.calls.map((call) => call.role).slice(0, 2)).toEqual([
			"execution-preparer",
			"implementer",
		]);
	});

	it("recovers a durable accepted execution and waits at the review boundary", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const fixture = await executionSetup(store, [
			manifestOutput,
			implementationOutput,
		]);
		const accepted = await beginExecution(fixture.deps, fixture.input);
		const recovered = await openExecution(
			fixture.deps,
			accepted.log.current().runId,
		);
		expect(recovered.checkpoint).toMatchObject({
			stage: "Escalated",
			statusDetail: "restart-reconciliation-required",
		});
		const resumed = await resumeExecution(recovered, {
			signal: new AbortController().signal,
		});
		expect(resumed.checkpoint.stage).toBe("Completed");
	});

	it("rejects resume when the execution is not escalated", async () => {
		const store = createMemoryRunStore();
		await sourceRun(store);
		const handle = await beginExecution(
			{ store, newId: () => crypto.randomUUID() },
			input(),
		);
		await expect(
			resumeExecution(handle, { signal: new AbortController().signal }),
		).rejects.toThrow(/not resumable/);
	});
});
