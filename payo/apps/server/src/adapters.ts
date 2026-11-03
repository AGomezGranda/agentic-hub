import { join } from "node:path";
import { createProcessChecks } from "@payo/checks-process";
import type { WorkItem, WorkItemRequest } from "@payo/contracts";
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
	fakeExecutionRunner,
	fakeExecutionWorkspace,
	fakeWorkItems,
	fakeWorkspace,
	SCENARIOS,
	type Scenario,
} from "./factory-fixtures.ts";
import { loadExecutionRoleSources, loadRoleSources } from "./role-sources.ts";

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

function scenarioOf(config: ServerConfig): Scenario {
	const name = config.scenario ?? "clean";
	const scenario = SCENARIOS.find((item) => item === name);
	if (scenario === undefined) throw new Error(`unknown fake scenario ${name}`);
	return scenario;
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
