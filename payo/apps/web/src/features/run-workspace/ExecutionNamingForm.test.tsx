import { ExecutionSummary } from "@payo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { correctExecutionNaming } from "../plan-review/api.ts";
import { ExecutionNamingForm } from "./ExecutionNamingForm.tsx";
import { ExecutionView } from "./ExecutionView.tsx";

vi.mock("../plan-review/api.ts", () => ({ correctExecutionNaming: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
it("requires a server preview before confirming a preparation slug correction", async () => {
	const refresh = vi.fn();
	vi.mocked(correctExecutionNaming).mockResolvedValue({
		candidates: ["ABC-123"],
		ticketId: "ABC-123",
		slug: "create-other-entity",
		branch: "ABC-123/create-other-entity",
		errors: {},
		previewHash: "hash",
	});
	render(
		<ExecutionNamingForm
			token="token"
			runId="execution"
			initialSlug="create-todo-entity"
			onRefresh={refresh}
		/>,
	);
	const user = userEvent.setup();
	await user.clear(screen.getByLabelText("Replacement branch slug"));
	await user.type(
		screen.getByLabelText("Replacement branch slug"),
		"create-other-entity",
	);
	await user.click(
		screen.getByRole("button", { name: "Preview branch correction" }),
	);
	expect(await screen.findByText("ABC-123/create-other-entity")).toBeVisible();
	expect(correctExecutionNaming).toHaveBeenCalledWith("token", "execution", {
		slug: "create-other-entity",
	});
	await user.click(
		screen.getByRole("button", { name: "Confirm branch correction" }),
	);
	expect(correctExecutionNaming).toHaveBeenLastCalledWith(
		"token",
		"execution",
		{ slug: "create-other-entity", previewHash: "hash" },
	);
	expect(refresh).toHaveBeenCalled();
});

it("offers correction only before a preparation workspace exists", () => {
	const execution = ExecutionSummary.parse({
		runId: "execution",
		sourceRunId: "source",
		prId: "pr",
		status: "active",
		outcome: null,
		stage: "Escalated",
		phaseIndex: 0,
		scope: "phase",
		branch: "ABC-123/create-todo-entity",
		worktree: null,
		statusDetail: "branch-collision",
		escalationReason: "collision",
		pausedOperation: "Prepare",
		checks: [],
		review: null,
		naming: {
			version: 1,
			ticketId: "ABC-123",
			slug: "create-todo-entity",
			branch: "ABC-123/create-todo-entity",
			policy: {
				remote: "origin",
				branchTemplate: "{ticketId}/{slug}",
				commitTemplate: "[{ticketId}] {description}",
				prTitleTemplate: "[{ticketId}] {description}",
				prBodyTemplate: "",
			},
		},
	});
	const props = {
		token: "token",
		gate: {
			gateId: "gate",
			stepId: "step",
			kind: "execution-escalation",
			reason: "collision",
			allowedCommands: ["resume"],
		},
		onRefresh: async () => {},
		onSelectRun: vi.fn(),
	};
	const { rerender } = render(
		<ExecutionView {...props} execution={execution} />,
	);
	expect(screen.getByLabelText("Replacement branch slug")).toBeVisible();
	rerender(
		<ExecutionView
			{...props}
			execution={{ ...execution, worktree: "/workspace" }}
		/>,
	);
	expect(screen.queryByLabelText("Replacement branch slug")).toBeNull();
});
