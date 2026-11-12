import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "./api.ts";
import { ImplementPrForm } from "./ImplementPrForm.tsx";

vi.mock("./api.ts", () => ({
	implementRun: vi.fn(),
	previewImplementation: vi.fn(),
}));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
const preview = {
	candidates: ["ABC-123", "DEF-456"],
	ticketId: "ABC-123",
	slug: "create-todo-entity",
	branch: "ABC-123/create-todo-entity",
	commitSubject: "[ABC-123] Create entity",
	prTitle: "[ABC-123] Create todo entity",
	errors: {},
	previewHash: "hash",
};
function mount() {
	const select = vi.fn();
	render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ImplementPrForm
				token="token"
				runId="source"
				units={[
					{
						id: "pr1",
						title: "Create todo entity",
						phases: [{ title: "Build", line: null }],
						issues: [],
					},
				]}
				approved
				defaultBase="main"
				onSelectRun={select}
			/>
		</QueryClientProvider>,
	);
	return { user: userEvent.setup(), select };
}
it("previews server naming before explicit confirmation and invalidates edited choices", async () => {
	vi.mocked(api.previewImplementation).mockResolvedValue(preview);
	vi.mocked(api.implementRun).mockResolvedValue({ runId: "child" });
	const { user, select } = mount();
	await user.click(screen.getByRole("button", { name: "Implement pr1" }));
	expect(api.implementRun).not.toHaveBeenCalled();
	expect(await screen.findByText(preview.branch)).toBeVisible();
	await user.type(screen.getByLabelText("Branch slug"), "-edited");
	expect(
		screen.queryByRole("button", { name: "Confirm implementation" }),
	).toBeNull();
	await user.click(
		screen.getByRole("button", { name: "Refresh naming preview" }),
	);
	await user.click(
		await screen.findByRole("button", { name: "Confirm implementation" }),
	);
	expect(api.implementRun).toHaveBeenCalledWith("token", "source", {
		prId: "pr1",
		naming: {
			previewHash: "hash",
			ticketId: "ABC-123",
			slug: "create-todo-entity",
		},
	});
	expect(select).toHaveBeenCalledWith("child");
});
it("shows server field errors and supports explicit no-ticket selection", async () => {
	vi.mocked(api.previewImplementation).mockResolvedValue({
		...preview,
		ticketId: undefined,
		previewHash: undefined,
		errors: { ticketId: "Choose a ticket" },
	});
	const { user } = mount();
	await user.click(screen.getByRole("button", { name: "Implement pr1" }));
	expect(await screen.findByText("Choose a ticket")).toBeVisible();
	await user.selectOptions(screen.getByLabelText("Ticket selection"), "none");
	await user.click(
		screen.getByRole("button", { name: "Refresh naming preview" }),
	);
	expect(api.previewImplementation).toHaveBeenLastCalledWith(
		"token",
		"source",
		expect.objectContaining({ ticketId: null }),
	);
});

it("opens an existing execution without a new naming selection", async () => {
	vi.mocked(api.implementRun).mockResolvedValue({ runId: "existing" });
	const { user, select } = mount();
	await user.click(
		screen.getByRole("button", { name: "Open existing workspace" }),
	);
	expect(api.previewImplementation).not.toHaveBeenCalled();
	expect(api.implementRun).toHaveBeenCalledWith("token", "source", {
		prId: "pr1",
	});
	expect(select).toHaveBeenCalledWith("existing");
});
it("invalidates confirmation after a base change", async () => {
	vi.mocked(api.previewImplementation).mockResolvedValue(preview);
	const { user } = mount();
	await user.click(screen.getByRole("button", { name: "Implement pr1" }));
	expect(
		await screen.findByRole("button", { name: "Confirm implementation" }),
	).toBeEnabled();
	await user.click(screen.getByText("Base branch · main"));
	await user.type(screen.getByLabelText("Override base branch"), "feature");
	expect(
		screen.queryByRole("button", { name: "Confirm implementation" }),
	).toBeNull();
	await user.click(screen.getByRole("button", { name: "Implement pr1" }));
	expect(api.previewImplementation).toHaveBeenLastCalledWith(
		"token",
		"source",
		{ prId: "pr1", base: "feature" },
	);
});
