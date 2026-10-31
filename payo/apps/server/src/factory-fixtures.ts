import type { Ticket } from "@payo/contracts";
import type { TicketSource, Workspace } from "@payo/kernel";
import { createFakeRunner, type FakeStep } from "@payo/runner-fake";

export function fakeTickets(tickets: Ticket[]): TicketSource {
	return {
		async get(key) {
			const ticket = tickets.find((item) => item.key === key);
			if (!ticket) throw new Error(`ticket ${key} not found`);
			return structuredClone(ticket);
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
