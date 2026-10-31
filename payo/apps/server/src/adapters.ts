import { join } from "node:path";
import type { Ticket } from "@payo/contracts";
import type { RoleSource } from "@payo/factory";
import { createGitExec, createGitWorkspace } from "@payo/git";
import { createAcliTicketSource } from "@payo/jira-acli";
import type { AgentRunner, TicketSource, Workspace } from "@payo/kernel";
import type { FakeStep } from "@payo/runner-fake";
import { createPiRunner } from "@payo/runner-pi";
import type { ServerConfig } from "./config.ts";
import {
	createFakeRunner,
	envelope,
	fakeTickets,
	fakeWorkspace,
} from "./factory-fixtures.ts";
import { loadRoleSources } from "./role-sources.ts";

export type Scenario = "clean" | "hang-planner" | "clean-twice";
const SCENARIOS = new Set<Scenario>(["clean", "hang-planner", "clean-twice"]);

export interface AdapterSet {
	runner: () => AgentRunner;
	tickets: TicketSource;
	workspace: Workspace;
	roleSources: Record<
		"planner" | "reviewer" | "verifier" | "reviser",
		RoleSource
	>;
}

const ticket: Ticket = {
	key: "ABC-123",
	title: "Synthetic dev ticket",
	description: "Fake ticket used by the dev server.",
	url: null,
};

const plan = {
	markdown: "# Plan\n\nOne open question.\n",
	prStrategy: [{ id: "pr-1", title: "First change", phases: [] }],
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
			return [envelope(plan), ...cleanReview()];
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

function scenarioOf(config: ServerConfig): Scenario {
	const name = (config.scenario ?? "clean") as Scenario;
	if (!SCENARIOS.has(name)) throw new Error(`unknown fake scenario ${name}`);
	return name;
}

export async function createAdapterSet(
	config: ServerConfig,
): Promise<AdapterSet> {
	if (config.devFakes) {
		const scenario = scenarioOf(config);
		return {
			runner: () => createFakeRunner(scriptsFor(scenario)),
			tickets: fakeTickets([ticket]),
			workspace: fakeWorkspace(join(config.dataDir, "workspaces")),
			roleSources: fakeRoleSources,
		};
	}
	if (config.model === null)
		throw new Error("PAYO_MODEL is required in real mode");
	const gitExec = createGitExec({ bin: config.gitBin });
	const pi = createPiRunner({
		bin: config.piBin,
		provider: config.piProvider,
		sessionRoot: join(config.dataDir, "sessions"),
	});
	return {
		runner: () => pi,
		tickets: createAcliTicketSource({ bin: config.acliBin }),
		workspace: createGitWorkspace({
			root: join(config.dataDir, "worktrees"),
			bin: config.gitBin,
			exec: gitExec,
		}),
		roleSources: await loadRoleSources(config.repo, config.baseBranch, gitExec),
	};
}
