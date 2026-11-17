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
