import type { Ticket } from "@payo/contracts";

export interface TicketSource {
	get(key: string): Promise<Ticket>;
}
export interface Workspace {
	create(runId: string, repo: string, base: string): Promise<string>;
	remove(path: string): Promise<void>;
}
