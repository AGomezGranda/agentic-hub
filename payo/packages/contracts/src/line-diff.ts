export function lineDiff(original: string, revised: string) {
	const before = original.split("\n");
	const after = revised.split("\n");
	let prefixLines = 0;
	while (
		prefixLines < before.length &&
		prefixLines < after.length &&
		before[prefixLines] === after[prefixLines]
	)
		prefixLines++;
	let suffix = 0;
	while (
		suffix < before.length - prefixLines &&
		suffix < after.length - prefixLines &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix++;
	// shortcut: unchanged lines between edits are included, upgrade if minimal diffs are needed.
	return {
		prefixLines,
		removed: before.slice(prefixLines, before.length - suffix),
		added: after.slice(prefixLines, after.length - suffix),
	};
}
