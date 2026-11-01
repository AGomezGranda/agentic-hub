import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SwarmAgentDetails } from "./SwarmAgentDetails.tsx";
import type { SwarmAttempt } from "./swarmState.ts";

afterEach(cleanup);
it("shows recorded text literally and closes by keyboard", async () => {
	const attempt: SwarmAttempt = {
		id: "a",
		role: "reviewer",
		model: null,
		status: "running",
		startedAt: "2026-11-01",
		activity: "Agent message",
		events: [
			{
				seq: 1,
				at: "2026-11-01",
				type: "attempt.event",
				attemptId: "a",
				event: { type: "message", text: "<img src=x>" },
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
	expect(screen.getByText("<img src=x>")).toBeTruthy();
	expect(document.querySelector("img")).toBeNull();
	const user = userEvent.setup();
	await user.tab();
	await user.keyboard("{Enter}");
	expect(close).toHaveBeenCalledOnce();
});
