export type RuntimeErrorCode =
	| "AUTHENTICATION_REQUIRED"
	| "BROWSER_ORIGIN_REJECTED"
	| "IDLE_TIMEOUT"
	| "INSTANCE_CONFLICT"
	| "INSTANCE_MUTATION_COMMITTED"
	| "INSTANCE_NOT_FOUND"
	| "INTERNAL_ERROR"
	| "INVALID_OPERATION_INPUT"
	| "INVALID_REQUEST"
	| "LIFECYCLE_CONFLICT"
	| "OPERATION_NOT_FOUND"
	| "OPERATION_OUTPUT_INVALID"
	| "PLUGIN_EXECUTION_FAILED"
	| "REQUEST_ABORTED"
	| "REQUEST_TOO_LARGE"
	| "SERVICE_NOT_FOUND"
	| "UNSUPPORTED_MEDIA_TYPE";

export interface LocalhostErrorOptions {
	readonly cause?: unknown;
	readonly correlationId?: string;
	readonly details?: Readonly<Record<string, unknown>>;
	readonly retryable?: boolean;
	readonly status: number;
}

/** A safe, stable expected error that may cross a localhost2137 adapter boundary. */
export class LocalhostError<Code extends string = string> extends Error {
	readonly code: Code;
	readonly correlationId?: string;
	readonly details?: Readonly<Record<string, unknown>>;
	readonly retryable: boolean;
	readonly status: number;

	constructor(code: Code, message: string, options: LocalhostErrorOptions) {
		super(message);
		this.name = "LocalhostError";
		this.code = code;
		if (options.correlationId !== undefined) this.correlationId = options.correlationId;
		if (options.details !== undefined) this.details = options.details;
		this.retryable = options.retryable ?? false;
		this.status = options.status;
		if (options.cause !== undefined) {
			Object.defineProperty(this, "cause", {
				configurable: false,
				enumerable: false,
				value: options.cause,
				writable: false,
			});
		}
	}
}

export function withCorrelation<Code extends string>(
	error: LocalhostError<Code>,
	correlationId: string,
): LocalhostError<Code> {
	if (error.correlationId === correlationId) return error;
	return new LocalhostError(error.code, error.message, {
		cause: error,
		correlationId,
		...(error.details ? { details: error.details } : {}),
		retryable: error.retryable,
		status: error.status,
	});
}
