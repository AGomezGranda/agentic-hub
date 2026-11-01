import type { WorkItemRequest } from "@payo/contracts";
import type { WorkItemSource } from "@payo/kernel";
import { expect, it, vi } from "vitest";
import { createWorkItemSource } from "./adapters.ts";

it("resolves prompts verbatim without calling the Jira resolver", async () => {
	const resolveJira = vi.fn(async () => ({
		origin: { source: "jira" as const, key: "ABC-123", url: null },
		title: "Jira",
		description: "Jira description",
	}));
	const source: WorkItemSource<Extract<WorkItemRequest, { source: "jira" }>> = {
		resolve: resolveJira,
	};
	const workItems = createWorkItemSource(source);
	const text = "  Build exactly this.\nKeep the spacing.  ";

	await expect(workItems.resolve({ source: "prompt", text })).resolves.toEqual({
		origin: { source: "prompt" },
		title: "Direct prompt",
		description: text,
	});
	expect(resolveJira).not.toHaveBeenCalled();
});

it("routes Jira requests to the Jira resolver", async () => {
	const resolve = vi.fn(async (request) => ({
		origin: { source: "jira" as const, key: request.key, url: null },
		title: "Jira",
		description: "Description",
	}));
	const workItems = createWorkItemSource({ resolve });

	await expect(
		workItems.resolve({ source: "jira", key: "ABC-123" }),
	).resolves.toMatchObject({
		origin: { source: "jira", key: "ABC-123" },
	});
	expect(resolve).toHaveBeenCalledWith({ source: "jira", key: "ABC-123" });
});
