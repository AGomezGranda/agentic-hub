import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PublishPrForm } from "./PublishPrForm.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
it("previews only on request and publishes edited content only after confirmation", async () => {
	const fetchMock = vi.fn(
		async (url: RequestInfo | URL, _init?: RequestInit) =>
			new Response(
				JSON.stringify(
					String(url).endsWith("/publish")
						? { runId: "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e" }
						: {
								executionRunId: "exec",
								eligible: true,
								errors: [],
								previewHash: "hash",
								title: "Title",
								body: "Body",
								branch: "branch",
								target: {
									host: "github.com",
									owner: "team",
									name: "repo",
									baseBranch: "main",
									repositoryId: "123",
									baseCommit: "a".repeat(40),
								},
								commits: [],
							},
				),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const select = vi.fn();
	const user = userEvent.setup();
	render(<PublishPrForm token="token" runId="exec" onSelectRun={select} />);
	expect(fetchMock).not.toHaveBeenCalled();
	await user.click(screen.getByRole("button", { name: "Review draft PR →" }));
	await screen.findByLabelText("PR title");
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(screen.getByText("github.com/team/repo")).toBeVisible();
	expect(screen.getByText("main ← branch")).toBeVisible();
	await user.click(screen.getByText("Edit description"));
	await user.type(screen.getByLabelText("PR body"), " edited");
	await user.click(screen.getByRole("button", { name: "Create draft PR" }));
	expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
		previewHash: "hash",
		title: "Title",
		body: "Body edited",
	});
	expect(select).toHaveBeenCalled();
});
it("shows server eligibility errors without offering publication", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						executionRunId: "exec",
						eligible: false,
						errors: ["Legacy execution"],
						commits: [],
					}),
				),
		),
	);
	render(<PublishPrForm token="token" runId="exec" onSelectRun={() => {}} />);
	await userEvent.click(
		screen.getByRole("button", { name: "Review draft PR →" }),
	);
	expect(await screen.findByText("Legacy execution")).toBeVisible();
	expect(screen.queryByRole("button", { name: "Create draft PR" })).toBeNull();
});

it("cancels without publishing and requests a fresh preview when reopened", async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					executionRunId: "exec",
					eligible: true,
					errors: [],
					previewHash: "hash",
					title: "Title",
					body: "Body",
					commits: [],
				}),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const user = userEvent.setup();
	render(<PublishPrForm token="token" runId="exec" onSelectRun={() => {}} />);
	const open = screen.getByRole("button", { name: "Review draft PR →" });
	expect(open).toHaveAttribute("aria-expanded", "false");
	await user.click(open);
	await screen.findByLabelText("PR title");
	expect(open).toHaveAttribute("aria-expanded", "true");
	await user.click(screen.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByLabelText("PR title")).toBeNull();
	expect(open).toHaveFocus();
	expect(fetchMock).toHaveBeenCalledTimes(1);
	await user.click(screen.getByRole("button", { name: "Review draft PR →" }));
	await screen.findByLabelText("PR title");
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps edits after a publish error and allows refreshing a stale preview", async () => {
	const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
		String(url).endsWith("/publish")
			? new Response(
					JSON.stringify({ code: "conflict", message: "Preview is stale" }),
					{
						status: 409,
					},
				)
			: new Response(
					JSON.stringify({
						executionRunId: "exec",
						eligible: true,
						errors: [],
						previewHash: "hash",
						title: "Title",
						body: "Body",
						commits: [],
					}),
				),
	);
	vi.stubGlobal("fetch", fetchMock);
	const user = userEvent.setup();
	render(<PublishPrForm token="token" runId="exec" onSelectRun={() => {}} />);
	await user.click(screen.getByRole("button", { name: "Review draft PR →" }));
	const title = await screen.findByLabelText("PR title");
	await user.clear(title);
	expect(
		screen.getByRole("button", { name: "Create draft PR" }),
	).toBeDisabled();
	await user.type(title, "Edited title");
	await user.click(screen.getByRole("button", { name: "Create draft PR" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Preview is stale",
	);
	expect(title).toHaveValue("Edited title");
	await user.click(screen.getByRole("button", { name: "Refresh preview" }));
	await screen.findByDisplayValue("Title");
	expect(screen.queryByRole("alert")).toBeNull();
});
