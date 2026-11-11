import { ExecutionSummary } from "@payo/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as planApi from "../plan-review/api.ts";
import * as runApi from "../runs/api.ts";
import { ExecutionView } from "./ExecutionView.tsx";

vi.mock("../plan-review/api.ts", () => ({
	getRunReview: vi.fn(),
	resumeRun: vi.fn(),
}));
vi.mock("../runs/api.ts", () => ({ getRun: vi.fn(), startRun: vi.fn() }));

const issue =
	"Issue in Phase 1: Expected: Add a history API. Found: An API already exists. Why this matters: Existing clients would break. How should I proceed? Reuse or replace?";
const gate = {
	gateId: "gate",
	stepId: "step",
	kind: "execution-escalation",
	allowedCommands: ["resume"],
	reason: `implementer reported plan issues: ${issue}`,
};
const execution = ExecutionSummary.parse({
	runId: "execution",
	sourceRunId: "source",
	prId: "PR-1",
	phaseCount: 1,
	status: "active",
	outcome: null,
	stage: "Escalated",
	phaseIndex: 0,
	scope: "phase",
	branch: "payo/execution",
	worktree: "/retained/worktree",
	statusDetail: "implementation-report-incomplete",
	escalationReason: gate.reason,
	planIssues: [issue],
	checks: [],
	review: null,
});

function setup(issues = [issue]) {
	const select = vi.fn();
	render(
		<ExecutionView
			execution={{ ...execution, planIssues: issues }}
			gate={gate}
			token="token"
			onRefresh={async () => {}}
			onSelectRun={select}
		/>,
	);
	return { user: userEvent.setup(), select };
}

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

it("shows labelled conflict sections and the original report, and retries the retained execution", async () => {
	const { user } = setup();
	expect(
		screen.getByRole("heading", { name: /Reported plan issue/ }),
	).toBeVisible();
	expect(screen.getByText("Plan expects")).toBeVisible();
	expect(screen.getByText("Add a history API.")).toBeVisible();
	expect(screen.getByText("Repository has")).toBeVisible();
	expect(screen.getByText("An API already exists.")).toBeVisible();
	expect(screen.getByText("Existing clients would break.")).toBeVisible();
	expect(screen.getByText("Reuse or replace?")).toBeVisible();
	await user.click(screen.getByRole("button", { name: "Retry unchanged" }));
	await user.click(
		screen.getByRole("button", { name: "Retry on approved plan" }),
	);
	expect(planApi.resumeRun).toHaveBeenCalledWith("token", "execution");
	await user.click(screen.getByText("Show full report"));
	expect(screen.getByText(issue)).toBeVisible();
	expect(
		screen.getByRole("button", { name: "Draft a plan correction" }),
	).toBeEnabled();
});

it("keeps unstructured reports complete", () => {
	setup([
		"The plan conflicts with the existing history contract; retain saved answers.",
	]);
	expect(
		screen.getByText(
			"The plan conflicts with the existing history contract; retain saved answers.",
		),
	).toBeVisible();
	expect(screen.queryByText("Plan expects")).toBeNull();
});

function mockContext() {
	const source = {
		runId: "source",
		repo: "/repo",
		baseBranch: "main",
		status: "ended",
		outcome: "approved",
	};
	vi.mocked(runApi.getRun).mockImplementation(
		async (_token, id) =>
			(id === "source"
				? source
				: {
						...source,
						runId: "execution",
						status: "active",
						execution,
						openGates: [gate],
					}) as Awaited<ReturnType<typeof runApi.getRun>>,
	);
	vi.mocked(planApi.getRunReview).mockResolvedValue({
		plan: {
			available: true,
			markdown: "# Original plan",
			version: 2,
			editorPath: null,
			questions: [],
			prStrategy: [{ id: "PR-1", title: "History", phases: ["Phase 1"] }],
		},
		answers: { choice: "Preserve old consumers" },
		review: { available: false, reason: "not_available" },
	});
}

it("creates a corrected planning run with context and decision, retaining failed drafts", async () => {
	mockContext();
	vi.mocked(runApi.startRun)
		.mockRejectedValueOnce(new Error("Server unavailable"))
		.mockResolvedValueOnce({ runId: "corrected" });
	const { user, select } = setup();
	await user.click(
		screen.getByRole("button", { name: "Draft a plan correction" }),
	);
	const submit = await screen.findByRole("button", {
		name: "Draft corrected plan",
	});
	expect(submit).toBeDisabled();
	expect(screen.getByText(/not transferred automatically/)).toBeVisible();
	await user.click(screen.getByText("View approved plan"));
	expect(screen.getByRole("heading", { name: "Original plan" })).toBeVisible();
	await user.type(
		screen.getByRole("textbox", { name: "Your decision" }),
		"Reuse the existing API.",
	);
	await user.click(submit);
	expect(await screen.findByText("Server unavailable")).toBeVisible();
	expect(screen.getByRole("textbox", { name: "Your decision" })).toHaveValue(
		"Reuse the existing API.",
	);
	await user.click(submit);
	await waitFor(() => expect(select).toHaveBeenCalledWith("corrected"));
	expect(runApi.startRun).toHaveBeenLastCalledWith("token", {
		repo: "/repo",
		baseBranch: "main",
		workItemRequest: {
			source: "prompt",
			text: expect.stringContaining("Reuse the existing API."),
		},
	});
	const request = vi.mocked(runApi.startRun).mock.calls[1]?.[1];
	const text =
		request?.workItemRequest.source === "prompt"
			? request.workItemRequest.text
			: "";
	for (const expected of [
		"# Original plan",
		"PR-1",
		"Phase 1",
		"Preserve old consumers",
		issue,
		"/retained/worktree",
		"execution",
		"source",
	])
		expect(text).toContain(expected);
	expect(planApi.resumeRun).not.toHaveBeenCalled();
});

it("blocks correction if the conflict changes while the form is open", async () => {
	mockContext();
	const { user } = setup();
	await user.click(
		screen.getByRole("button", { name: "Draft a plan correction" }),
	);
	await screen.findByRole("textbox", { name: "Your decision" });
	await user.type(
		screen.getByRole("textbox", { name: "Your decision" }),
		"Keep the API.",
	);
	vi.mocked(runApi.getRun).mockResolvedValueOnce({
		execution: { ...execution, stage: "Implement", planIssues: [] },
	} as unknown as Awaited<ReturnType<typeof runApi.getRun>>);
	await user.click(
		screen.getByRole("button", { name: "Draft corrected plan" }),
	);
	expect(await screen.findByText(/conflict changed/)).toBeVisible();
	expect(runApi.startRun).not.toHaveBeenCalled();
});

it("does not create a run when the original approved plan is unavailable", async () => {
	mockContext();
	vi.mocked(planApi.getRunReview).mockResolvedValue({
		plan: { available: false, reason: "missing" },
		answers: {},
		review: { available: false, reason: "missing" },
	});
	const { user } = setup();
	await user.click(
		screen.getByRole("button", { name: "Draft a plan correction" }),
	);
	expect(await screen.findByText(/approved plan is unavailable/)).toBeVisible();
	expect(runApi.startRun).not.toHaveBeenCalled();
});

it("answers each distinct issue and resumes the retained execution, preserving failed submissions", async () => {
	const other = "Which API route should be used?";
	vi.mocked(planApi.resumeRun)
		.mockRejectedValueOnce(new Error("Workspace unavailable"))
		.mockResolvedValueOnce({ runId: "execution" });
	const { user } = setup([issue, other, issue]);
	const submit = screen.getByRole("button", { name: "Resume with answers" });
	expect(submit).toBeDisabled();
	expect(screen.getAllByRole("textbox")).toHaveLength(2);
	await user.type(
		screen.getByRole("textbox", { name: "Your answer to issue 1" }),
		"Reuse the existing API.",
	);
	expect(submit).toBeDisabled();
	await user.type(
		screen.getByRole("textbox", { name: "Your answer to issue 2" }),
		"Use /history.",
	);
	await user.click(submit);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Workspace unavailable",
	);
	expect(
		screen.getByRole("textbox", { name: "Your answer to issue 1" }),
	).toHaveValue("Reuse the existing API.");
	await user.click(submit);
	await waitFor(() => expect(planApi.resumeRun).toHaveBeenCalledTimes(2));
	expect(planApi.resumeRun).toHaveBeenLastCalledWith("token", "execution", {
		gateId: "gate",
		answers: [
			{ issue, answer: "Reuse the existing API." },
			{ issue: other, answer: "Use /history." },
		],
	});
	expect(runApi.startRun).not.toHaveBeenCalled();
});

it("shows one resolution at a time and preserves drafts when switching", async () => {
	mockContext();
	const { user } = setup();
	const clarify = screen.getByRole("button", {
		name: "Clarify implementation",
	});
	expect(clarify).toHaveAttribute("aria-pressed", "true");
	expect(
		screen.queryByRole("button", { name: "Retry on approved plan" }),
	).toBeNull();
	await user.type(
		screen.getByRole("textbox", { name: "Your answer to issue 1" }),
		"Keep the API.",
	);
	await user.click(screen.getByRole("button", { name: "Retry unchanged" }));
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(
		screen.getByRole("button", { name: "Retry on approved plan" }),
	).toBeVisible();
	await user.click(
		screen.getByRole("button", { name: "Draft a plan correction" }),
	);
	await user.type(
		await screen.findByRole("textbox", { name: "Your decision" }),
		"Preserve existing clients.",
	);
	expect(
		screen.queryByRole("button", { name: "Retry on approved plan" }),
	).toBeNull();
	await user.click(clarify);
	expect(
		screen.getByRole("textbox", { name: "Your answer to issue 1" }),
	).toHaveValue("Keep the API.");
	await user.click(
		screen.getByRole("button", { name: "Draft a plan correction" }),
	);
	expect(screen.getByRole("textbox", { name: "Your decision" })).toHaveValue(
		"Preserve existing clients.",
	);
	expect(planApi.resumeRun).not.toHaveBeenCalled();
	expect(runApi.startRun).not.toHaveBeenCalled();
});
