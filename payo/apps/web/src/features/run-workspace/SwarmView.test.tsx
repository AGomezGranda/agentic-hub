import type { RunEvent } from "@payo/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SwarmView } from "./SwarmView.tsx";

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute("open");
	};
});
afterEach(cleanup);
it.each([
	["review:", "Review swarm"],
	["implementation-review:", "Implementation review swarm"],
])(
	"groups %s lenses into one column without combining separate rounds",
	(prefix, title) => {
		const events = [
			"plan",
			`${prefix}architecture`,
			`${prefix}security`,
			"verify",
			`${prefix}architecture`,
			`${prefix}security`,
		].map((name, index) => ({
			type: "step.started",
			stepId: String(index),
			name,
			seq: index + 1,
			at: "2026-11-01",
		})) as RunEvent[];
		render(<SwarmView events={events} onOpenWorkspace={vi.fn()} />);
		const swarms = screen.getAllByRole("heading", { name: title });
		expect(swarms).toHaveLength(2);
		for (const heading of swarms) {
			const column = heading.parentElement as HTMLElement;
			expect(within(column).getByText(`${prefix}architecture`)).toBeTruthy();
			expect(within(column).getByText(`${prefix}security`)).toBeTruthy();
		}
		expect(document.querySelectorAll(".swarm-column")).toHaveLength(4);
	},
);

it("scrolls the swarm flow to the start", async () => {
	const scrollTo = vi.fn();
	HTMLElement.prototype.scrollTo = scrollTo;
	const events = [{ type: "step.started", stepId: "s", name: "Review" }].map(
		(event, index) => ({
			...event,
			seq: index + 1,
			at: "2026-11-01",
		}),
	) as RunEvent[];
	render(<SwarmView events={events} onOpenWorkspace={vi.fn()} />);
	await userEvent
		.setup()
		.click(screen.getByRole("button", { name: "Go to start of swarm" }));
	expect(scrollTo).toHaveBeenCalledWith({
		left: 0,
		behavior: expect.stringMatching(/^(auto|smooth)$/),
	});
	Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

it("scrolls the swarm flow to the end", async () => {
	const scrollTo = vi.fn();
	HTMLElement.prototype.scrollTo = scrollTo;
	const events = [{ type: "step.started", stepId: "s", name: "Review" }].map(
		(event, index) => ({
			...event,
			seq: index + 1,
			at: "2026-11-01",
		}),
	) as RunEvent[];
	render(<SwarmView events={events} onOpenWorkspace={vi.fn()} />);
	await userEvent
		.setup()
		.click(screen.getByRole("button", { name: "Go to end of swarm" }));
	expect(scrollTo).toHaveBeenCalledWith({
		left: expect.any(Number),
		behavior: expect.stringMatching(/^(auto|smooth)$/),
	});
	Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
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
	expect(screen.getByText("Agent message")).toBeTruthy();
	await user.tab();
	await user.tab();
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
