export function commandErrorDetail(stderr: string): string {
	return (
		stderr
			.replace(/\b(?:https?|ssh):\/\/\S+/gi, "[redacted URL]")
			.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
			.replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/g, "[redacted]")
			.replace(/[\p{Cc}]/gu, " ")
			.trim()
			.slice(0, 512) || "no diagnostic output"
	);
}
