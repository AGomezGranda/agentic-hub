import type { OpenQuestion, RunReview as RunReviewData } from "@payo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRun } from "@web/features/runs/api.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import {
	answerQuestion,
	approveRun,
	getRunReview,
	requestChanges,
	resumeRun,
} from "./api.ts";
import { GateActions, type GateCommand } from "./GateActions.tsx";

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

function safeMarkdownUrl(url: string, key: string): string {
	const transformed = defaultUrlTransform(url);
	if (!transformed || key === "src" || url.startsWith("//")) return "";
	const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
	if (scheme && !["http", "https", "mailto"].includes(scheme)) return "";
	return transformed;
}

function Markdown({ children }: { children: string }) {
	return (
		<div className="plan-markdown">
			<ReactMarkdown
				skipHtml
				urlTransform={safeMarkdownUrl}
				components={{
					a: ({ node: _node, href, children: linkChildren, ...props }) =>
						href ? (
							<a
								{...props}
								href={href}
								rel="noopener noreferrer"
								target="_blank"
							>
								{linkChildren}
							</a>
						) : (
							<span>{linkChildren}</span>
						),
					img: () => null,
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
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
		onSuccess: invalidateWorkspace,
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
		onSuccess: invalidateWorkspace,
		onError: async (error) => {
			if (isConflict(error)) await invalidateWorkspace();
		},
	});

	if (run.isPending || review.isPending)
		return (
			<p
				className="rounded-sm border border-[var(--line)] bg-white p-4 text-sm"
				role="status"
			>
				Loading plan review…
			</p>
		);
	if (run.error || review.error) {
		const error = run.error ?? review.error;
		return (
			<div
				className="rounded-sm border border-[#f1c6b3] bg-[#fff5ef] p-4 text-sm text-[#8d421f]"
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
	const actionError = command.error ?? answer.error;
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
			<section className="border-b border-[var(--line)] pb-6">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
							CURRENT DELIVERABLE
						</p>
						<h2 className="mt-1 text-xl font-semibold tracking-tight">Plan</h2>
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
						<div className="mt-5 rounded-sm border border-[var(--line)] bg-[#fbfcfb] p-4 sm:p-6">
							<Markdown>{data.plan.markdown}</Markdown>
						</div>
						{data.plan.editorPath ? (
							<p className="mt-3 text-xs leading-5 text-[var(--muted)]">
								Refresh after editing outside this page. The server rereads the
								file when a command runs, so a concurrent edit can still win.
							</p>
						) : null}
					</>
				) : (
					<p
						className="mt-4 rounded-sm bg-[#f6f8f6] p-4 text-sm text-[var(--muted)]"
						role="status"
					>
						{unavailableMessage(data.plan.reason)}
					</p>
				)}
			</section>

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
						<p className="mt-4 rounded-sm bg-[#fff9e9] px-3 py-2.5 text-sm text-[#765b1d]">
							Review provenance is unknown; findings may be stale against the
							displayed plan.
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
											<span className="rounded-sm bg-[#fff1eb] px-2.5 py-1 text-xs font-bold text-[#8d421f]">
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
							<p className="mt-4 rounded-sm bg-[#f6f8f6] p-4 text-sm text-[var(--muted)]">
								No findings were recorded.
							</p>
						)}
					</>
				) : (
					<p
						className="mt-4 rounded-sm bg-[#f6f8f6] p-4 text-sm text-[var(--muted)]"
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
									className="min-h-24 w-full rounded-sm border border-[var(--line)] bg-white p-3 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[#176b5720]"
									id={`answer-${question.id}`}
									name={`answer-${question.id}`}
									onChange={(event) => {
										const value = event.currentTarget.value;
										setDrafts((current) => ({
											...current,
											[question.id]: value,
										}));
									}}
									value={drafts[question.id] ?? data.answers[question.id] ?? ""}
								/>
								{data.answers[question.id] ? (
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

			{actionError ? (
				<div
					className="rounded-sm border border-[#f1c6b3] bg-[#fff5ef] px-4 py-3 text-sm text-[#8d421f]"
					role="alert"
				>
					<p>{actionMessage}</p>
					<Button
						className="mt-2"
						onClick={() => void invalidateWorkspace()}
						size="small"
						type="button"
						variant="secondary"
					>
						Retry refresh
					</Button>
				</div>
			) : null}
			<GateActions
				answers={data.answers}
				busy={command.isPending || answer.isPending}
				decisionAvailable={decisionAvailable}
				onCommand={(requested) => command.mutate(requested)}
				questions={data.plan.available ? data.plan.questions : []}
				run={run.data}
			/>
		</div>
	);
}

function conflict(message: string): Error {
	return Object.assign(new Error(message), { status: 409, code: "conflict" });
}
