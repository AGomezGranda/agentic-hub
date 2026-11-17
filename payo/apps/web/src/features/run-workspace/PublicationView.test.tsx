import { RunId } from "@payo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationView } from "./PublicationView.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it("shows linkage and explicitly resumes a paused publication", async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ runId: "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e" }),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const refresh = vi.fn();
	const selectRun = vi.fn();
	render(
		<PublicationView
			onSelectRun={selectRun}
			token="token"
			runId="pub"
			publication={{
				sourceRunId: RunId.parse("plan"),
				executionRunId: RunId.parse("exec"),
				stage: "Escalated",
				branch: "branch",
				reviewedCommit: "sha",
				target: {
					host: "github.com",
					owner: "owner",
					name: "repo",
					repositoryId: "1",
					baseBranch: "main",
					baseCommit: "a".repeat(40),
				},
				pr: null,
				reason: "Push uncertain",
			}}
			canResume
			onRefresh={refresh}
		/>,
	);
	expect(screen.getByRole("link", { name: "Execution" })).toHaveAttribute(
		"href",
		"/runs/exec",
	);
	expect(screen.getByText("Push uncertain")).toBeVisible();
	expect(fetchMock).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("link", { name: "Planning" }));
	await userEvent.click(screen.getByRole("link", { name: "Execution" }));
	expect(selectRun.mock.calls).toEqual([["plan"], ["exec"]]);
	await userEvent.click(
		screen.getByRole("button", { name: "Resume publication" }),
	);
	expect(refresh).toHaveBeenCalled();
});
