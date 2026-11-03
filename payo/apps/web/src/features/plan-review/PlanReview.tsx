import type { OpenQuestion, RunReview as RunReviewData } from "@payo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRun } from "@web/features/runs/api.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { Markdown } from "@web/shared/ui/Markdown.tsx";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
	answerQuestion,
	approveRun,
	getPlanVersions,
	getRunReview,
	requestChanges,
	resumeRun,
	submitPlanUpdate,
} from "./api.ts";
import { GateActions, type GateCommand } from "./GateActions.tsx";
import { PlanHistory } from "./PlanHistory.tsx";

function isConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		error.status === 409
	);
}

function unavailableMessage(reason: string): string {
	switch (reason) {
		case "not_available":
			return "No plan is available yet.";
		case "missing":
			return "The current plan file is missing; the older snapshot is not shown as current.";
		case "unsafe":
			return "The plan path could not be verified as safe.";
		default:
			return "Plan data is unavailable because it could not be validated.";
	}
}

function reviewUnavailableMessage(reason: string): string {
	switch (reason) {
		case "not_available":
			return "No review artifact is available yet.";
		case "missing":
			return "The saved review artifact is missing.";
		default:
			return "Review data is unavailable because it could not be validated.";
	}
}

function refreshError(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The server could not be reached.";
}

export function PlanReview({
	token,
	runId,
	onViewActivity,
}: {
	token: string;
	runId: string;
	onViewActivity?: () => void;
}) {
	const queryClient = useQueryClient();
	const runKey = ["run", token, runId] as const;
	const reviewKey = ["review", token, runId] as const;
	const run = useQuery({
		queryKey: runKey,
		queryFn: ({ signal }) => getRun(token, runId, signal),
		staleTime: 5_000,
	});
	const review = useQuery({
		queryKey: reviewKey,
		queryFn: ({ signal }) => getRunReview(token, runId, signal),
		staleTime: 5_000,
	});
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [prompt, setPrompt] = useState("");
	const [view, setView] = useState<"review" | "history">("review");
	const [revising, setRevising] = useState(false);
	const history = useQuery({
		queryKey: ["plan-versions", token, runId],
		queryFn: ({ signal }) => getPlanVersions(token, runId, signal),
	});

	const refreshBeforeCommand = async () => {
		const [latestRun, latestReview] = await Promise.all([
			getRun(token, runId),
			getRunReview(token, runId),
		]);
		queryClient.setQueryData(runKey, latestRun);
		queryClient.setQueryData(reviewKey, latestReview);
		return { latestRun, latestReview };
	};

	const invalidateWorkspace = useCallback(async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: ["run", token, runId],
				exact: true,
			}),
			queryClient.invalidateQueries({
				queryKey: ["review", token, runId],
				exact: true,
			}),
			queryClient.invalidateQueries({
				queryKey: ["runs", token],
			}),
			queryClient.invalidateQueries({
				queryKey: ["plan-versions", token, runId],
				exact: true,
			}),
		]);
	}, [queryClient, runId, token]);

	useEffect(() => {
		const onFocus = () => void invalidateWorkspace();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [invalidateWorkspace]);

	const answer = useMutation({
		mutationFn: async (input: { question: OpenQuestion; text: string }) => {
			const { latestRun, latestReview } = await refreshBeforeCommand();
			const canAnswer =
				(latestRun.stage === "Approval" || latestRun.stage === "Escalated") &&
				latestReview.plan.available &&
				latestReview.plan.questions.some(
					(question) => question.id === input.question.id,
				);
			if (!canAnswer)
				throw conflict("The current run no longer accepts this answer.");
			return answerQuestion(token, runId, input.question.id, input.text);
		},
		onSuccess: () => {
			clearErrors();
			return invalidateWorkspace();
		},
	});

	const command = useMutation({
		mutationFn: async (requested: GateCommand) => {
			const { latestRun, latestReview } = await refreshBeforeCommand();
			const gate =
				requested === "resume"
					? latestRun.openGates.find(
							(item) =>
								item.kind === "factory-escalation" &&
								item.allowedCommands.includes("resume"),
						)
					: latestRun.openGates.find(
							(item) =>
								item.kind === "approval" &&
								item.allowedCommands.includes(requested),
						);
			if (!gate)
				throw conflict("The current gate no longer allows this command.");
			if (requested !== "resume") {
				if (!latestReview.plan.available || !latestReview.review.available)
					throw new Error(
						"Refresh the unavailable plan and review before deciding.",
					);
				if (
					requested === "approve" &&
					latestReview.plan.questions.some(
						(question) => !latestReview.answers[question.id]?.trim(),
					)
				)
					throw conflict("Answer every open question before approving.");
			}
			switch (requested) {
				case "approve":
					return approveRun(token, runId);
				case "requestChanges":
					return requestChanges(token, runId);
				case "resume":
					return resumeRun(token, runId);
			}
		},
		onSuccess: () => {
			clearErrors();
			return invalidateWorkspace();
		},
		onError: async (error) => {
			if (isConflict(error)) await invalidateWorkspace();
		},
	});

	const update = useMutation({
		mutationFn: async (value: { prompt: string } | { version: number }) => {
			const { latestRun, latestReview } = await refreshBeforeCommand();
			if (
				latestRun.stage !== "Approval" ||
				!latestRun.openGates.some((gate) => gate.kind === "approval") ||
				!latestReview.plan.available ||
				!latestReview.plan.version ||
				!latestReview.plan.workingCopyHash
			)
				throw conflict("The approval gate or plan changed.");
			return submitPlanUpdate(token, runId, {
				...value,
				expectedVersion: latestReview.plan.version,
				expectedWorkingCopyHash: latestReview.plan.workingCopyHash,
			});
		},
		onSuccess: async (_, value) => {
			if ("prompt" in value) {
				setPrompt("");
				setRevising(false);
			}
			setView("review");
			setDrafts({});
			clearErrors();
			await invalidateWorkspace();
		},
		onError: async (error) => {
			if (isConflict(error)) await invalidateWorkspace();
		},
	});

	// A mutation keeps its error until it runs again, so a later success must clear all three.
	function clearErrors() {
		answer.reset();
		command.reset();
		update.reset();
	}

	if (run.isPending || review.isPending)
		return (
			<p
				className="rounded-sm border border-[var(--line)] bg-[var(--surface)] p-4 text-sm"
				role="status"
			>
				Loading plan review…
			</p>
		);
	if (run.error || review.error) {
		const error = run.error ?? review.error;
		return (
			<div
				className="rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] p-4 text-sm text-[var(--danger)]"
				role="alert"
			>
				<p>Could not load plan review: {refreshError(error)}</p>
				<Button
					className="mt-3"
					onClick={() => void Promise.all([run.refetch(), review.refetch()])}
					size="small"
					type="button"
					variant="secondary"
				>
					Retry
				</Button>
			</div>
		);
	}
	if (!run.data || !review.data) return null;

	const data: RunReviewData = review.data;
	const questions =
		data.plan.available &&
		(run.data.stage === "Approval" || run.data.stage === "Escalated")
			? data.plan.questions
			: [];
	const decisionAvailable = data.plan.available && data.review.available;
	const actionError = command.error ?? answer.error ?? update.error;
	const approval =
		run.data.stage === "Approval" &&
		run.data.openGates.some((gate) => gate.kind === "approval");
	const actionMessage = actionError
		? isConflict(actionError)
			? "The run state changed. The latest server state has been refreshed; review it before trying again."
			: refreshError(actionError)
		: null;

	function submitAnswer(
		event: FormEvent<HTMLFormElement>,
		question: OpenQuestion,
	) {
		event.preventDefault();
		const text = (
			drafts[question.id] ??
			data.answers[question.id] ??
			""
		).trim();
		if (text) answer.mutate({ question, text });
	}

	return (
		<div className="space-y-5">
			<nav
				aria-label="Plan workspace"
				className="flex gap-2 border-b border-[var(--line)] pb-3"
			>
				<Button
					variant={view === "review" ? "primary" : "quiet"}
					aria-pressed={view === "review"}
					onClick={() => setView("review")}
				>
					Review
				</Button>
				<Button
					variant={view === "history" ? "primary" : "quiet"}
					aria-pressed={view === "history"}
					onClick={() => setView("history")}
				>
					History
				</Button>
			</nav>
			{view === "history" ? (
				<PlanHistory
					versions={history.data ?? []}
					loading={history.isPending}
					error={history.isError}
					onRetry={() => void history.refetch()}
					onBack={() => setView("review")}
					canRestore={approval}
					busy={update.isPending || command.isPending || answer.isPending}
					onRestore={(version) => update.mutate({ version })}
				/>
			) : (
				<>
					<div className="grid gap-6 min-[1400px]:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
						<section className="border-b border-[var(--line)] pb-6">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
										CURRENT DELIVERABLE · {run.data.stage}
									</p>
									<h2 className="mt-1 text-xl font-semibold tracking-tight">
										Plan
									</h2>
									{data.plan.available && data.plan.version ? (
										<p className="console-eyebrow">
											Working plan · v{data.plan.version}
										</p>
									) : null}
								</div>
								<div className="flex flex-col items-end gap-3 text-right text-xs text-[var(--muted)]">
									{/* biome-ignore lint/a11y/useValidAnchor: Reveal the activity target before navigating to it. */}
									<a
										className="rounded underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
										href="#run-activity"
										onClick={onViewActivity}
									>
										View activity
									</a>
									{data.plan.available && data.plan.editorPath ? (
										<div>
											<p>Open in your editor</p>
											<code className="mt-1 block max-w-full break-all">
												{data.plan.editorPath}
											</code>
											<code className="mt-1 block">payo edit {runId}</code>
										</div>
									) : null}
								</div>
							</div>
							{data.plan.available ? (
								<>
									<div className="mt-5 rounded-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-6">
										<Markdown>{data.plan.markdown}</Markdown>
									</div>
									{data.plan.editorPath ? (
										<p className="mt-3 text-xs leading-5 text-[var(--muted)]">
											Refresh after editing outside this page. The server
											rereads the file when a command runs, so a concurrent edit
											can still win.
										</p>
									) : null}
								</>
							) : (
								<p
									className="mt-4 rounded-sm bg-[var(--surface-raised)] p-4 text-sm text-[var(--muted)]"
									role="status"
								>
									{unavailableMessage(data.plan.reason)}
								</p>
							)}
						</section>

						<div className="min-w-0 space-y-5">
							<section className="border-b border-[var(--line)] pb-6">
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div>
										<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
											PLAN REVIEW
										</p>
										<h2 className="mt-1 text-xl font-semibold tracking-tight">
											Findings and verification
										</h2>
									</div>
								</div>
								{data.review.available ? (
									<>
										<p className="mt-4 rounded-sm bg-[var(--warning-surface)] px-3 py-2.5 text-sm text-[var(--status-warn)]">
											Review provenance is unknown; findings may be stale
											against the displayed plan.
										</p>
										{data.review.uncheckedLenses.length ? (
											<p className="mt-3 text-sm text-[var(--muted)]">
												Unchecked review lenses:{" "}
												{data.review.uncheckedLenses.join(", ")}.
											</p>
										) : null}
										{data.review.verdicts === null ? (
											<p className="mt-3 text-sm text-[var(--muted)]">
												Verifier verdicts are unavailable.
											</p>
										) : (
											<p className="mt-3 text-sm text-[var(--muted)]">
												{data.review.verdicts.length} verifier verdict
												{data.review.verdicts.length === 1 ? "" : "s"} recorded.
											</p>
										)}
										{data.review.findings.length ? (
											<ul className="mt-4 space-y-3">
												{data.review.findings.map((finding) => (
													<li
														className="rounded-sm border border-[var(--line)] p-4"
														key={finding.id}
													>
														<div className="flex flex-wrap items-center gap-2">
															<span className="rounded-sm bg-[var(--danger-surface)] px-2.5 py-1 text-xs font-bold text-[var(--danger)]">
																{finding.severity}
															</span>
															<h3 className="font-semibold">{finding.title}</h3>
														</div>
														{finding.path ? (
															<p className="mt-2 text-xs text-[var(--muted)]">
																{finding.path}
																{finding.line ? `:${finding.line}` : ""}
															</p>
														) : null}
														<dl className="mt-3 space-y-2 text-sm">
															<div>
																<dt className="font-semibold">Evidence</dt>
																<dd className="text-[var(--muted)]">
																	{finding.evidence}
																</dd>
															</div>
															<div>
																<dt className="font-semibold">Consequence</dt>
																<dd className="text-[var(--muted)]">
																	{finding.consequence}
																</dd>
															</div>
															<div>
																<dt className="font-semibold">Suggested fix</dt>
																<dd className="text-[var(--muted)]">
																	{finding.suggestedFix}
																</dd>
															</div>
														</dl>
													</li>
												))}
											</ul>
										) : (
											<p className="mt-4 rounded-sm bg-[var(--surface-raised)] p-4 text-sm text-[var(--muted)]">
												No findings were recorded.
											</p>
										)}
									</>
								) : (
									<p
										className="mt-4 rounded-sm bg-[var(--surface-raised)] p-4 text-sm text-[var(--muted)]"
										role="status"
									>
										{reviewUnavailableMessage(data.review.reason)}
									</p>
								)}
							</section>

							{questions.length ? (
								<section className="border-b border-[var(--line)] pb-6">
									<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
										OPEN QUESTIONS
									</p>
									<h2 className="mt-1 text-xl font-semibold tracking-tight">
										Decisions needed
									</h2>
									<div className="mt-4 space-y-4">
										{questions.map((question) => (
											<form
												className="space-y-2 rounded-sm border border-[var(--line)] p-4"
												key={question.id}
												onSubmit={(event) => submitAnswer(event, question)}
											>
												<label
													className="block text-sm font-semibold"
													htmlFor={`answer-${question.id}`}
												>
													{question.question}
												</label>
												<textarea
													className="min-h-24 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] p-3 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)]"
													id={`answer-${question.id}`}
													name={`answer-${question.id}`}
													onChange={(event) => {
														const value = event.currentTarget.value;
														setDrafts((current) => ({
															...current,
															[question.id]: value,
														}));
													}}
													value={
														drafts[question.id] ??
														data.answers[question.id] ??
														""
													}
												/>
												{drafts[question.id] !== undefined &&
												drafts[question.id] !==
													(data.answers[question.id] ?? "") ? (
													<p className="text-xs">
														Unsaved draft.{" "}
														{data.answers[question.id]
															? `Saved answer: ${data.answers[question.id]}`
															: "No saved answer."}
													</p>
												) : data.answers[question.id] ? (
													<p className="text-xs font-medium text-[var(--status-good)]">
														Saved answer recorded.
													</p>
												) : null}
												<Button
													disabled={
														answer.isPending ||
														!(
															drafts[question.id] ??
															data.answers[question.id] ??
															""
														).trim()
													}
													size="small"
													type="submit"
													variant="secondary"
												>
													{answer.isPending ? "Saving…" : "Save answer"}
												</Button>
											</form>
										))}
									</div>
								</section>
							) : null}
						</div>
					</div>
					{approval ? (
						<div className="flex flex-wrap items-center gap-3">
							<Button
								type="button"
								variant="secondary"
								aria-expanded={revising}
								onClick={() => setRevising(!revising)}
							>
								Revise plan
							</Button>
							<p className="text-xs text-[var(--muted)]">
								Ask the agent to update the plan, then run review again.
							</p>
						</div>
					) : null}
					{approval && revising ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (prompt.trim()) update.mutate({ prompt });
							}}
							className="space-y-3 border-b border-[var(--line)] pb-6"
						>
							<label htmlFor="revision-prompt" className="block font-semibold">
								What should change?
							</label>
							<textarea
								id="revision-prompt"
								className="min-h-24 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] p-3 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)]"
								value={prompt}
								onChange={(event) => setPrompt(event.currentTarget.value)}
							/>
							<Button
								type="submit"
								disabled={
									!prompt.trim() ||
									update.isPending ||
									command.isPending ||
									answer.isPending
								}
							>
								{update.isPending ? "Working…" : "Submit revision"}
							</Button>
							<Button
								type="button"
								variant="quiet"
								onClick={() => setRevising(false)}
							>
								Cancel revision
							</Button>
						</form>
					) : null}
				</>
			)}
			{actionError ? (
				<div
					className="rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] px-4 py-3 text-sm text-[var(--danger)]"
					role="alert"
				>
					<p>{actionMessage}</p>
					<Button
						className="mt-2"
						onClick={() => {
							clearErrors();
							void invalidateWorkspace();
						}}
						size="small"
						type="button"
						variant="secondary"
					>
						Retry refresh
					</Button>
				</div>
			) : null}
			{view === "review" ? (
				<GateActions
					answers={data.answers}
					busy={command.isPending || answer.isPending || update.isPending}
					decisionAvailable={decisionAvailable}
					onCommand={(requested) => command.mutate(requested)}
					questions={data.plan.available ? data.plan.questions : []}
					run={run.data}
				/>
			) : null}
		</div>
	);
}

function conflict(message: string): Error {
	return Object.assign(new Error(message), { status: 409, code: "conflict" });
}
