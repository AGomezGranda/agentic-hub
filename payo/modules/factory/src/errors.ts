/** A rejected factory command caused by the run's state or the request, not by a fault. */
export class CommandError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "CommandError";
		this.status = status;
		this.code = code;
	}
}
