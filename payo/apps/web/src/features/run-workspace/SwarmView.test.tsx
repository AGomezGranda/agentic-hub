import type { RunEvent } from "@payo/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SwarmView } from "./SwarmView.tsx";

afterEach(cleanup);
it("groups each review swarm into one column without combining separate rounds", () => {
	const events = [
		"plan",
		"review:architecture",
		"review:security",
		"verify",
		"review:architecture",
		"review:security",
	].map((name, index) => ({
		type: "step.started",
		stepId: String(index),
		name,
		seq: index + 1,
		at: "2026-11-01",
	})) as RunEvent[];
	render(<SwarmView events={events} onOpenWorkspace={vi.fn()} />);
	const swarms = screen.getAllByRole("heading", { name: "Review swarm" });
	expect(swarms).toHaveLength(2);
	for (const heading of swarms) {
		const column = heading.parentElement as HTMLElement;
		expect(within(column).getByText("review:architecture")).toBeTruthy();
		expect(within(column).getByText("review:security")).toBeTruthy();
	}
});

it("shows parallel agents for the run and keeps details selected when activity arrives", async () => {
	const events = [
		{ type: "step.started", stepId: "s", name: "Review" },
		{
			type: "attempt.started",
			attemptId: "a",
			stepId: "s",
			role: "reviewer",
			model: "m",
		},
		{
			type: "attempt.started",
			attemptId: "b",
			stepId: "s",
			role: "security",
			model: null,
		},
		{
			type: "attempt.event",
			attemptId: "a",
			event: { type: "message", text: "private output" },
		},
	].map((event, index) => ({
		...event,
		seq: index + 1,
		at: "2026-11-01",
	})) as RunEvent[];
	const user = userEvent.setup();
	const { rerender } = render(
		<SwarmView events={events} onOpenWorkspace={vi.fn()} />,
	);
	expect(screen.getByRole("button", { name: "security" })).toBeTruthy();
	expect(screen.queryByText("private output")).toBeNull();
	await user.tab();
	await user.keyboard("{Enter}");
	expect(screen.getByText("private output")).toBeTruthy();
	const next = [
		...events,
		{
			seq: 5,
			at: "2026-11-01",
			type: "attempt.event",
			attemptId: "a",
			event: { type: "result", text: "new result" },
		} as RunEvent,
	];
	rerender(<SwarmView events={next} onOpenWorkspace={vi.fn()} />);
	expect(screen.getByText("new result")).toBeTruthy();
	await user.click(screen.getByRole("button", { name: "Close details" }));
	expect(screen.queryByText("private output")).toBeNull();
});
