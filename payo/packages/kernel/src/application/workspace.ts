import type { WorkItem, WorkItemRequest } from "@payo/contracts";

export interface WorkItemSource<T extends WorkItemRequest = WorkItemRequest> {
	resolve(request: T): Promise<WorkItem>;
}
export interface Workspace {
	create(runId: string, repo: string, base: string): Promise<string>;
	remove(path: string): Promise<void>;
}
