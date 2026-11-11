import { CommandError } from "./errors.ts";

const start = "<!-- factory answers start -->";
const end = "<!-- factory answers end -->";

export function renderAnswers(
	markdown: string,
	answers: Record<string, string>,
): string {
	const starts = markdown.split(start).length - 1;
	const ends = markdown.split(end).length - 1;
	if (
		starts !== ends ||
		starts > 1 ||
		(starts === 1 && markdown.indexOf(start) > markdown.indexOf(end))
	)
		throw new CommandError("conflict", "ambiguous answer delimiters");
	if (
		Object.entries(answers).some(([id, answer]) =>
			[id, answer].some(
				(value) => value.includes(start) || value.includes(end),
			),
		)
	)
		throw new CommandError("invalid_request", "ambiguous answer delimiters");
	const section = Object.entries(answers)
		.map(([id, answer]) => `- **${id}:** ${answer}`)
		.join("\n");
	const rendered = `${start}\n${section}\n${end}`;
	return starts
		? markdown.slice(0, markdown.indexOf(start)) +
				rendered +
				markdown.slice(markdown.indexOf(end) + end.length)
		: `${markdown}${markdown.endsWith("\n") ? "\n" : "\n\n"}${rendered}\n`;
}
export function validateRunId(runId: string): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
		runId === "." ||
		runId === ".."
	)
		throw new Error("invalid runId");
}
