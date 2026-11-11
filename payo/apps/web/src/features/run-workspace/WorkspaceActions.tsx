import { type OpenWorkspaceRequest, RunIdResponse } from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";

export function WorkspaceActions({
	token,
	runId,
	path,
}: {
	token: string;
	runId: string;
	path: string;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function open(target: OpenWorkspaceRequest["target"]) {
		setPending(true);
		setError(null);
		try {
			await getJson(
				`/runs/${runId}/open-workspace`,
				token,
				"POST",
				(data) => RunIdResponse.parse(data),
				{ target },
			);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not open workspace.",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="mt-4 flex flex-wrap items-center gap-2" aria-busy={pending}>
			<Button
				type="button"
				variant="secondary"
				size="small"
				title={`Open ${path} in Terminal`}
				disabled={pending}
				onClick={() => void open("terminal")}
			>
				Open in Terminal
			</Button>
			<Button
				type="button"
				variant="secondary"
				size="small"
				title={`Open ${path} in VS Code`}
				disabled={pending}
				onClick={() => void open("vscode")}
			>
				Open in VS Code
			</Button>
			{error && (
				<p role="alert" className="basis-full text-sm text-[var(--danger)]">
					{error}
				</p>
			)}
		</div>
	);
}
