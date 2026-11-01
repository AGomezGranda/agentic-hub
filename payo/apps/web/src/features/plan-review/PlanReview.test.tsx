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

function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PlanReview token="token" runId={RUN_ID} />
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
		screen.getByRole("button", { name: /approve and end the run/i }),
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
		screen.getByRole("button", { name: /approve and end the run/i }),
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
		screen.getByRole("button", { name: /approve and end the run/i }),
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
