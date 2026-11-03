import type { SwarmAttempt } from "@payo/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SwarmAgentDetails } from "./SwarmAgentDetails.tsx";

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute("open");
	};
});
afterEach(cleanup);
it("renders markdown safely and closes by keyboard", async () => {
	const attempt: SwarmAttempt = {
		id: "a",
		role: "reviewer",
		model: null,
		status: "running",
		startedAt: "2026-11-01",
		events: [
			{
				seq: 1,
				at: "2026-11-01",
				type: "attempt.event",
				attemptId: "a",
				event: {
					type: "message",
					text: "## Findings\n\n**Important**\n\n[unsafe](javascript:alert(1))\n\n<img src=x>",
				},
			},
		],
	};
	const close = vi.fn();
	render(
		<SwarmAgentDetails
			attempt={attempt}
			onClose={close}
			onOpenRun={() => {}}
		/>,
	);
	expect(screen.getByRole("heading", { name: "Findings" })).toBeTruthy();
	expect(screen.getByText("Important").tagName).toBe("STRONG");
	expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
	expect(document.querySelector("img")).toBeNull();
	const user = userEvent.setup();
	await user.tab();
	await user.keyboard("{Enter}");
	expect(close).toHaveBeenCalledOnce();
	fireEvent(
		screen.getByRole("dialog", { name: "reviewer details" }),
		new Event("cancel", { cancelable: true }),
	);
	expect(close).toHaveBeenCalledTimes(2);
});

it("renders structured plan markdown and retains the full data", async () => {
	const attempt: SwarmAttempt = {
		id: "a",
		role: "planner",
		model: null,
		status: "running",
		startedAt: "2026-11-01",
		events: [
			{
				seq: 1,
				at: "2026-11-01",
				type: "attempt.event",
				attemptId: "a",
				event: {
					type: "message",
					text: JSON.stringify({
						markdown: "## Understanding\n\nA **plan**.",
						openQuestions: [{ id: "q", question: "Ready?" }],
					}),
				},
			},
			{
				seq: 2,
				at: "2026-11-01",
				type: "attempt.event",
				attemptId: "a",
				event: {
					type: "result",
					text: JSON.stringify({
						plan: { markdown: "## Revised plan" },
						unreconciledFindingIds: ["f1"],
					}),
				},
			},
			{
				seq: 3,
				at: "2026-11-01",
				type: "attempt.event",
				attemptId: "a",
				event: { type: "message", text: "{not json" },
			},
		],
	};
	render(
		<SwarmAgentDetails
			attempt={attempt}
			onClose={() => {}}
			onOpenRun={() => {}}
		/>,
	);
	expect(screen.getByRole("heading", { name: "Understanding" })).toBeTruthy();
	expect(screen.getByText("plan").tagName).toBe("STRONG");
	expect(screen.getByRole("heading", { name: "Revised plan" })).toBeTruthy();
	expect(screen.getByText("{not json")).toBeTruthy();
	const details = screen.getAllByText("Structured data");
	await userEvent.click(details[0] as HTMLElement);
	expect(screen.getByText(/Ready\?/).textContent).toContain('"openQuestions"');
	await userEvent.click(details[1] as HTMLElement);
	expect(screen.getByText(/unreconciledFindingIds/).textContent).toContain(
		"f1",
	);
});
