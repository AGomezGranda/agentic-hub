import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ActivityTimeline } from "./ActivityTimeline.tsx";

const ATTEMPT_ID = "8f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const STEP_ID = "9f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const timestamp = "2026-10-30T00:00:00.000Z";

afterEach(cleanup);

it("keeps agent output as text inside an expandable attempt", async () => {
	const user = userEvent.setup();
	render(
		<ActivityTimeline
			events={[
				{
					type: "attempt.started",
					attemptId: ATTEMPT_ID,
					stepId: STEP_ID,
					role: "planner",
					runner: "pi",
					model: null,
					roleSpecSha: null,
					inputArtifacts: [],
					seq: 1,
					at: timestamp,
				},
				{
					type: "attempt.event",
					attemptId: ATTEMPT_ID,
					event: { type: "message", text: "<script>alert('unsafe')</script>" },
					seq: 2,
					at: timestamp,
				},
			]}
		/>,
	);
	const details = screen.getByText("Attempt: planner").closest("details");
	expect(details).not.toHaveAttribute("open");
	await user.click(screen.getByText("Attempt: planner"));
	expect(details).toHaveAttribute("open");
	expect(
		within(details as HTMLElement).getByText(
			"<script>alert('unsafe')</script>",
		),
	).toBeInTheDocument();
	expect(document.querySelector("script")).toBeNull();
});

it("filters attempts while retaining new events and their order", async () => {
	const user = userEvent.setup();
	const first = {
		type: "step.started" as const,
		stepId: STEP_ID,
		name: "planning",
		seq: 1,
		at: timestamp,
	};
	const attempt = {
		type: "attempt.started" as const,
		attemptId: ATTEMPT_ID,
		stepId: STEP_ID,
		role: "planner",
		runner: "pi",
		model: null,
		roleSpecSha: null,
		inputArtifacts: [],
		seq: 2,
		at: timestamp,
	};
	const last = {
		type: "step.finished" as const,
		stepId: STEP_ID,
		outcome: "succeeded" as const,
		seq: 3,
		at: timestamp,
	};
	const view = render(<ActivityTimeline events={[first]} />);
	await user.selectOptions(
		screen.getByLabelText("Activity filter"),
		"attempts",
	);
	expect(
		screen.getByText("No agent attempts recorded yet."),
	).toBeInTheDocument();
	view.rerender(<ActivityTimeline events={[first, attempt, last]} />);
	expect(screen.getByText("Attempt: planner")).toBeInTheDocument();
	expect(screen.queryByText("Started · planning")).not.toBeInTheDocument();
	await user.selectOptions(screen.getByLabelText("Activity filter"), "all");
	const list = screen.getByRole("list");
	expect(
		within(list)
			.getAllByRole("listitem")
			.map((item) => item.textContent),
	).toEqual([
		expect.stringContaining("Started · planning"),
		expect.stringContaining("Attempt: planner"),
		expect.stringContaining("Step succeeded"),
	]);
});
