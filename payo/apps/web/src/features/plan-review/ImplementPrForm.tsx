import type { ImplementPreview, RunReview } from "@payo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";
import { implementRun, previewImplementation } from "./api.ts";

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
	return (
		<section aria-label="Planned PRs" className="workspace-panel space-y-3">
			<h2 className="text-xl font-semibold">Planned PRs</h2>
			<p className="text-sm text-[var(--muted)]">
				{approved
					? "Choose a PR to open its implementation and code review workspace. Work runs in a local worktree."
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
								<NamingConfirmation
									key={`${pr.id}:${base}`}
									token={token}
									runId={runId}
									prId={pr.id}
									base={base.trim()}
									disabled={pr.issues.length > 0 || !pr.phases.length}
									onSelectRun={onSelectRun}
								/>
							)}
						</details>
					</li>
				))}
			</ol>
		</section>
	);
}

function NamingConfirmation({
	token,
	runId,
	prId,
	base,
	disabled,
	onSelectRun,
}: {
	token: string;
	runId: string;
	prId: string;
	base: string;
	disabled: boolean;
	onSelectRun?: (id: string) => void;
}) {
	const client = useQueryClient();
	const [preview, setPreview] = useState<ImplementPreview | null>(null);
	const [visible, setVisible] = useState(false);
	const [ticket, setTicket] = useState("auto");
	const [manual, setManual] = useState("");
	const [slug, setSlug] = useState<string | undefined>();
	const [valid, setValid] = useState(false);
	const lookup = useMutation({
		mutationFn: () =>
			previewImplementation(token, runId, {
				prId,
				...(base ? { base } : {}),
				...(ticket === "auto"
					? {}
					: {
							ticketId:
								ticket === "none"
									? null
									: ticket === "manual"
										? manual
										: ticket,
						}),
				...(slug === undefined ? {} : { slug }),
			}),
		onSuccess: (data) => {
			setPreview(data);
			setSlug(data.slug);
			setValid(true);
		},
	});
	const launch = useMutation({
		mutationFn: (existing: boolean) =>
			implementRun(token, runId, {
				prId,
				...(base ? { base } : {}),
				...(!existing && preview?.previewHash && preview.ticketId !== undefined
					? {
							naming: {
								previewHash: preview.previewHash,
								ticketId: preview.ticketId,
								slug: preview.slug,
							},
						}
					: {}),
			}),
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: ["runs", token] });
			onSelectRun?.(result.runId);
		},
	});
	const pending = lookup.isPending || launch.isPending;
	return (
		<div className="space-y-3">
			<Button
				type="button"
				size="small"
				disabled={disabled || pending}
				onClick={() => {
					setVisible(true);
					lookup.mutate();
				}}
			>
				{visible ? "Refresh naming preview" : `Implement ${prId}`}
			</Button>
			<Button
				type="button"
				size="small"
				variant="quiet"
				disabled={pending}
				onClick={() => launch.mutate(true)}
			>
				Open existing workspace
			</Button>
			{visible && (
				<fieldset disabled={pending} className="space-y-2">
					<legend>Confirm execution naming</legend>
					<label className="block">
						Ticket selection{" "}
						<select
							className="min-h-11 max-w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-2"
							value={ticket}
							onChange={(e) => {
								setTicket(e.target.value);
								setValid(false);
							}}
						>
							<option value="auto">Server suggestion</option>
							{preview?.candidates.map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
							<option value="manual">Enter ticket ID</option>
							<option value="none">No ticket</option>
						</select>
					</label>
					{ticket === "manual" && (
						<label className="block">
							Ticket ID{" "}
							<input
								className="min-h-11 max-w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-2"
								value={manual}
								onChange={(e) => {
									setManual(e.target.value);
									setValid(false);
								}}
							/>
						</label>
					)}
					<label className="block">
						Branch slug{" "}
						<input
							className="min-h-11 max-w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-2"
							value={slug ?? ""}
							onChange={(e) => {
								setSlug(e.target.value);
								setValid(false);
							}}
						/>
					</label>
					{valid && preview && (
						<>
							<p>
								Selected ticket:{" "}
								{preview.ticketId === undefined
									? "Choice required"
									: (preview.ticketId ?? "No ticket")}
							</p>
							<p className="break-all">{preview.branch}</p>
							<p>{preview.commitSubject}</p>
							<p>{preview.prTitle}</p>
							{Object.entries(preview.errors).map(([field, error]) => (
								<p role="alert" key={field}>
									{error}
								</p>
							))}
							{preview.previewHash && (
								<Button
									type="button"
									disabled={pending}
									onClick={() => launch.mutate(false)}
								>
									Confirm implementation
								</Button>
							)}
						</>
					)}
				</fieldset>
			)}
			{pending && <p role="status">Checking execution naming…</p>}
			{(lookup.error || launch.error) && (
				<p role="alert">{(lookup.error || launch.error)?.message}</p>
			)}
		</div>
	);
}
