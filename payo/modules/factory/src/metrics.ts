import { sha256Hex } from "@payo/kernel";

export function approvalDiff(original: string, approved: string) {
	const before = original.split("\n");
	const after = approved.split("\n");
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
	// shortcut: one replacement includes unchanged lines between edits, upgrade if minimal edit counts are needed.
	const removed = before.slice(prefixLines, before.length - suffix);
	const added = after.slice(prefixLines, after.length - suffix);
	return {
		originalSha256: sha256Hex(new TextEncoder().encode(original)),
		approvedSha256: sha256Hex(new TextEncoder().encode(approved)),
		changed: original !== approved,
		prefixLines,
		removed,
		added,
		replacedRemovedLines: removed.length,
		replacedAddedLines: added.length,
	};
}
