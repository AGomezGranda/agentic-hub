import type { ExecutionSummary, OpenGateSummary } from "@payo/contracts";
import { getRunReview, resumeRun } from "@web/features/plan-review/api.ts";
import { getRun, startRun } from "@web/features/runs/api.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { Markdown } from "@web/shared/ui/Markdown.tsx";
import { type ReactNode, useId, useState } from "react";

export function ExecutionPlanIssues({
	execution,
	gate,
	token,
	onSelectRun,
	onRefresh,
	children,
}: {
	onRefresh: () => Promise<void>;
	children: ReactNode;
	execution: ExecutionSummary;
	gate: OpenGateSummary;
	token: string;
	onSelectRun: (runId: string) => void;
}) {
	const [resolution, setResolution] = useState<
		"answers" | "retry" | "correction"
	>("answers");
	const [decision, setDecision] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<string | null>(null);
	const [context, setContext] = useState<Awaited<
		ReturnType<typeof loadSource>
	> | null>(null);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const decisionId = useId();
	const issues = execution.planIssues ?? [];

	async function resumeWithAnswers() {
		if (pending) return;
		const submitted = [...new Set(issues)].map((issue) => ({
			issue,
			answer: answers[issue]?.trim() ?? "",
		}));
		if (submitted.some(({ answer }) => !answer)) return;
		setPending(true);
		setError(null);
		try {
			await resumeRun(token, execution.runId, {
				gateId: gate.gateId,
				answers: submitted,
			});
			await onRefresh();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Could not resume with answers.",
			);
		} finally {
			setPending(false);
		}
	}

	async function loadSource() {
		const [source, review] = await Promise.all([
			getRun(token, execution.sourceRunId),
			getRunReview(token, execution.sourceRunId),
		]);
		if (source.status !== "ended" || source.outcome !== "approved")
			throw new Error(
				"The source plan is no longer approved. Refresh this execution before continuing.",
			);
		if (!review.plan.available)
			throw new Error(
				"The original approved plan is unavailable. Restore access to it before drafting a correction.",
			);
		return { source, plan: review.plan, answers: review.answers };
	}

	async function openCorrection() {
		setResolution("correction");
		setPending(true);
		setError(null);
		try {
			setContext(await loadSource());
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Could not load the approved plan.",
			);
		} finally {
			setPending(false);
		}
	}

	async function submit() {
		if (!decision.trim() || pending || created) return;
		setPending(true);
		setError(null);
		try {
			const [current, fresh] = await Promise.all([
				getRun(token, execution.runId),
				loadSource(),
			]);
			if (
				current.status !== "active" ||
				current.execution?.stage !== "Escalated" ||
				current.execution.escalationReason !== execution.escalationReason ||
				JSON.stringify(current.execution.planIssues) !==
					JSON.stringify(issues) ||
				!current.openGates.some((item) => item.gateId === gate.gateId)
			)
				throw new Error(
					"The execution conflict changed. Refresh this execution before drafting a correction.",
				);
			const { runId } = await startRun(token, {
				repo: fresh.source.repo,
				baseBranch: fresh.source.baseBranch,
				workItemRequest: {
					source: "prompt",
					text: [
						"Draft a corrected implementation plan for the approved plan below, addressing the reported conflict and the operator's decision. Inspect the existing repository before proposing API names or routes. Preserve unrelated requirements and PR scope. The corrected plan must go through normal review and approval before a replacement execution is started.",
						`Source planning run: ${execution.sourceRunId}\nPaused execution: ${execution.runId}\nAffected PR: ${execution.prId}`,
						`## Approved plan\n${fresh.plan.markdown}`,
						`## Approved PR strategy\n${JSON.stringify(fresh.plan.prStrategy ?? [])}`,
						`## Saved answers\n${JSON.stringify(fresh.answers)}`,
						`## Reported plan issues\n${issues.join("\n\n")}`,
						`## Saved issue answers\n${JSON.stringify(execution.issueAnswers ?? [])}`,
						`## Operator decision\n${decision.trim()}`,
						`## Retained work\nOriginal workspace: ${execution.worktree ?? "unavailable"}\nOriginal branch: ${execution.branch ?? "unavailable"}\nThe original execution remains paused. Its edits are not transferred automatically. Do not modify that workspace; draft the corrected plan against this planning run's repository base.`,
					].join("\n\n"),
				},
			});
			setCreated(runId);
			onSelectRun(runId);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Could not draft a corrected plan.",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<section className="space-y-4" aria-label="Plan conflict">
			<div>
				<h3 className="text-lg font-semibold">Reported plan issue</h3>
			</div>
			<ol className="space-y-4">
				{[...new Set(issues)].map((issue, index) => (
					<IssueCard key={issue} report={issue} number={index + 1} />
				))}
			</ol>
			<div className="plan-issue-resolution">
				<p className="workspace-label">RESOLUTION / CHOOSE HOW TO PROCEED</p>
				<fieldset
					className="plan-issue-options"
					aria-label="Plan issue resolution"
				>
					<Button
						type="button"
						variant="secondary"
						aria-pressed={resolution === "answers"}
						disabled={pending}
						onClick={() => {
							setResolution("answers");
							setError(null);
						}}
					>
						Clarify implementation
					</Button>
					<Button
						type="button"
						variant="secondary"
						aria-pressed={resolution === "retry"}
						disabled={pending}
						onClick={() => {
							setResolution("retry");
							setError(null);
						}}
					>
						Retry unchanged
					</Button>
					<Button
						type="button"
						variant="secondary"
						aria-pressed={resolution === "correction"}
						disabled={pending || execution.status !== "active"}
						onClick={() => {
							if (context || created) {
								setResolution("correction");
								setError(null);
							} else {
								void openCorrection();
							}
						}}
					>
						Draft a plan correction
					</Button>
				</fieldset>
				{resolution === "answers" && (
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							void resumeWithAnswers();
						}}
					>
						<p>
							Answer each issue to continue in this workspace with the approved
							plan and retained edits. Use this when implementation needs
							clarification.
						</p>
						{[...new Set(issues)].map((issue, index) => (
							<label key={issue} className="block space-y-2 font-semibold">
								<span>Your answer to issue {index + 1}</span>
								<textarea
									required
									value={answers[issue] ?? ""}
									disabled={
										pending ||
										execution.status !== "active" ||
										!gate.allowedCommands.includes("resume")
									}
									onChange={(event) => {
										const answer = event.currentTarget.value;
										setAnswers((current) => ({ ...current, [issue]: answer }));
									}}
									className="min-h-24 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] p-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
									placeholder="Explain how to proceed or provide the missing context."
								/>
							</label>
						))}
						<Button
							type="submit"
							disabled={
								pending ||
								execution.status !== "active" ||
								!gate.allowedCommands.includes("resume") ||
								issues.some((issue) => !answers[issue]?.trim())
							}
						>
							{pending ? "Working…" : "Resume with answers"}
						</Button>
					</form>
				)}
				{resolution === "retry" && children}
				{resolution === "correction" && (
					<div className="space-y-4">
						<p className="text-xs text-[var(--muted)]">
							Change required behavior through a corrected plan and a new
							approval. The original execution stays paused; retained edits are
							not transferred automatically.
						</p>
						{created ? (
							<Button type="button" onClick={() => onSelectRun(created)}>
								Open corrected plan
							</Button>
						) : (
							<form
								className="space-y-4"
								onSubmit={(event) => {
									event.preventDefault();
									void submit();
								}}
							>
								<h4 className="font-semibold">Draft a corrected plan</h4>
								{context && (
									<details>
										<summary className="cursor-pointer font-semibold">
											View approved plan
										</summary>
										<div className="mt-3 max-h-96 overflow-auto rounded-sm bg-[var(--surface)] p-4">
											<Markdown>{context.plan.markdown}</Markdown>
										</div>
									</details>
								)}
								<label
									className="block space-y-2 font-semibold"
									htmlFor={decisionId}
								>
									<span>Your decision</span>
									<textarea
										id={decisionId}
										required
										value={decision}
										onChange={(event) => setDecision(event.currentTarget.value)}
										className="min-h-28 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] p-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
										placeholder="Describe which behavior to preserve and what the corrected plan should change."
									/>
								</label>
								<p>
									The approved plan, saved answers, reported issues, and your
									decision will be included as context. Creating this draft does
									not approve a plan or start implementation.
								</p>
								<div className="flex flex-wrap gap-2">
									<Button
										type="submit"
										disabled={!context || !decision.trim() || pending}
									>
										{pending ? "Working…" : "Draft corrected plan"}
									</Button>
									<Button
										type="button"
										variant="quiet"
										disabled={pending}
										onClick={() => {
											setResolution("answers");
											setError(null);
										}}
									>
										Cancel
									</Button>
									{!context && !pending && (
										<Button
											type="button"
											variant="secondary"
											onClick={() => void openCorrection()}
										>
											Retry loading plan
										</Button>
									)}
								</div>
								{pending && (
									<p role="status">
										{context
											? "Preparing the corrected planning run…"
											: "Loading the approved plan…"}
									</p>
								)}
							</form>
						)}
					</div>
				)}
				{error && (
					<p role="alert" className="break-words">
						{error}
					</p>
				)}
			</div>
		</section>
	);
}

function IssueCard({ report, number }: { report: string; number: number }) {
	// shortcut: older reports are prose; use the skill's labels when present and preserve other formats in full.
	const match = report
		.trim()
		.match(
			/^Issue in ([^:\n]+):\s*Expected:\s*([\s\S]+?)\s+Found:\s*([\s\S]+?)\s+Why this matters:\s*([\s\S]+?)(?:\s+How should I proceed\?\s*([\s\S]*))?$/,
		);
	return (
		<li className="rounded-sm border border-[var(--warning-border)] bg-[var(--surface)] p-4">
			<h4 className="mb-3 font-semibold">
				{match ? `Issue ${number} · ${match[1]}` : `Issue ${number}`}
			</h4>
			{match ? (
				<>
					<dl className="grid gap-4 md:grid-cols-2">
						{[
							["Plan expects", match[2]],
							["Repository has", match[3]],
							["Impact", match[4]],
							["Decision needed", match[5]],
						]
							.filter(([, value]) => value)
							.map(([label, value]) => (
								<div key={label} className="min-w-0">
									<dt className="mb-1 text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
										{label}
									</dt>
									<dd className="break-words">
										<Markdown>{value ?? ""}</Markdown>
									</dd>
								</div>
							))}
					</dl>
					<details className="mt-4 border-t border-[var(--line)] pt-3">
						<summary className="cursor-pointer text-xs font-semibold">
							Show full report
						</summary>
						<p className="mt-3 whitespace-pre-wrap break-words">{report}</p>
					</details>
				</>
			) : (
				<div className="whitespace-pre-wrap break-words">
					<Markdown>{report}</Markdown>
				</div>
			)}
		</li>
	);
}
