import type { CostSummary, RunCostTree, WorkCostTree } from "@payo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CostPanel } from "./CostPanel.tsx";

const known = (amount: number): CostSummary => ({
	amounts: [{ currency: "USD", basis: "estimated", amount }],
	coverage: "complete",
	attempts: 1,
	incompleteAttempts: 0,
});
const unknown: CostSummary = {
	amounts: [],
	coverage: "unknown",
	attempts: 1,
	incompleteAttempts: 1,
};

function run(
	runId: string,
	cost: CostSummary,
	status: "active" | "ended" = "ended",
): RunCostTree {
	return {
		runId,
		status,
		outcome: status === "ended" ? "approved" : null,
		asOfSeq: 5,
		cost,
		steps:
			cost.attempts === 0
				? []
				: [
						{
							stepId: "step",
							name: "Plan",
							status: "succeeded",
							cost,
							attempts: [
								{
									attemptId: "attempt",
									stepId: "step",
									role: "planner",
									runner: "pi",
									model: "openai/model",
									roleSpecSha: null,
									inputArtifacts: [],
									status: "failed",
									usage: null,
									cost,
								},
							],
						},
					],
	};
}

function tree(cost = known(0.123456)): WorkCostTree {
	return {
		sourceRunId: "plan",
		planning: run("plan", cost),
		executions: [],
		total: cost,
	};
}

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function show(runId = "plan") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<CostPanel token="secret" runId={runId} />
		</QueryClientProvider>,
	);
	return client;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("shows the work total and expands runs, steps and failed attempts", async () => {
	const data = tree();
	data.executions = [{ prId: "pr-1", run: run("exec", known(0.5)) }];
	data.total = { ...known(0.623456), attempts: 2 };
	const fetchMock = vi.fn(async () => response(data));
	vi.stubGlobal("fetch", fetchMock);
	show("exec");
	expect(await screen.findByText("USD 0.623456")).toBeVisible();
	expect(screen.getByText("Complete coverage · 2 attempts")).toBeVisible();
	expect(fetchMock).toHaveBeenCalledWith(
		expect.stringContaining("/runs/exec/costs"),
		expect.objectContaining({
			headers: expect.objectContaining({ Authorization: "Bearer secret" }),
		}),
	);
	const user = userEvent.setup();
	await user.click(screen.getByText("Cost breakdown"));
	const execution = screen.getByText("Execution · pr-1").closest("details");
	if (!execution) throw new Error("execution details missing");
	expect(execution).toHaveAttribute("open");
	expect(within(execution).getByText("approved · Current run")).toBeVisible();
	await user.click(within(execution).getByText("Plan"));
	expect(
		within(execution).getByText("Attempt 1 · planner · failed"),
	).toBeVisible();
	expect(within(execution).getByText("openai/model")).toBeVisible();
});

it("keeps currencies and reporting bases separate and warns about partial coverage", async () => {
	const partial: CostSummary = {
		amounts: [
			{ currency: "EUR", basis: "provider-reported", amount: 2 },
			{ currency: "USD", basis: "estimated", amount: 0.0000001 },
			{ currency: "USD", basis: "provider-reported", amount: 1 },
		],
		coverage: "partial",
		attempts: 1,
		incompleteAttempts: 1,
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response(tree(partial))),
	);
	show();
	expect((await screen.findAllByText("EUR 2.00"))[0]).toBeVisible();
	expect(screen.getAllByText("USD <0.000001")[0]).toBeVisible();
	expect(screen.getAllByText("USD 1.00")[0]).toBeVisible();
	expect(screen.getAllByText("Estimated")[0]).toBeVisible();
	expect(screen.getAllByText("Provider reported")[0]).toBeVisible();
	expect(screen.getByText(/Partial coverage · 1 attempt/)).toHaveTextContent(
		"1 with incomplete costs. Amounts may increase.",
	);
});

it.each([
	[unknown, "Unavailable", "Unknown coverage"],
	[
		{
			amounts: [],
			coverage: "complete",
			attempts: 0,
			incompleteAttempts: 0,
		} satisfies CostSummary,
		"No spend yet",
		"No attempts yet",
	],
	[known(0), "USD 0.00", "Complete coverage"],
])(
	"distinguishes missing costs, no attempts and a known zero",
	async (cost, label, coverage) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response(tree(cost))),
		);
		show();
		expect((await screen.findAllByText(label))[0]).toBeVisible();
		expect(screen.getByText(new RegExp(coverage))).toBeVisible();
	},
);

it("offers a retry after a cost request fails", async () => {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			response({ code: "internal", message: "Costs unavailable" }, 500),
		)
		.mockImplementation(async () => response(tree()));
	vi.stubGlobal("fetch", fetchMock);
	show();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Could not load costs.",
	);
	await userEvent
		.setup()
		.click(screen.getByRole("button", { name: "Retry costs" }));
	await waitFor(() =>
		expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
	);
	expect(screen.getAllByText("USD 0.123456")[0]).toBeVisible();
});

it("refreshes an active child even when its planning run has ended and stops after completion", async () => {
	vi.useFakeTimers();
	const data = tree();
	data.executions = [{ prId: "pr-1", run: run("exec", known(1), "active") }];
	data.total = { ...known(1.123456), attempts: 2 };
	const fetchMock = vi.fn(async () => response(data));
	vi.stubGlobal("fetch", fetchMock);
	show();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(fetchMock).toHaveBeenCalledTimes(1);
	data.executions[0] = { prId: "pr-1", run: run("exec", known(2)) };
	data.total = { ...known(2.123456), attempts: 2 };
	await act(async () => {
		await vi.advanceTimersByTimeAsync(5_000);
	});
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(screen.getByText("USD 2.123456")).toBeVisible();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10_000);
	});
	expect(fetchMock).toHaveBeenCalledTimes(2);
});
