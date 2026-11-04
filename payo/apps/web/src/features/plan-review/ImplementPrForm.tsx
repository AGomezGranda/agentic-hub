import type { RunReview } from "@payo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";
import { implementRun } from "./api.ts";

type AvailablePlan = Extract<RunReview["plan"], { available: true }>;

export function ImplementPrForm({
	token,
	runId,
	units,
	approved,
	defaultBase,
	onSelectRun,
}: {
	token: string;
	runId: string;
	units: NonNullable<AvailablePlan["implementation"]>;
	approved: boolean;
	defaultBase: string;
	onSelectRun?: (runId: string) => void;
}) {
	const [base, setBase] = useState("");
	const client = useQueryClient();
	const launch = useMutation({
		mutationFn: (prId: string) =>
			implementRun(token, runId, {
				prId,
				...(base.trim() ? { base: base.trim() } : {}),
			}),
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: ["runs", token] });
			onSelectRun?.(result.runId);
		},
	});
	return (
		<section
			aria-label="Implementation"
			className="space-y-3 border-b border-[var(--line)] pb-6"
		>
			<h2 className="text-xl font-semibold">Implementation</h2>
			<p className="text-sm text-[var(--muted)]">
				{approved
					? "Choose a PR to implement in a local worktree."
					: "Review the phases assigned to each PR before approving the plan."}
			</p>
			{approved && (
				<details className="text-sm">
					<summary className="cursor-pointer">
						Base branch · {base.trim() || defaultBase}
					</summary>
					<label className="mt-2 block">
						Override base branch
						<input
							className="ml-2 rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-2 py-1"
							placeholder={defaultBase}
							value={base}
							disabled={launch.isPending}
							onChange={(event) => setBase(event.target.value)}
						/>
					</label>
				</details>
			)}
			<ol className="divide-y divide-[var(--line)] rounded-sm border border-[var(--line)]">
				{units.map((pr, index) => (
					<li key={pr.id}>
						<details
							open={index === 0 || pr.issues.length > 0}
							className="px-4 py-3"
						>
							<summary className="cursor-pointer font-semibold">
								{pr.id} · {pr.title}
								<span className="ml-2 text-xs font-normal text-[var(--muted)]">
									{pr.phases.length}{" "}
									{pr.phases.length === 1 ? "phase" : "phases"}
								</span>
							</summary>
							<ol className="my-3 list-decimal space-y-1 pl-6 text-sm">
								{pr.phases.map((phase, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: an ordered phase reference may occur more than once.
									<li key={index}>
										{phase.line === null ? (
											phase.title
										) : (
											<a
												className="underline underline-offset-2"
												href={`#plan-line-${phase.line}`}
											>
												{phase.title}
											</a>
										)}
									</li>
								))}
							</ol>
							{pr.issues.map((issue) => (
								<p
									key={issue}
									className="my-2 text-sm text-[var(--status-warn)]"
								>
									{issue}
								</p>
							))}
							{approved && (
								<Button
									type="button"
									size="small"
									disabled={
										pr.issues.length > 0 ||
										!pr.phases.length ||
										launch.isPending
									}
									onClick={() => launch.mutate(pr.id)}
								>
									{launch.isPending && launch.variables === pr.id
										? "Starting…"
										: `Start ${pr.id} locally`}
								</Button>
							)}
							{launch.isError && launch.variables === pr.id && (
								<p className="mt-2 text-sm text-[var(--danger)]" role="alert">
									{launch.error.message}
								</p>
							)}
						</details>
					</li>
				))}
			</ol>
		</section>
	);
}
