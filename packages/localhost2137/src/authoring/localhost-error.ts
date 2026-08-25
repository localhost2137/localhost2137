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
	declare readonly code: Code;
	declare readonly correlationId?: string;
	declare readonly details?: JsonObject;
	declare readonly retryable: boolean;
	declare readonly status: number;

	constructor(code: Code, message: string, options: LocalhostErrorOptions) {
		const validated = validateErrorInput(code, message, options);
		super(validated.message);
		this.name = "LocalhostError";
		defineReadonly(this, "message", validated.message, false);
		defineReadonly(this, "code", validated.code as Code, true);
		if (validated.correlationId !== undefined) {
			defineReadonly(this, "correlationId", validated.correlationId, true);
		}
		if (validated.details !== undefined) defineReadonly(this, "details", validated.details, true);
		defineReadonly(this, "retryable", validated.retryable, true);
		defineReadonly(this, "status", validated.status, true);
		if (validated.hasCause) {
			Object.defineProperty(this, "cause", {
				configurable: false,
				enumerable: false,
				value: validated.cause,
				writable: false,
			});
		}
	}
}

function defineReadonly(target: object, key: string, value: unknown, enumerable: boolean): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable,
		value,
		writable: false,
	});
}

interface ValidatedErrorInput {
	readonly cause: unknown;
	readonly code: string;
	readonly correlationId?: string;
	readonly details?: JsonObject;
	readonly hasCause: boolean;
	readonly message: string;
	readonly retryable: boolean;
	readonly status: number;
}

function validateErrorInput(
	code: unknown,
	message: unknown,
	options: unknown,
): ValidatedErrorInput {
	if (typeof code !== "string" || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(code)) {
		throw new TypeError("Localhost error codes must use stable UPPER_SNAKE_CASE.");
	}
	if (code.length > 64) throw new TypeError("Localhost error codes must not exceed 64 characters.");
	const safeMessage = safeBoundedText(message, "Localhost error messages", 512);
	if (!isPlainRecord(options)) throw new TypeError("Localhost error options must be an object.");
	const status = dataProperty(options, "status", true);
	if (!Number.isSafeInteger(status) || (status as number) < 400 || (status as number) > 599) {
		throw new TypeError("Localhost error status must be an integer from 400 to 599.");
	}
	const retryable = dataProperty(options, "retryable", false);
	if (retryable !== undefined && typeof retryable !== "boolean") {
		throw new TypeError("Localhost error retryable must be a boolean.");
	}
	const correlation = dataProperty(options, "correlationId", false);
	const correlationId =
		correlation === undefined
			? undefined
			: safeBoundedText(correlation, "Localhost error correlation IDs", 128);
	const rawDetails = dataProperty(options, "details", false);
	let details: JsonObject | undefined;
	if (rawDetails !== undefined) {
		const owned = ownJsonValue(rawDetails);
		if (!isJsonObject(owned)) throw new TypeError("Localhost error details must be a JSON object.");
		details = owned;
	}
	const causeDescriptor = Object.getOwnPropertyDescriptor(options, "cause");
	if (causeDescriptor && !("value" in causeDescriptor)) {
		throw new TypeError("Localhost error cause must be a data property.");
	}
	return Object.freeze({
		cause: causeDescriptor?.value,
		code,
		...(correlationId === undefined ? {} : { correlationId }),
		...(details === undefined ? {} : { details }),
		hasCause: causeDescriptor !== undefined && causeDescriptor.value !== undefined,
		message: safeMessage,
		retryable: retryable ?? false,
		status: status as number,
	});
}

function safeBoundedText(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be strings.`);
	const owned = value.trim();
	if (owned.length === 0) throw new TypeError(`${label} must not be empty.`);
	if (owned.length > maximumLength) {
		throw new TypeError(`${label} must not exceed ${maximumLength} characters.`);
	}
	if (
		[...owned].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
		})
	) {
		throw new TypeError(`${label} must not contain control characters.`);
	}
	return owned;
}

function dataProperty(
	value: Readonly<Record<string, unknown>>,
	key: string,
	required: boolean,
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) {
		if (required) throw new TypeError(`Localhost error option ${key} is required.`);
		return undefined;
	}
	if (!("value" in descriptor)) {
		throw new TypeError(`Localhost error option ${key} must be a data property.`);
	}
	return descriptor.value;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
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
import { type JsonObject, ownJsonValue } from "./json-value.js";
