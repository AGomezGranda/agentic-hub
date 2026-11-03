import type { getDoctor } from "./api.ts";

export function DoctorCard({
	doctor,
	isPending,
	port,
}: {
	doctor: Awaited<ReturnType<typeof getDoctor>> | undefined;
	isPending: boolean;
	port: number;
}) {
	const tone = isPending
		? "neutral"
		: doctor?.ok
			? "success"
			: doctor
				? "danger"
				: "neutral";
	return (
		<section className="console-panel mb-5">
			<div className="flex items-center justify-between gap-3">
				<div>
					<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
						SERVER STATUS
					</p>
					<h2 className="mt-1 text-base font-semibold">Local connection</h2>
				</div>
				<span
					className={`rounded-sm px-2.5 py-1 text-xs font-semibold ${
						tone === "success"
							? "bg-[var(--success-surface)] text-[var(--status-good)]"
							: tone === "danger"
								? "bg-[var(--danger-surface)] text-[var(--danger)]"
								: "bg-[var(--surface-raised)] text-[var(--muted)]"
					}`}
				>
					{isPending
						? "Checking…"
						: doctor
							? doctor.ok
								? "Ready"
								: "Attention"
							: "Unavailable"}
				</span>
			</div>
			<p className="mt-3 text-sm text-[var(--muted)]">
				{isPending
					? `Authenticating with 127.0.0.1:${port}…`
					: doctor
						? `${doctor.checks.filter((check) => check.ok).length} of ${doctor.checks.length} checks ready`
						: "Could not read server status."}
			</p>
			{doctor?.checks.length ? (
				<ul className="mt-4 space-y-2 border-t border-[var(--line)] pt-3">
					{doctor.checks.map((check) => (
						<li
							key={check.name}
							className="flex items-start justify-between gap-3 text-xs"
						>
							<span className="font-medium">{check.name}</span>
							<span className="text-right text-[var(--muted)]">
								{check.detail}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}
