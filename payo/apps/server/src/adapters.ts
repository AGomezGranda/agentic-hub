import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProcessChecks } from "@payo/checks-process";
import type {
	AgentEvent,
	AgentSpec,
	WorkItem,
	WorkItemRequest,
} from "@payo/contracts";
import type { RoleSource } from "@payo/factory";
import { EXECUTION_PREPARER_SOURCE } from "@payo/factory";
import {
	createExecutionWorkspace,
	createGitExec,
	createGitWorkspace,
} from "@payo/git";
import { createAcliTicketSource } from "@payo/jira-acli";
import type {
	AgentRunner,
	Checks,
	ExecutionWorkspace,
	RunStore,
	WorkItemSource,
	Workspace,
} from "@payo/kernel";
import type { FakeStep } from "@payo/runner-fake";
import { createPiRunner } from "@payo/runner-pi";
import { assertRealModeModels, type ServerConfig } from "./config.ts";
import {
	createFakeRunner,
	envelope,
	fakeWorkItems,
	fakeWorkspace,
} from "./factory-fixtures.ts";
import { loadExecutionRoleSources, loadRoleSources } from "./role-sources.ts";

export type Scenario =
	| "clean"
	| "hang-planner"
	| "clean-twice"
	| "execution-interruption";
const SCENARIOS = new Set<Scenario>([
	"clean",
	"hang-planner",
	"clean-twice",
	"execution-interruption",
]);

export interface AdapterSet {
	runner: () => AgentRunner;
	workItems: WorkItemSource;
	workspace: Workspace;
	roleSources: Record<
		"planner" | "reviewer" | "verifier" | "reviser",
		RoleSource
	>;
	executionRunner?: () => AgentRunner;
	executionWorkspace?: ExecutionWorkspace;
	checks?: Checks;
	loadExecutionRoleSources?: (
		repo?: string,
		base?: string,
	) => Promise<
		Record<
			"preparer" | "implementer" | "scout" | "reviewer" | "verifier",
			RoleSource
		>
	>;
}

const workItem: WorkItem = {
	origin: { source: "jira", key: "ABC-123", url: null },
	title: "Synthetic dev ticket",
	description: "Fake ticket used by the dev server.",
};

const plan = {
	markdown:
		"# Plan\n\n## Phase 1\nImplement the synthetic foundation.\n\nAcceptance: synthetic foundation works.\n\n## Phase 2\nImplement the synthetic integration.\n\nAcceptance: synthetic integration works.\n",
	prStrategy: [
		{
			id: "pr-1",
			title: "First change",
			phases: [
				"Implement the synthetic foundation.",
				"Implement the synthetic integration.",
			],
		},
	],
	openQuestions: [{ id: "q1", question: "Why this approach?" }],
};

function cleanReview(): FakeStep[][] {
	return [
		...Array.from({ length: 7 }, () => envelope({ findings: [] })),
		envelope({ verdicts: [] }),
	];
}

function scriptsFor(scenario: Scenario): FakeStep[][] {
	switch (scenario) {
		case "hang-planner":
			return [[{ kind: "hang" }], envelope(plan), ...cleanReview()];
		case "clean-twice":
			return [envelope(plan), ...cleanReview(), ...cleanReview()];
		case "clean":
		case "execution-interruption":
			return [
				envelope(plan),
				...cleanReview(),
				envelope({
					plan: { ...plan, markdown: "# Revised plan\n" },
					unreconciledFindingIds: [],
				}),
				...cleanReview(),
				...cleanReview(),
			];
	}
}

function roleSource(content: string): RoleSource {
	return {
		path: `synthetic/factory-${content}.md`,
		sha: `synthetic-${content}-v1`,
		content: `Synthetic ${content} role for dev fakes.`,
		resources: {},
	};
}

const fakeRoleSources = {
	planner: roleSource("planner"),
	reviewer: roleSource("reviewer"),
	verifier: roleSource("verifier"),
	reviser: roleSource("reviser"),
};

const fakeExecutionRoleSources = {
	preparer: EXECUTION_PREPARER_SOURCE,
	implementer: roleSource("implementer"),
	scout: roleSource("scout"),
	reviewer: roleSource("implementation-reviewer"),
	verifier: roleSource("implementation-verifier"),
};

interface FakeExecutionWorkspaceState {
	head: string;
	commitNumber: number;
	commit: {
		head: string;
		parent: string;
		tree: string;
		message: string;
	} | null;
}

function fakeExecutionWorkspace(root: string): ExecutionWorkspace {
	const statePath = (workspacePath: string) =>
		join(workspacePath, ".payo-fake-state.json");
	const readState = async (workspacePath: string) => {
		try {
			return JSON.parse(
				await readFile(statePath(workspacePath), "utf8"),
			) as FakeExecutionWorkspaceState;
		} catch {
			return {
				head: "fake-base-commit",
				commitNumber: 0,
				commit: null,
			};
		}
	};
	const writeState = (
		workspacePath: string,
		state: FakeExecutionWorkspaceState,
	) => writeFile(statePath(workspacePath), JSON.stringify(state));
	const changedContent = async (workspacePath: string) => {
		try {
			return await readFile(join(workspacePath, "synthetic.ts"), "utf8");
		} catch {
			return "";
		}
	};
	return {
		async resolveBase() {
			return "fake-base-commit";
		},
		async prepare(input) {
			const path = join(root, input.executionId);
			await mkdir(path, { recursive: true });
			try {
				await readFile(statePath(path), "utf8");
			} catch {
				await writeState(path, {
					head: input.baseCommit,
					commitNumber: 0,
					commit: null,
				});
			}
			return {
				path,
				branch: input.branch,
				baseCommit: input.baseCommit,
			};
		},
		async inspect(workspacePath) {
			const state = await readState(workspacePath);
			const content = await changedContent(workspacePath);
			return {
				head: state.head,
				branch: `payo/${workspacePath.split(/[\\/]/).at(-1)}`,
				fingerprint: `${state.head}:${content}`,
				changedPaths: content ? ["synthetic.ts"] : [],
				historyFingerprint: `fake-history-${state.commitNumber}`,
			};
		},
		async diff() {
			return "diff --git a/synthetic.ts b/synthetic.ts\n+synthetic\n";
		},
		async verifyPrerequisites(_repo, _baseCommit, prerequisites) {
			return prerequisites.map((item) => ({
				description: item.description,
				present: true,
				reason: null,
			}));
		},
		async instructions() {
			return {};
		},
		async prepareCommit(workspacePath, expectedSnapshot) {
			const state = await readState(workspacePath);
			return {
				parent: state.head,
				tree: `fake-tree-${state.commitNumber + 1}`,
				expectedSnapshot,
				changed: (await changedContent(workspacePath)).length > 0,
			};
		},
		async inspectCommit(workspacePath) {
			const state = await readState(workspacePath);
			return (
				state.commit ?? {
					head: state.head,
					parent: null,
					tree: "fake-tree-base",
					message: "",
				}
			);
		},
		async commit(workspacePath, _expected, message, _signal, expectation) {
			const state = await readState(workspacePath);
			if (!expectation) throw new Error("durable commit intent is required");
			const head = `fake-result-commit-${state.commitNumber + 1}`;
			state.commitNumber++;
			state.commit = {
				head,
				parent: expectation.parent,
				tree: expectation.tree,
				message,
			};
			state.head = head;
			await writeState(workspacePath, state);
			await rm(join(workspacePath, "synthetic.ts"), { force: true });
			return head;
		},
	};
}

async function readAgentInput(
	store: Pick<RunStore, "readArtifact">,
	spec: AgentSpec,
	name: string,
): Promise<unknown> {
	const ref = spec.inputs.find((item) => item.name === name)?.ref;
	if (!ref) throw new Error(`fake execution input ${name} is missing`);
	return JSON.parse(
		new TextDecoder().decode(await store.readArtifact(ref.sha256)),
	);
}

function fakeExecutionRunner(
	store: Pick<RunStore, "readArtifact">,
	scenario: Scenario,
	dataDir: string,
): AgentRunner {
	const interruptedMarker = join(dataDir, "fake-execution-phase-2-interrupted");
	return {
		id: "payo-dev-execution-fake",
		run(spec: AgentSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
			return (async function* () {
				let output: unknown;
				if (spec.role === "execution-preparer") {
					output = {
						pr: { id: "pr-1", title: "First change" },
						phases: [
							{
								id: "phase-1",
								title: "Synthetic foundation",
								planExcerpt: "## Phase 1\nImplement the synthetic foundation.",
								acceptanceCriteria: ["Acceptance: synthetic foundation works."],
							},
							{
								id: "phase-2",
								title: "Synthetic integration",
								planExcerpt: "## Phase 2\nImplement the synthetic integration.",
								acceptanceCriteria: [
									"Acceptance: synthetic integration works.",
								],
							},
						],
						prerequisites: [],
						issues: [],
					};
				} else if (spec.role === "implementer") {
					if (spec.outputContract === "factory-execution-repair-v1") {
						output = {
							summary: "Rechecked synthetic changes.",
							addressedFindingIds: [],
							unresolvedFindingIds: [],
							planIssues: [],
						};
					} else {
						const phaseInput = (await readAgentInput(store, spec, "phase")) as {
							phase: { id: string; acceptanceCriteria: string[] };
						};
						await mkdir(spec.cwd, { recursive: true });
						await writeFile(
							join(spec.cwd, "synthetic.ts"),
							`export const phase = ${JSON.stringify(phaseInput.phase.id)};\n`,
						);
						if (
							scenario === "execution-interruption" &&
							phaseInput.phase.id === "phase-2"
						) {
							let interrupted = false;
							try {
								await readFile(interruptedMarker, "utf8");
							} catch {
								interrupted = true;
								await writeFile(interruptedMarker, "interrupted");
							}
							if (interrupted && !signal.aborted)
								await new Promise<void>((resolve) =>
									signal.addEventListener("abort", () => resolve(), {
										once: true,
									}),
								);
							if (interrupted) return;
						}
						output = {
							summary: `Implemented ${phaseInput.phase.id}`,
							completedCriteria: phaseInput.phase.acceptanceCriteria,
							planIssues: [],
						};
					}
				} else if (spec.role === "implementation-scout") {
					output = {
						summary: "Mapped the captured synthetic change.",
						files: [
							{
								path: "synthetic.ts",
								purpose: "synthetic implementation",
								instructionPaths: [],
							},
						],
						planIssues: [],
					};
				} else if (spec.role.startsWith("implementation-reviewer:")) {
					output = {
						checked: ["synthetic diff and configured checks"],
						findings: [],
					};
				} else if (spec.role === "implementation-verifier") {
					output = { verdicts: [], planIssues: [] };
				} else {
					throw new Error(`unsupported fake execution role ${spec.role}`);
				}
				yield { type: "result", text: JSON.stringify(output) };
			})();
		},
	};
}
function scenarioOf(config: ServerConfig): Scenario {
	const name = (config.scenario ?? "clean") as Scenario;
	if (!SCENARIOS.has(name)) throw new Error(`unknown fake scenario ${name}`);
	return name;
}

type JiraWorkItemRequest = Extract<WorkItemRequest, { source: "jira" }>;

export function createWorkItemSource(
	jira: WorkItemSource<JiraWorkItemRequest>,
): WorkItemSource {
	return {
		resolve(request: WorkItemRequest) {
			if (request.source === "prompt")
				return Promise.resolve({
					origin: { source: "prompt" },
					title: "Direct prompt",
					description: request.text,
				});
			return jira.resolve(request);
		},
	};
}

export async function createAdapterSet(
	config: ServerConfig,
	store: Pick<RunStore, "readArtifact">,
): Promise<AdapterSet> {
	if (config.devFakes) {
		const scenario = scenarioOf(config);
		return {
			runner: () => createFakeRunner(scriptsFor(scenario)),
			workItems: createWorkItemSource(fakeWorkItems([workItem])),
			workspace: fakeWorkspace(join(config.dataDir, "workspaces")),
			roleSources: fakeRoleSources,
			executionRunner: () =>
				fakeExecutionRunner(store, scenario, config.dataDir),
			executionWorkspace: fakeExecutionWorkspace(
				join(config.dataDir, "worktrees"),
			),
			checks: {
				run: async (_cwd, commands) =>
					commands.map((item) => ({
						name: item.name,
						status: "passed" as const,
						exitCode: 0,
						stdout: "fake check passed",
						stderr: "",
						truncated: false,
					})),
			},
			loadExecutionRoleSources: async () => fakeExecutionRoleSources,
		};
	}
	assertRealModeModels(config);
	const gitExec = createGitExec({ bin: config.gitBin });
	const pi = createPiRunner({
		bin: config.piBin,
		provider: config.piProvider,
		sessionRoot: join(config.dataDir, "sessions"),
		readArtifact: (sha256) => store.readArtifact(sha256),
	});
	return {
		runner: () => pi,
		workItems: createWorkItemSource(
			createAcliTicketSource({ bin: config.acliBin }),
		),
		workspace: createGitWorkspace({
			root: join(config.dataDir, "worktrees"),
			bin: config.gitBin,
			exec: gitExec,
		}),
		roleSources: await loadRoleSources(config.repo, config.baseBranch, gitExec),
		executionRunner: () => pi,
		executionWorkspace: createExecutionWorkspace({
			root: join(config.dataDir, "worktrees"),
			bin: config.gitBin,
			exec: gitExec,
		}),
		checks: createProcessChecks(),
		loadExecutionRoleSources: (repo = config.repo, base = config.baseBranch) =>
			loadExecutionRoleSources(repo, base, gitExec),
	};
}
