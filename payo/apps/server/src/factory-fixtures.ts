import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentEvent,
	type AgentSpec,
	GitHubTarget,
	PullRequestRecord,
	type WorkItem,
	type WorkItemRequest,
} from "@payo/contracts";
import type {
	AgentRunner,
	CodeHost,
	ExecutionWorkspace,
	RepositoryPublication,
	RunStore,
	WorkItemSource,
	Workspace,
} from "@payo/kernel";
import { createFakeRunner, type FakeStep } from "@payo/runner-fake";

export function fakeWorkItems(items: WorkItem[]): WorkItemSource {
	return {
		async resolve(request: WorkItemRequest) {
			if (request.source !== "jira")
				throw new Error(`unsupported fixture source ${request.source}`);
			const item = items.find(
				(candidate) =>
					candidate.origin.source === "jira" &&
					candidate.origin.key === request.key,
			);
			if (!item) throw new Error(`work item ${request.key} not found`);
			return structuredClone(item);
		},
	};
}
export function fakeWorkspace(root: string): Workspace {
	return {
		async create(runId) {
			return `${root}/${runId}`;
		},
		async remove() {},
	};
}
export function envelope(value: unknown): FakeStep[] {
	return [
		{ kind: "emit", event: { type: "result", text: JSON.stringify(value) } },
	];
}
export { createFakeRunner };

export const SCENARIOS = [
	"clean",
	"hang-planner",
	"clean-twice",
	"execution-interruption",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

// The base is a valid full SHA so fake executions exercise the real publication contracts.
export const FAKE_BASE_COMMIT = "0".repeat(40);

interface FakeCommit {
	head: string;
	message: string;
}

interface FakeExecutionWorkspaceState {
	branch?: string;
	head: string;
	commitNumber: number;
	commit: {
		head: string;
		parent: string;
		tree: string;
		message: string;
	} | null;
	commits?: FakeCommit[];
}

const fakeStatePath = (workspacePath: string) =>
	join(workspacePath, ".payo-fake-state.json");

const emptyFakeState = (): FakeExecutionWorkspaceState => ({
	head: FAKE_BASE_COMMIT,
	commitNumber: 0,
	commit: null,
	commits: [],
});

async function readFakeState(
	workspacePath: string,
): Promise<FakeExecutionWorkspaceState> {
	try {
		return JSON.parse(
			await readFile(fakeStatePath(workspacePath), "utf8"),
		) as FakeExecutionWorkspaceState;
	} catch {
		return emptyFakeState();
	}
}

export function fakeExecutionWorkspace(root: string): ExecutionWorkspace {
	const statePath = fakeStatePath;
	const readState = readFakeState;
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
			return FAKE_BASE_COMMIT;
		},
		async prepare(input) {
			const path = join(root, input.executionId);
			await mkdir(path, { recursive: true });
			try {
				await readFile(statePath(path), "utf8");
			} catch {
				await writeState(path, {
					head: input.baseCommit,
					branch: input.branch,
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
				branch: state.branch ?? `payo/${workspacePath.split(/[\\/]/).at(-1)}`,
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
			const head = (state.commitNumber + 1).toString(16).padStart(40, "0");
			state.commitNumber++;
			state.commit = {
				head,
				parent: expectation.parent,
				tree: expectation.tree,
				message,
			};
			state.commits = [...(state.commits ?? []), { head, message }];
			state.head = head;
			await writeState(workspacePath, state);
			await rm(join(workspacePath, "synthetic.ts"), { force: true });
			return head;
		},
	};
}

/** Deterministic same-repository publication ports for fake mode; no network or gh binary. */
export function fakePublicationPorts(): {
	repository: RepositoryPublication;
	codeHost: CodeHost;
} {
	const refs = new Map<string, string>();
	const pullRequests: PullRequestRecord[] = [];
	let nextNumber = 1;
	const target = (baseBranch: string): GitHubTarget =>
		GitHubTarget.parse({
			host: "github.com",
			owner: "payo-fake",
			name: "repo",
			repositoryId: "1",
			baseBranch,
			baseCommit: FAKE_BASE_COMMIT,
		});
	return {
		repository: {
			async resolveRemote() {
				return {
					fetchUrl: "https://github.com/payo-fake/repo.git",
					pushUrl: "https://github.com/payo-fake/repo.git",
				};
			},
			async readCommits(path) {
				const state = await readFakeState(path);
				const commits = state.commits ?? (state.commit ? [state.commit] : []);
				return commits.map((commit) => ({
					sha: commit.head,
					subject: commit.message.split("\n")[0] ?? "",
					message: commit.message,
				}));
			},
			async readRemoteHead(_pushUrl, branch) {
				return refs.get(branch) ?? null;
			},
			async pushCommit(_path, _pushUrl, branch, commit) {
				if (refs.has(branch))
					throw new Error("publication remote branch already exists");
				refs.set(branch, commit);
			},
		},
		codeHost: {
			async resolveRepository(_remoteUrl, baseBranch) {
				return target(baseBranch);
			},
			async findPullRequests(value, headBranch) {
				return pullRequests.filter(
					(pr) =>
						pr.owner === value.owner &&
						pr.name === value.name &&
						pr.baseBranch === value.baseBranch &&
						pr.headBranch === headBranch,
				);
			},
			async createDraftPullRequest(value, input, signal) {
				signal.throwIfAborted();
				const headCommit = refs.get(input.headBranch);
				if (!headCommit) throw new Error("remote branch is missing");
				const number = nextNumber++;
				pullRequests.push(
					PullRequestRecord.parse({
						number,
						url: `https://github.com/${value.owner}/${value.name}/pull/${number}`,
						owner: value.owner,
						name: value.name,
						baseBranch: value.baseBranch,
						headBranch: input.headBranch,
						headCommit,
						state: "OPEN",
						draft: true,
						title: input.title,
						body: input.body,
					}),
				);
			},
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

export function fakeExecutionRunner(
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
