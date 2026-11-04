export class ApiFailure extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiFailure";
		this.status = status;
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

export class FolderDialogUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FolderDialogUnavailable";
	}
}

export function notFound(message: string): ApiFailure {
	return new ApiFailure(404, "not_found", message);
}

export function conflict(message: string): ApiFailure {
	return new ApiFailure(409, "conflict", message);
}
