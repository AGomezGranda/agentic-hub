import type { PublicationSummary } from "@payo/contracts";
import { resumeRun } from "@web/features/plan-review/api.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";
export function PublicationView({
	token,
	runId,
	publication,
	canResume,
	onRefresh,
}: {
	token: string;
	runId: string;
	publication: PublicationSummary;
	canResume: boolean;
	onRefresh: () => Promise<unknown>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function resume() {
		setPending(true);
		setError(null);
		try {
			await resumeRun(token, runId);
			await onRefresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	}
	return (
		<section
			aria-label="Publication"
			className="workspace-view min-w-0 space-y-4 text-sm"
		>
			<header className="workspace-summary">
				<div>
					<p className="workspace-label">PUBLICATION</p>
					<h2>GitHub publication · {publication.stage}</h2>
				</div>
				<nav aria-label="Publication sources" className="flex flex-wrap gap-3">
					<a className="underline" href={`/runs/${publication.sourceRunId}`}>
						Planning
					</a>
					<a className="underline" href={`/runs/${publication.executionRunId}`}>
						Execution
					</a>
				</nav>
			</header>
			<div className="workspace-layout">
				<div className="workspace-main">
					<section className="workspace-panel space-y-3">
						<h3>Publication status</h3>
						{publication.reason && <p role="status">{publication.reason}</p>}
						{publication.pr && (
							<a
								className="inline-block text-[var(--accent)] underline"
								href={publication.pr.url}
							>
								Open GitHub draft PR #{publication.pr.number}
							</a>
						)}
						{canResume && (
							<Button
								type="button"
								disabled={pending}
								onClick={() => void resume()}
							>
								Resume publication
							</Button>
						)}
						{pending && <p role="status">Resuming publication…</p>}
						{error && <p role="alert">{error}</p>}
					</section>
				</div>
				<aside className="workspace-rail" aria-label="Publication context">
					<section className="workspace-panel execution-worktree">
						<h3>Publication target</h3>
						<p>
							{publication.target.owner}/{publication.target.name} ·{" "}
							{publication.target.baseBranch} ← {publication.branch}
						</p>
						<p className="break-all">
							Reviewed commit: {publication.reviewedCommit}
						</p>
					</section>
				</aside>
			</div>
		</section>
	);
}
