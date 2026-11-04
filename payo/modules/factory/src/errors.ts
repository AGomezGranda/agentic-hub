/** A rejected factory command caused by the run's state or the request, not by a fault. */
export class CommandError extends Error {
	readonly code: "busy" | "conflict" | "invalid_request" | "not_found";
	constructor(
		code: "busy" | "conflict" | "invalid_request" | "not_found",
		message: string,
	) {
		super(message);
		this.name = "CommandError";
		this.code = code;
	}
}
