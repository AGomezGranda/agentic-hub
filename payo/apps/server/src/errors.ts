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

export function notFound(message: string): ApiFailure {
	return new ApiFailure(404, "not_found", message);
}

export function busy(message: string): ApiFailure {
	return new ApiFailure(409, "busy", message);
}

export function conflict(message: string): ApiFailure {
	return new ApiFailure(409, "conflict", message);
}
