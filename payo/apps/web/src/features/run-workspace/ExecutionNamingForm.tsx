import type { ImplementPreview } from "@payo/contracts";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";
import { correctExecutionNaming } from "../plan-review/api.ts";
export function ExecutionNamingForm({
	token,
	runId,
	initialSlug,
	onRefresh,
}: {
	token: string;
	runId: string;
	initialSlug: string;
	onRefresh: () => Promise<void>;
}) {
	const [slug, setSlug] = useState(initialSlug);
	const [preview, setPreview] = useState<ImplementPreview | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function submit(confirm: boolean) {
		setPending(true);
		setError(null);
		try {
			const result = await correctExecutionNaming(token, runId, {
				slug,
				...(confirm && preview?.previewHash
					? { previewHash: preview.previewHash }
					: {}),
			});
			setPreview(confirm ? null : result);
			if (confirm) await onRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPreview(null);
		} finally {
			setPending(false);
		}
	}
	return (
		<fieldset disabled={pending} className="space-y-2">
			<legend>Correct branch before workspace creation</legend>
			<label className="block">
				Replacement branch slug{" "}
				<input
					className="min-h-11 max-w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-2"
					value={slug}
					onChange={(e) => {
						setSlug(e.target.value);
						setPreview(null);
					}}
				/>
			</label>
			<Button type="button" onClick={() => void submit(false)}>
				Preview branch correction
			</Button>
			{preview && (
				<>
					<p className="break-all">{preview.branch}</p>
					{Object.entries(preview.errors).map(([field, message]) => (
						<p key={field} role="alert">
							{message}
						</p>
					))}
					{preview.previewHash && (
						<Button type="button" onClick={() => void submit(true)}>
							Confirm branch correction
						</Button>
					)}
				</>
			)}
			{pending && <p role="status">Checking branch correction…</p>}
			{error && <p role="alert">{error}</p>}
		</fieldset>
	);
}
