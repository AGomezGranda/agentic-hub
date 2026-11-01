import type { WorkItem, WorkItemRequest } from "@payo/contracts";
import type { WorkItemSource, Workspace } from "@payo/kernel";
import { createFakeRunner, type FakeStep } from "@payo/runner-fake";

export function fakeWorkItems(items: WorkItem[]): WorkItemSource {
	return {
		async resolve(request: WorkItemRequest) {
			if (request.source !== "jira")
				throw new Error(`unsupported fixture source ${request.source}`);
			const item = items.find(
				(candidate) =>
					candidate.origin.source === "jira" &&
					candidate.origin.key === request.key,
			);
			if (!item) throw new Error(`work item ${request.key} not found`);
			return structuredClone(item);
		},
	};
}
export function fakeWorkspace(root: string): Workspace {
	return {
		async create(runId) {
			return `${root}/${runId}`;
		},
		async remove() {},
	};
}
export function envelope(value: unknown): FakeStep[] {
	return [
		{ kind: "emit", event: { type: "result", text: JSON.stringify(value) } },
	];
}
export { createFakeRunner };
