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

/** Application failures carry a code only; the HTTP adapter maps it to a status. */
export type ApplicationErrorCode =
	| "not_found"
	| "busy"
	| "invalid_request"
	| "execution_unavailable"
	| "execution_platform_unsupported"
	| "execution_base_unavailable";

export class ApplicationError extends Error {
	readonly code: ApplicationErrorCode;

	constructor(code: ApplicationErrorCode, message: string) {
		super(message);
		this.name = "ApplicationError";
		this.code = code;
	}
}
