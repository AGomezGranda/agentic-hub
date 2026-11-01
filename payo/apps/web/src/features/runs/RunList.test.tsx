import { RunSummary as RunSummarySchema } from "@payo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RunList } from "./RunList.tsx";

const RUN_A = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const RUN_B = "7f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";

function runSummary(runId: string, stage: string | null = "Plan") {
	return RunSummarySchema.parse({
		runId,
		repo: "/work/repo",
		baseBranch: "main",
		status: "active",
		outcome: null,
		stage,
		workItem: { source: "jira", title: "Repair the widget", key: "ABC-123" },
		startedAt: "2026-10-30T00:00:00.000Z",
		updatedAt: "2026-10-30T00:00:00.000Z",
		openGates: [],
	});
}

afterEach(cleanup);

it("selects runs from links and the narrow-screen selector", async () => {
	const user = userEvent.setup();
	const onSelect = vi.fn();
	const runs = [runSummary(RUN_A), runSummary(RUN_B, "FutureServerStage")];
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

it("shows counts for each group in the loaded list", () => {
	render(
		<RunList
			runs={[runSummary(RUN_A)]}
			isPending={false}
			onSelect={() => {}}
		/>,
	);
	expect(screen.getByText(/Needs you.*0/)).toBeInTheDocument();
	expect(screen.getByText(/Active.*1/)).toBeInTheDocument();
	expect(screen.getByText(/Ended.*0/)).toBeInTheDocument();
	expect(screen.getByText(/loaded runs/i)).toBeInTheDocument();
});
