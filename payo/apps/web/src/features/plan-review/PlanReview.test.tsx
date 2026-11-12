// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { PlanReview } from "./PlanReview.tsx";

const api = vi.hoisted(() => ({
	getRun: vi.fn(),
	getRunReview: vi.fn(),
	answerQuestion: vi.fn(),
	approveRun: vi.fn(),
	requestChanges: vi.fn(),
	resumeRun: vi.fn(),
	getPlanVersions: vi.fn(),
	submitPlanUpdate: vi.fn(),
	implementRun: vi.fn(),
	previewImplementation: vi.fn(),
}));
vi.mock("./api.ts", () => api);
vi.mock("@web/features/runs/api.ts", () => ({ getRun: api.getRun }));

const RUN_ID = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const timestamp = "2026-10-30T00:00:00.000Z";

function summary(overrides: Record<string, unknown> = {}) {
	return {
		runId: RUN_ID,
		repo: "/repo",
		baseBranch: "main",
		status: "active",
		outcome: null,
		stage: "Approval",
		workItem: null,
		startedAt: timestamp,
		updatedAt: timestamp,
		openGates: [
			{
				gateId: "approval",
				stepId: "step",
				kind: "approval",
				allowedCommands: ["approve", "requestChanges"],
				reason: "awaiting approval",
			},
		],
		...overrides,
	};
}

function review(
	markdown = "# Plan\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>",
) {
	return {
		plan: {
			available: true,
			markdown,
			editorPath: "/tmp/payo/runs/run/plan.md",
			questions: [{ id: "q1", question: "Why this approach?" }],
		},
		answers: {},
		review: {
			available: true,
			findings: [
				{
					id: "f1",
					severity: "P1",
					title: "Untrusted finding title",
					path: null,
					line: null,
					evidence: "Untrusted evidence",
					consequence: "Consequence",
					suggestedFix: "Fix",
				},
			],
			uncheckedLenses: ["security"],
			verdicts: null,
			provenance: "unknown",
		},
	};
}

function mount(onSelectRun = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PlanReview token="token" runId={RUN_ID} onSelectRun={onSelectRun} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.getRun.mockResolvedValue(summary());
	api.getRunReview.mockResolvedValue(review());
	api.answerQuestion.mockResolvedValue(summary());
	api.approveRun.mockResolvedValue(
		summary({ status: "ended", outcome: "approved" }),
	);
	api.requestChanges.mockResolvedValue({ runId: RUN_ID });
	api.resumeRun.mockResolvedValue({ runId: RUN_ID });
	api.getPlanVersions.mockResolvedValue([]);
	api.submitPlanUpdate.mockResolvedValue({ runId: RUN_ID });
});

it("submits a revision prompt with freshly fetched concurrency values", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockResolvedValue({
		...review(),
		plan: { ...review().plan, version: 2, workingCopyHash: "a".repeat(64) },
	});
	mount();
	await user.click(await screen.findByRole("button", { name: "Revise plan" }));
	const prompt = screen.getByLabelText("What should change?");
	expect(
		screen.getByRole("button", { name: "Submit revision" }),
	).toBeDisabled();
	await user.type(prompt, "Make it clearer");
	await user.click(screen.getByRole("button", { name: "Submit revision" }));
	await waitFor(() =>
		expect(api.submitPlanUpdate).toHaveBeenCalledWith("token", RUN_ID, {
			prompt: "Make it clearer",
			expectedVersion: 2,
			expectedWorkingCopyHash: "a".repeat(64),
		}),
	);
});

it("compares saved versions and confirms restore with current state", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockResolvedValue({
		...review(),
		plan: { ...review().plan, version: 2, workingCopyHash: "a".repeat(64) },
	});
	api.getPlanVersions.mockResolvedValue([
		{
			number: 1,
			source: "agent",
			markdown: "# First",
			questions: [],
			answers: {},
		},
		{
			number: 2,
			source: "human",
			markdown: "# Second",
			questions: [],
			answers: {},
		},
		{
			number: 3,
			source: "agent",
			markdown: "# Third",
			questions: [],
			answers: {},
		},
	]);
	mount();
	await user.click(await screen.findByRole("button", { name: "History" }));
	await user.click(screen.getByRole("button", { name: "Version 1 · agent" }));
	expect(screen.getByText("First")).toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Compare" }));
	expect(screen.getByRole("combobox", { name: "From" })).toHaveValue("3");
	await user.selectOptions(screen.getByRole("combobox", { name: "From" }), "2");
	expect(screen.getByText("− # Second")).toBeInTheDocument();
	expect(screen.getByRole("combobox", { name: "To" })).toHaveValue("1");
	await user.selectOptions(screen.getByRole("combobox", { name: "To" }), "2");
	expect(screen.getByRole("combobox", { name: "From" })).toHaveValue("1");
	expect(screen.getByText("+ # Second")).toBeInTheDocument();
	await user.selectOptions(screen.getByRole("combobox", { name: "To" }), "1");
	await user.selectOptions(screen.getByRole("combobox", { name: "From" }), "2");
	expect(screen.getByText("+ # First")).toBeInTheDocument();
	expect(screen.getByText("− # Second")).toBeInTheDocument();
	await user.click(
		screen.getByRole("button", { name: "Restore this version" }),
	);
	expect(
		screen.getByText(/creates a new version and runs review/i),
	).toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Confirm restore" }));
	await waitFor(() =>
		expect(api.submitPlanUpdate).toHaveBeenCalledWith("token", RUN_ID, {
			version: 1,
			expectedVersion: 2,
			expectedWorkingCopyHash: "a".repeat(64),
		}),
	);
});

it("labels an old draft separately from an answer restored by the server", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockResolvedValue({
		...review(),
		answers: { q1: "First answer" },
	});
	mount();
	const input = await screen.findByLabelText("Why this approach?");
	await user.clear(input);
	await user.type(input, "Unsaved text");
	api.getRunReview.mockResolvedValue({
		...review(),
		answers: { q1: "Restored answer" },
	});
	window.dispatchEvent(new Event("focus"));
	expect(
		await screen.findByText(/Unsaved draft.*Saved answer: Restored answer/),
	).toBeInTheDocument();
});

it("keeps the prompt after a conflict and hides restore controls after approval", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockResolvedValue({
		...review(),
		plan: { ...review().plan, version: 1, workingCopyHash: "a".repeat(64) },
	});
	api.submitPlanUpdate.mockRejectedValue(
		Object.assign(new Error("stale"), { status: 409 }),
	);
	api.getPlanVersions.mockResolvedValue([
		{
			number: 1,
			source: "agent",
			markdown: "# Saved",
			questions: [],
			answers: {},
		},
	]);
	mount();
	await user.click(await screen.findByRole("button", { name: "Revise plan" }));
	const prompt = screen.getByLabelText("What should change?");
	await user.type(prompt, "Keep my draft");
	await user.click(screen.getByRole("button", { name: "Submit revision" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(/state changed/i);
	expect(prompt).toHaveValue("Keep my draft");
	api.getRun.mockResolvedValue(
		summary({ status: "ended", stage: "Approved", openGates: [] }),
	);
	window.dispatchEvent(new Event("focus"));
	await waitFor(() =>
		expect(
			screen.queryByLabelText("What should change?"),
		).not.toBeInTheDocument(),
	);
	await user.click(screen.getByRole("button", { name: "History" }));
	await user.click(screen.getByRole("button", { name: "Version 1 · agent" }));
	expect(
		screen.queryByRole("button", { name: /restore this version/i }),
	).not.toBeInTheDocument();
});

afterEach(cleanup);

it("renders plan markdown safely and keeps findings provenance explicit", async () => {
	const user = userEvent.setup();
	mount();

	expect(
		await screen.findByRole("heading", { name: "Plan", level: 2 }),
	).toBeInTheDocument();
	expect(screen.getByText("unsafe").tagName).not.toBe("A");
	expect(document.querySelector("script")).toBeNull();
	expect(document.querySelector("img")).toBeNull();
	expect(screen.getByText(/review provenance is unknown/i)).toBeInTheDocument();
	expect(screen.getByText(/may be stale/i)).toBeInTheDocument();
	expect(screen.getByText("Untrusted finding title")).toBeInTheDocument();
	expect(screen.getByText(/payo edit/)).toBeInTheDocument();
	expect(screen.getByRole("link", { name: "View activity" })).toHaveAttribute(
		"href",
		"#run-activity",
	);

	const approve = screen.getByRole("button", {
		name: /approve and end the run/i,
	});
	expect(approve).toBeDisabled();
	expect(screen.getByText(/answer every open question/i)).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: /request changes/i }),
	).toBeEnabled();
	await user.click(screen.getByRole("button", { name: /request changes/i }));
	await waitFor(() =>
		expect(api.requestChanges).toHaveBeenCalledWith("token", RUN_ID),
	);
});

it("saves individual answers, refreshes the view, then allows approval", async () => {
	const user = userEvent.setup();
	api.answerQuestion.mockImplementation(async () => {
		api.getRunReview.mockResolvedValue({
			...review("# Updated by another editor"),
			answers: { q1: "Because the constraint matters." },
		});
		return summary();
	});
	mount();

	await screen.findByLabelText("Why this approach?");
	await user.type(
		screen.getByLabelText("Why this approach?"),
		"Because the constraint matters.",
	);
	await user.click(screen.getByRole("button", { name: "Save answer" }));
	await waitFor(() =>
		expect(api.answerQuestion).toHaveBeenCalledWith(
			"token",
			RUN_ID,
			"q1",
			"Because the constraint matters.",
		),
	);
	await screen.findByRole("heading", { name: "Updated by another editor" });
	expect(
		screen.getByRole("button", { name: /approve and end the run/i }),
	).toBeEnabled();
	await user.click(
		screen.getByRole("button", { name: "Approve and end the run" }),
	);
	expect(api.approveRun).not.toHaveBeenCalled();
	await user.click(
		screen.getByRole("button", { name: "Confirm approve and end the run" }),
	);
	await waitFor(() =>
		expect(api.approveRun).toHaveBeenCalledWith("token", RUN_ID),
	);
});

it("shows escalation reason and exposes only resume even without a plan", async () => {
	const user = userEvent.setup();
	api.getRun.mockResolvedValue(
		summary({
			stage: "Escalated",
			openGates: [
				{
					gateId: "escalation",
					stepId: "step",
					kind: "factory-escalation",
					allowedCommands: ["resume"],
					reason: "review could not converge",
				},
			],
		}),
	);
	api.getRunReview.mockResolvedValue({
		plan: { available: false, reason: "not_available" },
		answers: {},
		review: { available: false, reason: "not_available" },
	});
	mount();

	expect(
		await screen.findByText("review could not converge"),
	).toBeInTheDocument();
	const resume = screen.getByRole("button", { name: /resume run/i });
	expect(resume).toBeEnabled();
	expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	await user.click(resume);
	await waitFor(() =>
		expect(api.resumeRun).toHaveBeenCalledWith("token", RUN_ID),
	);
});

it("refreshes external edits on focus and refreshes again after conflicts", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockResolvedValue({
		...review(),
		answers: { q1: "already answered" },
	});
	api.approveRun.mockRejectedValue(
		Object.assign(new Error("run is no longer awaiting approval"), {
			status: 409,
			code: "conflict",
		}),
	);
	mount();
	await screen.findByRole("heading", { name: "Plan", level: 2 });

	api.getRunReview.mockResolvedValue({
		...review("# Externally edited"),
		answers: { q1: "already answered" },
	});
	window.dispatchEvent(new Event("focus"));
	await screen.findByText("Externally edited");

	await user.click(
		screen.getByRole("button", { name: "Approve and end the run" }),
	);
	await user.click(
		screen.getByRole("button", { name: "Confirm approve and end the run" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		/state changed|conflict/i,
	);
	await waitFor(() =>
		expect(api.getRunReview.mock.calls.length).toBeGreaterThanOrEqual(3),
	);
});

it("prevents decisions on a failed pre-command refresh and offers a retry", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockResolvedValue({
		...review(),
		answers: { q1: "already answered" },
	});
	mount();
	await screen.findByRole("heading", { name: "Plan", level: 2 });
	api.getRunReview.mockRejectedValueOnce(new Error("connection lost"));

	await user.click(
		screen.getByRole("button", { name: "Approve and end the run" }),
	);
	await user.click(
		screen.getByRole("button", { name: "Confirm approve and end the run" }),
	);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		/connection lost/i,
	);
	expect(api.approveRun).not.toHaveBeenCalled();
	await user.click(screen.getByRole("button", { name: "Retry refresh" }));
	await waitFor(() =>
		expect(api.getRunReview.mock.calls.length).toBeGreaterThanOrEqual(3),
	);
});

it("keeps answer controls keyboard reachable with a visible focus style", async () => {
	const user = userEvent.setup();
	mount();
	const textarea = await screen.findByLabelText("Why this approach?");

	await user.tab();
	expect(screen.getByRole("button", { name: "Review" })).toHaveFocus();
	await user.tab();
	await user.tab();
	expect(screen.getByRole("link", { name: "View activity" })).toHaveFocus();
	await user.tab();
	expect(textarea).toHaveFocus();
	await user.type(textarea, "Keyboard answer");
	await user.tab();
	const save = screen.getByRole("button", { name: "Save answer" });
	expect(save).toHaveFocus();
	expect(save).toHaveClass("focus-visible:ring-2");
	await user.keyboard("{Enter}");
	await waitFor(() => expect(api.answerQuestion).toHaveBeenCalled());
});

it("offers retry and prevents decisions when the review read fails", async () => {
	const user = userEvent.setup();
	api.getRunReview.mockRejectedValueOnce(new Error("offline"));
	mount();

	expect(await screen.findByRole("alert")).toHaveTextContent(
		/could not load plan review/i,
	);
	expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	await user.click(screen.getByRole("button", { name: /retry/i }));
	expect(
		await screen.findByRole("heading", { name: "Plan", level: 2 }),
	).toBeInTheDocument();
});

it("keeps revision drafts across history navigation and shows the empty archive", async () => {
	const user = userEvent.setup();
	mount();
	await user.click(await screen.findByRole("button", { name: "Revise plan" }));
	await user.type(
		screen.getByLabelText("What should change?"),
		"Keep this draft",
	);
	await user.click(screen.getByRole("button", { name: "History" }));
	expect(
		screen.queryByRole("button", { name: "Approve and end the run" }),
	).not.toBeInTheDocument();
	expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
	expect(await screen.findByText("No saved versions yet.")).toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Back to review" }));
	expect(screen.getByLabelText("What should change?")).toHaveValue(
		"Keep this draft",
	);
});

it("opens the newest snapshot and compares to its predecessor with context", async () => {
	const user = userEvent.setup();
	api.getPlanVersions.mockResolvedValue([
		{
			number: 1,
			source: "agent",
			markdown: "# Shared\nOld\nEnd",
			questions: [],
			answers: {},
		},
		{
			number: 2,
			source: "human",
			markdown: "# Shared\nNew\nEnd",
			questions: [],
			answers: {},
		},
	]);
	mount();
	await user.click(await screen.findByRole("button", { name: "History" }));
	expect(
		screen.getByRole("button", { name: "Version 2 · human" }),
	).toHaveAttribute("aria-pressed", "true");
	await user.click(screen.getByRole("button", { name: "Compare" }));
	expect(screen.getByRole("combobox", { name: "From" })).toHaveValue("1");
	expect(screen.getByRole("combobox", { name: "To" })).toHaveValue("2");
	expect(screen.getByText("− Old")).toBeInTheDocument();
	expect(screen.getByText("+ New")).toBeInTheDocument();
	expect(screen.getByText("# Shared")).toBeInTheDocument();
	expect(screen.getByText("End")).toBeInTheDocument();
});

it("launches an approved PR, preserves inputs on rejection, and navigates on acceptance", async () => {
	const user = userEvent.setup();
	const navigate = vi.fn();
	api.getRun.mockResolvedValue(
		summary({
			status: "ended",
			outcome: "approved",
			stage: "Approved",
			openGates: [],
		}),
	);
	api.getRunReview.mockResolvedValue({
		...review(),
		plan: {
			...review().plan,
			prStrategy: [
				{ id: "empty", title: "Empty", phases: [] },
				{ id: "pr2", title: "Second", phases: ["Build", "Verify"] },
			],
		},
		review: { available: false, reason: "missing" },
	});
	let resolveLaunch: (value: { runId: string }) => void = () => {};
	api.previewImplementation
		.mockRejectedValueOnce(new Error("Configure execution checks"))
		.mockResolvedValue({
			candidates: [],
			ticketId: null,
			slug: "",
			errors: {},
			previewHash: "hash",
		});
	api.implementRun.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveLaunch = resolve;
			}),
	);
	mount(navigate);
	await screen.findByRole("heading", { name: "Planned PRs" });
	expect(
		screen.getByRole("button", { name: "Implement empty" }),
	).toBeDisabled();
	await user.click(screen.getByText("pr2 · Second"));
	expect(screen.getByText("Build")).toBeVisible();
	expect(screen.getByText("Verify")).toBeVisible();
	await user.click(screen.getByText("Base branch · main"));
	await user.type(screen.getByLabelText("Override base branch"), " feature ");
	await user.click(screen.getByRole("button", { name: "Implement pr2" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Configure execution checks",
	);
	expect(screen.getByLabelText("Override base branch")).toHaveValue(
		" feature ",
	);
	await user.click(
		screen.getByRole("button", { name: "Refresh naming preview" }),
	);
	await user.click(
		await screen.findByRole("button", { name: "Confirm implementation" }),
	);
	expect(
		screen.getByRole("button", { name: "Confirm implementation" }),
	).toBeDisabled();
	expect(api.implementRun).toHaveBeenLastCalledWith("token", RUN_ID, {
		prId: "pr2",
		base: "feature",
		naming: { previewHash: "hash", ticketId: null, slug: "" },
	});
	resolveLaunch({ runId: "accepted-id" });
	await waitFor(() => expect(navigate).toHaveBeenCalledWith("accepted-id"));
});

it("links preview phases to the plan and allows revision while ambiguous phases block approval", async () => {
	const data = review("# Working plan\n\n### Build");
	api.getRunReview.mockResolvedValue({
		...data,
		plan: {
			...data.plan,
			questions: [],
			implementation: [
				{
					id: "pr1",
					title: "First PR",
					phases: [
						{ title: "Build", line: 3 },
						{ title: "Ship", line: null },
					],
					issues: ["Could not match Ship."],
				},
			],
		},
	});
	mount();
	const link = await screen.findByRole("link", { name: "Build" });
	expect(link).toHaveAttribute("href", "#plan-line-3");
	expect(screen.getByRole("heading", { name: "Build" })).toHaveAttribute(
		"id",
		"plan-line-3",
	);
	expect(screen.getByText("Could not match Ship.")).toBeVisible();
	expect(
		screen.getByRole("button", { name: "Approve and end the run" }),
	).toBeDisabled();
	expect(screen.getByRole("button", { name: "Revise plan" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Request changes" })).toBeEnabled();
	expect(
		screen.queryByRole("button", { name: /start .* locally/i }),
	).toBeNull();
});

it("keeps the plan and decisions in the main column and supporting details in context", async () => {
	const { container } = mount();
	const context = await screen.findByRole("complementary", {
		name: "Plan context",
	});
	expect(context).toContainElement(
		screen.getByText("/tmp/payo/runs/run/plan.md"),
	);
	expect(context).toContainElement(screen.getByText("Untrusted finding title"));
	const main = container.querySelector(".workspace-main");
	expect(main).toContainElement(screen.getByLabelText("Why this approach?"));
	expect(main).toContainElement(
		screen.getByRole("region", { name: "Gate actions" }),
	);
	expect(container.querySelector(".workspace-summary")).toContainElement(
		screen.getByRole("navigation", { name: "Plan workspace" }),
	);
});
