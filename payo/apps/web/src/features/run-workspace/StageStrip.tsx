const STAGE_LABELS: Record<string, string> = {
	FetchTicket: "Fetch ticket",
	ResolveWorkItem: "Resolve work item",
	Plan: "Plan",
	PlanReview: "Review plan",
	Revise: "Revise plan",
	Approval: "Approval",
	Approved: "Approved",
	Escalated: "Escalated",
};

export function stageLabel(stage: string | null): string {
	if (stage === null) return "Stage pending";
	return STAGE_LABELS[stage] ?? stage;
}

export function StageStrip({ stage }: { stage: string | null }) {
	return (
		<section
			aria-label="Current stage"
			className="flex min-h-14 items-center gap-3 rounded-sm border border-[var(--line)] bg-[#f8faf8] px-4"
		>
			<span
				aria-hidden="true"
				className="size-2.5 rounded-sm bg-[var(--accent)]"
			/>
			<span className="text-[10px] font-bold tracking-[0.13em] text-[var(--muted)]">
				CURRENT STAGE
			</span>
			<span className="font-semibold text-[var(--ink)]">
				{stageLabel(stage)}
			</span>
		</section>
	);
}
