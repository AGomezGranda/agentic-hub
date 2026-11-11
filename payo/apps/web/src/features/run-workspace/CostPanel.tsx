import type { CostSummary, RunCostTree } from "@payo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@web/shared/ui/Button.tsx";
import { getWorkCosts } from "./api.ts";

const amountFormat = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 6,
});

export function CostPanel({ token, runId }: { token: string; runId: string }) {
	const costs = useQuery({
		queryKey: ["costs", token, runId],
		queryFn: ({ signal }) => getWorkCosts(token, runId, signal),
		refetchInterval: (query) => {
			const data = query.state.data;
			return data &&
				(data.planning.status === "active" ||
					data.executions.some(({ run }) => run.status === "active"))
				? 5_000
				: false;
		},
	});
	const tree = costs.data;
	return (
		<section
			aria-label="Work costs"
			className="border border-[var(--line)] border-l-2 border-l-[var(--accent)] bg-[var(--surface)] px-4 py-4 sm:px-5"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="execution-label uppercase">Work cost</h2>
					<p className="mt-1 text-xs text-[var(--muted)]">
						Planning + all PR executions
					</p>
				</div>
				{tree && (
					<div className="text-right text-lg font-semibold text-[var(--accent)]">
						<CostValue cost={tree.total} />
					</div>
				)}
			</div>
			{costs.isPending && (
				<p role="status" className="mt-3 text-sm text-[var(--muted)]">
					Loading costs…
				</p>
			)}
			{costs.error && (
				<div role="alert" className="mt-3 text-sm text-[var(--status-warn)]">
					<p>
						{tree
							? "Cost refresh failed; showing last loaded costs."
							: "Could not load costs."}{" "}
						{costs.error.message}
					</p>
					<Button
						type="button"
						size="small"
						variant="quiet"
						onClick={() => void costs.refetch()}
					>
						Retry costs
					</Button>
				</div>
			)}
			{tree && (
				<>
					<p
						className={`mt-3 text-xs ${tree.total.coverage === "complete" ? "text-[var(--muted)]" : "text-[var(--status-warn)]"}`}
					>
						{tree.total.attempts === 0
							? "No attempts yet"
							: `${tree.total.coverage === "complete" ? "Complete" : tree.total.coverage === "partial" ? "Partial" : "Unknown"} coverage · ${tree.total.attempts} attempt${tree.total.attempts === 1 ? "" : "s"}`}
						{tree.total.incompleteAttempts > 0 &&
							` · ${tree.total.incompleteAttempts} with incomplete costs. Amounts may increase.`}
					</p>
					<details className="mt-3 border-t border-[var(--line)] pt-3 text-sm">
						<summary className="text-xs font-semibold text-[var(--muted)]">
							Cost breakdown
						</summary>
						<div className="mt-3 space-y-2">
							<RunCosts
								title="Planning"
								run={tree.planning}
								currentRunId={runId}
							/>
							{tree.executions.map(({ prId, run }) => (
								<RunCosts
									key={run.runId}
									title={`Execution · ${prId}`}
									run={run}
									currentRunId={runId}
								/>
							))}
							{tree.executions.length === 0 && (
								<p className="text-xs text-[var(--muted)]">
									No PR executions yet.
								</p>
							)}
						</div>
					</details>
				</>
			)}
		</section>
	);
}

function RunCosts({
	title,
	run,
	currentRunId,
}: {
	title: string;
	run: RunCostTree;
	currentRunId: string;
}) {
	return (
		<details
			className="min-w-0 border border-[var(--line)] bg-[var(--canvas)] p-3"
			open={run.runId === currentRunId}
		>
			<summary>
				<span className="inline-flex max-w-[calc(100%_-_1.25rem)] flex-wrap items-baseline gap-x-4 gap-y-1 align-top">
					<span className="font-semibold">{title}</span>
					<span className="text-xs text-[var(--muted)]">
						{run.status === "active" ? "Active" : (run.outcome ?? "Ended")}
						{run.runId === currentRunId ? " · Current run" : ""}
					</span>
					<CostValue cost={run.cost} />
				</span>
			</summary>
			<p className="my-3 break-all text-xs text-[var(--muted)]">
				Run {run.runId}
			</p>
			{run.steps.length === 0 && (
				<p className="text-xs text-[var(--muted)]">No steps yet.</p>
			)}
			{run.steps.map((step) => (
				<details
					key={step.stepId}
					className="border-t border-[var(--line)] py-3"
				>
					<summary>
						<span className="inline-flex max-w-[calc(100%_-_1.25rem)] flex-wrap items-baseline gap-x-4 gap-y-1 align-top">
							<span className="break-all">{step.name}</span>
							<span className="text-xs text-[var(--muted)]">
								{step.attempts.length} attempt
								{step.attempts.length === 1 ? "" : "s"} · {step.status}
							</span>
							<CostValue cost={step.cost} />
						</span>
					</summary>
					<ul className="mt-3 space-y-3 pl-4">
						{step.attempts.map((attempt, index) => (
							<li
								key={attempt.attemptId}
								className="flex flex-wrap items-baseline justify-between gap-2 border-l border-[var(--line)] pl-3 text-xs"
							>
								<div className="min-w-0 break-words">
									<p>
										Attempt {index + 1} · {attempt.role} ·{" "}
										{attempt.status.replaceAll("_", " ")}
									</p>
									{attempt.model && (
										<p className="mt-1 text-[var(--muted)]">{attempt.model}</p>
									)}
								</div>
								<CostValue cost={attempt.cost} />
							</li>
						))}
					</ul>
				</details>
			))}
		</details>
	);
}

function CostValue({ cost }: { cost: CostSummary }) {
	return (
		<span className="inline-flex flex-col gap-1 tabular-nums">
			{cost.amounts.map(({ amount, currency, basis }) => (
				<span
					key={`${currency}:${basis}`}
					title={`${currency} ${amount} · ${basis}`}
				>
					{currency}{" "}
					{amount > 0 && amount < 0.000001
						? "<0.000001"
						: amountFormat.format(amount)}{" "}
					<span className="text-[10px] font-normal text-[var(--muted)]">
						{basis === "estimated" ? "Estimated" : "Provider reported"}
					</span>
				</span>
			))}
			{cost.amounts.length === 0 && (
				<span className="text-[var(--muted)]">
					{cost.attempts === 0 ? "No spend yet" : "Unavailable"}
				</span>
			)}
			{cost.coverage !== "complete" && (
				<span className="text-[10px] font-normal text-[var(--status-warn)]">
					{cost.coverage === "partial" ? "Partial costs" : "Unknown costs"}
				</span>
			)}
		</span>
	);
}
