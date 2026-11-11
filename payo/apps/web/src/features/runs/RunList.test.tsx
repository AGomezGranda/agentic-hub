import { RunSummary as RunSummarySchema } from "@payo/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RunList } from "./RunList.tsx";

const RUN_A = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const RUN_B = "7f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const RUN_C = "8f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const RUN_D = "9f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";

function runSummary(
	runId: string,
	options: {
		repo?: string;
		status?: "active" | "ended";
		stage?: string | null;
		openGates?: Array<{
			gateId: string;
			stepId: string;
			kind: string;
			allowedCommands: string[];
			reason: string;
		}>;
		title?: string;
	} = {},
) {
	return RunSummarySchema.parse({
		runId,
		repo: options.repo ?? "/work/repo",
		baseBranch: "main",
		status: options.status ?? "active",
		outcome: null,
		stage: options.stage === undefined ? "Plan" : options.stage,
		workItem: {
			source: "jira",
			title: options.title ?? "Repair the widget",
			key: "ABC-123",
		},
		startedAt: "2026-10-30T00:00:00.000Z",
		updatedAt: "2026-10-30T00:00:00.000Z",
		openGates: options.openGates ?? [],
	});
}

const gate = (suffix: string) => ({
	gateId: `gate-${suffix}`,
	stepId: `step-${suffix}`,
	kind: "approval",
	allowedCommands: ["continue"],
	reason: "Approval required",
});

afterEach(cleanup);

it("selects runs from links and the narrow-screen selector", async () => {
	const user = userEvent.setup();
	const onSelect = vi.fn();
	const runs = [
		runSummary(RUN_A),
		runSummary(RUN_B, { stage: "FutureServerStage" }),
	];
	render(
		<RunList
			runs={runs}
			isPending={false}
			selectedRunId={RUN_A}
			onSelect={onSelect}
		/>,
	);
	const firstRunLink = screen.getAllByRole("link", {
		name: /Repair the widget/,
	})[0];
	if (!firstRunLink) throw new Error("expected a run link");
	await user.click(firstRunLink);
	expect(onSelect).toHaveBeenCalledWith(RUN_A);

	const selector = screen.getByRole("combobox", { name: "Select run" });
	await user.selectOptions(selector, RUN_B);
	expect(onSelect).toHaveBeenLastCalledWith(RUN_B);
	expect(screen.getByText("FutureServerStage")).toBeInTheDocument();
});

it("shows status groups in order with counts for the loaded list", () => {
	render(
		<RunList
			runs={[
				runSummary(RUN_A, { openGates: [gate("one")] }),
				runSummary(RUN_B),
				runSummary(RUN_C, { status: "ended" }),
			]}
			isPending={false}
			onSelect={() => {}}
		/>,
	);
	const headings = screen.getAllByRole("heading", { level: 3 });
	expect(headings.map((heading) => heading.textContent)).toEqual([
		"Needs you · 1",
		"Active · 1",
		"Ended · 1",
	]);
	expect(screen.getByText(/loaded work items/i)).toBeInTheDocument();
});

it("groups by exact repository path in lexical order and preserves run order", async () => {
	const user = userEvent.setup();
	render(
		<RunList
			runs={[
				runSummary(RUN_A, { repo: "/work/z/project", title: "Z first" }),
				runSummary(RUN_B, { repo: "/work/a/project", title: "A only" }),
				runSummary(RUN_C, { repo: "/work/z/project", title: "Z second" }),
				runSummary(RUN_D, { repo: "/work/b/project", title: "B only" }),
			]}
			isPending={false}
			onSelect={() => {}}
		/>,
	);
	await user.click(screen.getByRole("radio", { name: "Repository" }));

	const groups = screen
		.getAllByRole("region")
		.filter((region) =>
			region.getAttribute("aria-label")?.startsWith("/work/"),
		);
	expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
		"/work/a/project",
		"/work/b/project",
		"/work/z/project",
	]);
	const firstGroup = groups[0];
	const lastGroup = groups[2];
	if (!firstGroup || !lastGroup) throw new Error("expected repository groups");
	const firstHeading = within(firstGroup).getByRole("heading", { level: 3 });
	const lastHeading = within(lastGroup).getByRole("heading", { level: 3 });
	expect(
		within(firstHeading).getByText("project", { exact: true }),
	).toBeInTheDocument();
	expect(
		within(firstHeading).getByText("/work/a/project", { exact: true }),
	).toBeInTheDocument();
	expect(firstHeading).toHaveTextContent("1 work item");
	expect(
		within(lastHeading).getByText("project", { exact: true }),
	).toBeInTheDocument();
	expect(
		within(lastHeading).getByText("/work/z/project", { exact: true }),
	).toBeInTheDocument();
	expect(lastHeading).toHaveTextContent("2 work items");
	const zLinks = within(lastGroup).getAllByRole("link");
	const firstZLink = zLinks[0];
	const secondZLink = zLinks[1];
	if (!firstZLink || !secondZLink) throw new Error("expected both Z runs");
	expect(firstZLink).toHaveTextContent("Z first");
	expect(secondZLink).toHaveTextContent("Z second");
	expect(firstZLink).not.toHaveTextContent("/work/z/project");
});

it("summarizes loaded, attention, and active runs and shows row status metadata", async () => {
	const user = userEvent.setup();
	const gatedRun = runSummary(RUN_A, {
		title: "Gated task",
		openGates: [gate("one"), gate("two")],
	});
	const activeRun = runSummary(RUN_B, { title: "Active task" });
	const endedRun = runSummary(RUN_C, {
		title: "Ended task",
		status: "ended",
		stage: null,
	});
	render(
		<RunList
			runs={[gatedRun, activeRun, endedRun]}
			isPending={false}
			onSelect={() => {}}
		/>,
	);

	expect(screen.getByText("3 loaded work items")).toBeInTheDocument();
	const summary = screen.getByRole("region", { name: "Loaded work summary" });
	expect(summary).toHaveTextContent(/Needs you\s*1/);
	expect(summary).toHaveTextContent(/Active\s*1/);
	const gatedLink = screen.getByRole("link", { name: /Gated task/ });
	expect(gatedLink).toHaveTextContent("Needs you");
	expect(gatedLink).toHaveTextContent("2 open gates");
	expect(screen.getByRole("link", { name: /Active task/ })).toHaveTextContent(
		"Active",
	);
	const endedLink = screen.getByRole("link", { name: /Ended task/ });
	expect(endedLink).toHaveTextContent("Ended");
	expect(endedLink).toHaveTextContent("Stage pending");
	expect(endedLink).toHaveTextContent("Base: main");

	await user.click(screen.getByRole("radio", { name: "Repository" }));
	expect(screen.getByRole("link", { name: /Gated task/ })).toHaveTextContent(
		"Needs you",
	);
	expect(screen.getByRole("link", { name: /Gated task/ })).toHaveTextContent(
		"2 open gates",
	);
});

it("keeps the selected run and selector stable while switching grouping modes", async () => {
	const user = userEvent.setup();
	const onSelect = vi.fn();
	render(
		<RunList
			runs={[
				runSummary(RUN_A, { repo: "/work/a/repo" }),
				runSummary(RUN_B, { repo: "/work/b/repo" }),
			]}
			isPending={false}
			selectedRunId={RUN_A}
			onSelect={onSelect}
		/>,
	);
	const selectedLink = () =>
		screen
			.getAllByRole("link", { name: /Repair the widget/ })
			.find((link) => link.getAttribute("href") === `/runs/${RUN_A}`);
	const selector = screen.getByRole("combobox", { name: "Select run" });
	expect(selectedLink()).toHaveAttribute("aria-current", "page");
	expect(selector).toHaveValue(RUN_A);

	const repository = screen.getByRole("radio", { name: "Repository" });
	await user.click(repository);
	expect(repository).toBeChecked();
	expect(
		screen.getByRole("region", { name: "/work/a/repo" }),
	).toBeInTheDocument();
	expect(selectedLink()).toHaveAttribute("aria-current", "page");
	expect(selector).toHaveValue(RUN_A);

	await user.keyboard("{ArrowLeft}");
	expect(screen.getByRole("radio", { name: "Status" })).toBeChecked();
	expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
	expect(selectedLink()).toHaveAttribute("aria-current", "page");
	expect(selector).toHaveValue(RUN_A);
	expect(onSelect).not.toHaveBeenCalled();
});

it("keeps the no-runs message in both modes without empty repository groups", async () => {
	const user = userEvent.setup();
	render(<RunList runs={[]} isPending={false} onSelect={() => {}} />);
	expect(screen.getByText("No runs yet")).toBeInTheDocument();
	expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();

	await user.click(screen.getByRole("radio", { name: "Repository" }));
	expect(screen.getByText("No runs yet")).toBeInTheDocument();
	expect(
		screen
			.queryAllByRole("region")
			.filter((region) =>
				region.getAttribute("aria-label")?.startsWith("/work/"),
			),
	).toHaveLength(0);
});

it("keeps a plan and its PR together across statuses, grouping modes, and missing parents", async () => {
	const user = userEvent.setup();
	const onSelect = vi.fn();
	const planning = runSummary(RUN_A, { status: "ended", stage: "Approved" });
	const execution = {
		...runSummary(RUN_B),
		execution: {
			runId: RUN_B,
			sourceRunId: RUN_A,
			prId: "PR-1",
			phaseCount: 2,
			completedPhases: [],
			resultCommit: null,
			artifactIssues: [],
			status: "active" as const,
			outcome: null,
			stage: "Implement" as const,
			phaseIndex: 1,
			scope: "phase" as const,
			branch: null,
			worktree: null,
			statusDetail: null,
			escalationReason: null,
			checks: [],
			review: null,
		},
	};
	const view = render(
		<RunList
			runs={[execution, planning]}
			isPending={false}
			selectedRunId={RUN_B}
			onSelect={onSelect}
		/>,
	);
	expect(
		screen.getByRole("link", { name: /PR workspace PR-1/ }),
	).toHaveAttribute("href", `/runs/${RUN_B}`);
	expect(screen.getByRole("option", { name: /PR workspace PR-1/ })).toHaveValue(
		RUN_B,
	);
	const active = screen.getByRole("region", { name: "Active" });
	expect(within(active).getByRole("link", { name: /^Plan/ })).toHaveAttribute(
		"href",
		`/runs/${RUN_A}`,
	);
	expect(within(active).getAllByRole("link")).toHaveLength(2);
	expect(
		within(screen.getByRole("region", { name: "Ended" })).queryAllByRole(
			"link",
		),
	).toHaveLength(0);
	expect(screen.getByText("1 loaded work items")).toBeInTheDocument();
	const pr = screen.getByRole("link", { name: /PR workspace PR-1/ });
	expect(pr).toHaveAttribute("aria-current", "page");
	await user.click(pr);
	expect(onSelect).toHaveBeenCalledWith(RUN_B);
	await user.click(screen.getByRole("radio", { name: "Repository" }));
	expect(
		within(screen.getByRole("region", { name: "/work/repo" })).getAllByRole(
			"link",
		),
	).toHaveLength(2);
	view.rerender(
		<RunList
			runs={[{ ...execution, openGates: [gate("blocked")] }, planning]}
			isPending={false}
			selectedRunId={RUN_B}
			onSelect={onSelect}
		/>,
	);
	await user.click(screen.getByRole("radio", { name: "Status" }));
	expect(
		within(screen.getByRole("region", { name: "Needs you" })).getAllByRole(
			"link",
		),
	).toHaveLength(2);
	expect(
		within(screen.getByRole("region", { name: "Active" })).queryAllByRole(
			"link",
		),
	).toHaveLength(0);
	view.rerender(
		<RunList
			runs={[execution]}
			isPending={false}
			selectedRunId={RUN_B}
			onSelect={onSelect}
		/>,
	);
	expect(
		screen.getByText("Source plan is not in the loaded results."),
	).toBeVisible();
	expect(
		screen.getByRole("link", { name: /PR workspace PR-1/ }),
	).toHaveAttribute("href", `/runs/${RUN_B}`);
});
