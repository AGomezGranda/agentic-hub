import type { PlanOutput } from "@payo/contracts";

type Phase = { title: string; line: number | null };
type Unit = { id: string; title: string; phases: Phase[]; issues: string[] };
const numbered = /^phase\s+(\d+[a-z]?)\b(?:\s*[:.\-–—]\s*|\s+)?(.*)$/i;
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function readOutline(markdown: string) {
	const headings: {
		title: string;
		line: number;
		number: string;
		label: string;
	}[] = [];
	const named: Phase[] = [];
	const prose: { text: string; line: number; owner?: Phase }[] = [];
	let fence = "";
	let depth = 0;
	let strategyDepth = 0;
	let owner: Phase | undefined;
	const body = markdown.replace(
		/<!-- factory answers start -->[\s\S]*?(?:<!-- factory answers end -->|$)/g,
		(section) => section.replace(/[^\n]/g, ""),
	);
	for (const [index, text] of body.split(/\r?\n/).entries()) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
		if (fence) {
			if (marker?.[1]?.startsWith(fence) && !marker[2]?.trim()) fence = "";
			continue;
		}
		if (marker?.[1]) {
			fence = marker[1];
			continue;
		}
		const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(text);
		if (heading?.[1] && heading[2]) {
			const level = heading[1].length;
			const title = heading[2].replace(/\s+#+$/, "");
			if (level <= strategyDepth) strategyDepth = 0;
			if (/^PR strategy\b/i.test(title)) strategyDepth = level;
			if (level <= depth) owner = undefined;
			const match = numbered.exec(title);
			if (!strategyDepth) named.push({ title, line: index + 1 });
			if (!strategyDepth && match?.[1]) {
				const phase = {
					title,
					line: index + 1,
					number: match[1].toLowerCase(),
					label: normalize(match[2] ?? ""),
				};
				headings.push(phase);
				owner = phase;
				depth = level;
			}
		}
		if (!strategyDepth) prose.push({ text, line: index + 1, owner });
	}
	return { headings, named, prose };
}

function matchReference(
	ref: string,
	{ headings, named, prose }: ReturnType<typeof readOutline>,
): Phase[][] {
	const label = normalize(ref);
	const range = /^phases?\s+(\d+)\s*[-–—]\s*(\d+)$/.exec(label);
	if (range) {
		const start = Number(range[1]);
		const count = Number(range[2]) - start + 1;
		if (
			!Number.isSafeInteger(start) ||
			!(count >= 1 && count <= headings.length)
		)
			return [[]];
		return Array.from({ length: count }, (_, index) =>
			headings.filter((h) => h.number === String(start + index)),
		);
	}
	const numberedRef = numbered.exec(label);
	const number =
		numberedRef?.[1] ?? (/^\d+[a-z]?$/.test(label) ? label : undefined);
	const descriptor = numberedRef?.[2];
	if (number && headings.length)
		return [
			headings.filter(
				(h) => h.number === number && (!descriptor || h.label === descriptor),
			),
		];
	const matches = headings.filter((h) => h.label === label);
	if (matches.length) return [matches];
	if (!headings.length) {
		const exactHeadings = named.filter((h) => normalize(h.title) === label);
		if (exactHeadings.length) return [exactHeadings];
	}
	const excerpts = prose.filter(
		(p) => (p.owner || !headings.length) && p.text.includes(ref),
	);
	return [
		excerpts.flatMap((p) => {
			const phase = p.owner ?? { title: ref, line: p.line };
			return p.text.indexOf(ref) === p.text.lastIndexOf(ref)
				? [phase]
				: [phase, phase];
		}),
	];
}

export function resolveImplementation(
	markdown: string,
	strategy: PlanOutput["prStrategy"],
): Unit[] {
	const outline = readOutline(markdown);
	const assigned = new Map<string, Unit>();
	const units = strategy.map(({ id, title, phases }) => {
		const unit: Unit = { id, title, phases: [], issues: [] };
		if (!phases.length) unit.issues.push("No phases assigned to this PR.");
		for (const ref of phases) {
			const matches = matchReference(ref, outline);
			if (matches.some((group) => group.length !== 1)) {
				const candidates = matches.filter((group) => group.length > 1).flat();
				unit.issues.push(
					candidates.length
						? `Ambiguous phase reference “${ref}”. Matches ${[...new Set(candidates.map((p) => `${p.title} (line ${p.line})`))].join(", ")}.`
						: `Unresolved phase reference “${ref}”.`,
				);
				unit.phases.push({ title: ref, line: null });
				continue;
			}
			for (const [phase] of matches) {
				if (!phase) continue;
				unit.phases.push({ title: phase.title, line: phase.line });
				const key = JSON.stringify([phase.line, phase.title]);
				const previous = assigned.get(key);
				if (previous) {
					const issue = `“${phase.title}” assigned twice (${previous.id}, ${id}).`;
					if (previous !== unit) previous.issues.push(issue);
					unit.issues.push(issue);
				} else assigned.set(key, unit);
			}
		}
		return unit;
	});
	for (const phase of outline.headings) {
		if (assigned.has(JSON.stringify([phase.line, phase.title]))) continue;
		for (const unit of units)
			unit.issues.push(`Unassigned phase “${phase.title}”.`);
	}
	return units;
}
