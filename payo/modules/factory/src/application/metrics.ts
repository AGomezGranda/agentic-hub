import { lineDiff } from "@payo/contracts";
import { sha256Hex } from "@payo/kernel";

export function approvalDiff(original: string, approved: string) {
	const { prefixLines, removed, added } = lineDiff(original, approved);
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
