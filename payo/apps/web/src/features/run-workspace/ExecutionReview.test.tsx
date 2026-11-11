import { ExecutionSummary } from "@payo/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ExecutionReview, ExecutionReviewContext } from "./ExecutionReview.tsx";
import { ExecutionView } from "./ExecutionView.tsx";

const finding = {
	id: "blocker",
	severity: "P1",
	title: "Missing validation",
	path: "src/api.ts",
	line: 12,
	evidence: "Input reaches storage unchecked.",
	consequence: "Invalid records are stored.",
	suggestedFix: "Validate input before storing.",
};
const review = ExecutionSummary.shape.review.unwrap().parse({
	lenses: ["security"],
	uncheckedLenses: ["architecture"],
	findings: 2,
	unresolved: 0,
	round: 9,
	details: {
		findings: [
			{ ...finding, id: "dismissed", title: "Old concern", severity: "P0" },
			finding,
		],
		verdicts: [
			{
				sourceIds: ["blocker"],
				classification: "BLOCKER",
				severity: "P1",
				reason: "The boundary accepts arbitrary data.",
				counterEvidence: null,
			},
			{
				sourceIds: ["dismissed"],
				classification: "STALE",
				severity: "P0",
				reason: "Already validated elsewhere.",
				counterEvidence: "The caller validates.",
			},
		],
		coverage: [{ lens: "security", checked: ["Input boundaries"] }],
		scope: "phase",
		phaseIndex: 0,
		round: 2,
		startCommit: "abc123",
		fingerprint: "snapshot",
		discarded: false,
		checksAreLatest: false,
	},
});
afterEach(cleanup);

it("prioritizes verified blockers and exposes evidence and verifier reasoning", async () => {
	const user = userEvent.setup();
	render(<ExecutionReview review={review} />);
	const list = screen.getAllByRole("list")[0];
	if (!list) throw new Error("Expected findings list");
	expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
		"Missing validation",
	);
	expect(
		within(list.children[0] as HTMLElement).getByText("src/api.ts:12"),
	).toBeVisible();
	expect(
		within(list.children[0] as HTMLElement).getByText(finding.consequence),
	).toBeVisible();
	expect(screen.getByText("Round 2", { exact: false })).toBeVisible();
	expect(screen.queryByText("Round 9", { exact: false })).toBeNull();
	expect(
		screen.getByText("Old concern", { exact: false }).closest("details"),
	).not.toHaveAttribute("open");
	const dismissed = screen
		.getByText("Old concern", { exact: false })
		.closest("li");
	if (!dismissed) throw new Error("Expected dismissed finding");
	await user.click(within(dismissed).getByText("Verifier reasoning"));
	expect(
		screen.getByText("Counter-evidence: The caller validates."),
	).toBeVisible();
});

it("shows missing coverage, recorded checks and the reviewed snapshot", async () => {
	render(<ExecutionReviewContext review={review} />);
	expect(screen.getByText("architecture")).toBeVisible();
	expect(screen.getByText("Phase 1")).toBeVisible();
	expect(screen.getByText("abc123")).toBeVisible();
	await userEvent.click(screen.getByText("Recorded checks (1)"));
	expect(screen.getByText("Input boundaries")).toBeVisible();
});

it("handles discarded, legacy and missing evidence without implying approval", () => {
	if (!review.details) throw new Error("Expected review details");
	const view = render(
		<ExecutionReview
			review={{ ...review, details: { ...review.details, discarded: true } }}
		/>,
	);
	expect(screen.getByRole("status")).toHaveTextContent("Evidence discarded");
	view.rerender(
		<ExecutionReview
			review={{ ...review, details: undefined, blockers: undefined }}
		/>,
	);
	expect(
		screen.getByText("Finding details are unavailable for this saved review."),
	).toBeVisible();
	expect(
		screen.getByText("Review round unavailable", { exact: false }),
	).toBeVisible();
	view.rerender(<ExecutionReview review={null} />);
	expect(screen.getByText("No review evidence available")).toBeVisible();
});

it("keeps checks in the review rail and labels their association with the review", () => {
	if (!review.details) throw new Error("Expected review details");
	const execution = ExecutionSummary.parse({
		runId: "run",
		sourceRunId: "plan",
		prId: "pr",
		status: "active",
		outcome: null,
		stage: "Repair",
		phaseIndex: 1,
		scope: "phase",
		branch: "work",
		worktree: "/work",
		statusDetail: null,
		escalationReason: null,
		checks: [{ name: "unit", status: "passed" }],
		review,
	});
	const props = {
		execution,
		view: "review" as const,
		gate: null,
		token: "token",
		onRefresh: async () => {},
		onSelectRun: () => {},
	};
	const view = render(<ExecutionView {...props} />);
	expect(
		within(screen.getByRole("complementary")).getByText("Latest checks"),
	).toBeVisible();
	expect(
		screen.getByText(/association with this review is not established/),
	).toBeVisible();
	view.rerender(
		<ExecutionView
			{...props}
			execution={{
				...execution,
				review: {
					...review,
					details: { ...review.details, checksAreLatest: true },
				},
			}}
		/>,
	);
	expect(
		screen.getByText("Latest checks are the checks referenced by this review."),
	).toBeVisible();
});
