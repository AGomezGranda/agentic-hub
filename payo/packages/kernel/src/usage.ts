import type { UsageRecord } from "@payo/contracts";

export const UNKNOWN_USAGE: UsageRecord = {
	tokensIn: "unknown",
	tokensOut: "unknown",
	cost: "unknown",
};

/** Marks known monetary subtotals as not fully observed, without discarding them. */
export function incompleteUsage(usage: UsageRecord): UsageRecord {
	if (usage.costDetails === undefined) return usage;
	return { ...usage, costDetails: { ...usage.costDetails, complete: false } };
}
