import { ExecutionSummary } from "@payo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ExecutionProgress } from "./ExecutionProgress.tsx";

const execution = ExecutionSummary.parse({
	runId: "run",
	sourceRunId: "plan",
	prId: "PR-1",
	phaseCount: 2,
	phases: [
		{ id: "one", title: "Contracts" },
		{ id: "two", title: "Implementation" },
	],
	completedPhases: [{ id: "one", title: "Contracts", resultCommit: "abc123" }],
	status: "active",
	outcome: null,
	stage: "Review",
	phaseIndex: 1,
	scope: "phase",
	branch: null,
	worktree: null,
	statusDetail: null,
	escalationReason: null,
	checks: [],
	review: null,
});
afterEach(cleanup);

it("distinguishes completion receipts, the current phase and the final checkpoint", () => {
	const view = render(<ExecutionProgress execution={execution} />);
	expect(screen.getByText("Contracts").closest("li")).toHaveAttribute(
		"data-state",
		"complete",
	);
	expect(screen.getByText("abc123")).toBeVisible();
	expect(screen.getByText("Implementation").closest("li")).toHaveAttribute(
		"aria-current",
		"step",
	);
	expect(screen.getByText("Final PR review").closest("li")).toHaveAttribute(
		"data-state",
		"pending",
	);
	view.rerender(
		<ExecutionProgress execution={{ ...execution, scope: "final" }} />,
	);
	expect(screen.getByText("Implementation").closest("li")).not.toHaveAttribute(
		"aria-current",
	);
	expect(screen.getByText("Final PR review").closest("li")).toHaveAttribute(
		"aria-current",
		"step",
	);
});

it("does not show a phase as running during preparation or after the run ends", () => {
	const view = render(
		<ExecutionProgress execution={{ ...execution, stage: "Prepare" }} />,
	);
	expect(screen.getByText("Implementation").closest("li")).not.toHaveAttribute(
		"aria-current",
	);
	view.rerender(
		<ExecutionProgress
			execution={{ ...execution, status: "ended", outcome: "failed" }}
		/>,
	);
	expect(screen.getByText("Implementation").closest("li")).not.toHaveAttribute(
		"aria-current",
	);
	expect(screen.getByText("Not completed")).toBeVisible();
	expect(screen.getByText("Final PR review").closest("li")).toHaveAttribute(
		"data-state",
		"pending",
	);
});
