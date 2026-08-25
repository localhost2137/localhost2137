import { ownJsonValue } from "../authoring/json-value.js";
import {
	ControlApiError,
	type ControlJsonObject,
	type ControlJsonValue,
	ControlProtocolError,
	ControlTransportError,
} from "./control-client-errors.js";

export const CONTROL_RESPONSE_BODY_LIMIT_BYTES: number = 1024 * 1024;

type ControlEnvelope =
	| Readonly<{ data: ControlJsonValue; kind: "success" }>
	| Readonly<{
			error: Readonly<{
				code: string;
				correlationId: string;
				details?: ControlJsonObject;
				message: string;
			}>;
			kind: "error";
	  }>;

export async function readControlResponse(
	response: Response,
	limitBytes: number = CONTROL_RESPONSE_BODY_LIMIT_BYTES,
): Promise<ControlJsonValue> {
	assertBodyLimit(limitBytes);
	assertJsonContentType(response);
	let text: string;
	try {
		text = await readBoundedResponseText(response, limitBytes);
	} catch (cause) {
		if (cause instanceof ControlProtocolError) throw cause;
		throw new ControlTransportError(cause, false);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (cause) {
		throw protocol("Control response body must be valid JSON.", response.status, cause);
	}
	let envelope: ControlEnvelope;
	try {
		envelope = ownEnvelope(decoded);
	} catch (cause) {
		if (cause instanceof ControlProtocolError) {
			throw protocol(cause.message, response.status, cause);
		}
		throw protocol("Control response envelope is not valid JSON data.", response.status, cause);
	}
	if (response.ok) {
		if (envelope.kind !== "success") {
			throw protocol("Successful control responses must contain a data envelope.", response.status);
		}
		return envelope.data;
	}
	if (response.status < 400 || response.status > 599) {
		throw protocol("Control response has an unsupported HTTP status.", response.status);
	}
	if (envelope.kind !== "error") {
		throw protocol("Failed control responses must contain an error envelope.", response.status);
	}
	throw new ControlApiError({
		...envelope.error,
		status: response.status,
	});
}

function ownEnvelope(value: unknown): ControlEnvelope {
	let owned: ControlJsonValue;
	try {
		owned = ownJsonValue(value);
	} catch (cause) {
		throw new ControlProtocolError("Control response envelope is not valid JSON data.", { cause });
	}
	if (!isObject(owned)) {
		throw new ControlProtocolError("Control response envelope must be an object.");
	}
	const keys = Object.keys(owned);
	if (keys.length !== 1) {
		throw new ControlProtocolError("Control response envelope must contain exactly one field.");
	}
	if (keys[0] === "data") {
		return Object.freeze({ data: owned.data as ControlJsonValue, kind: "success" });
	}
	if (keys[0] !== "error" || !isObject(owned.error)) {
		throw new ControlProtocolError('Control response envelope must contain "data" or "error".');
	}
	const error = owned.error;
	assertExactKeys(
		error,
		["code", "correlationId", "details", "message"],
		["code", "correlationId", "message"],
	);
	const code = boundedText(error.code, "error.code", 64, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
	const correlationId = boundedText(error.correlationId, "error.correlationId", 128);
	const message = boundedText(error.message, "error.message", 512);
	const details = error.details;
	if (details !== undefined && !isObject(details)) {
		throw new ControlProtocolError("Control response error.details must be a JSON object.");
	}
	return Object.freeze({
		error: Object.freeze({
			code,
			correlationId,
			...(details === undefined ? {} : { details }),
			message,
		}),
		kind: "error",
	});
}

async function readBoundedResponseText(response: Response, limitBytes: number): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
			throw protocol("Control response Content-Length is invalid.", response.status);
		}
		if (Number(declaredLength) > limitBytes) throw responseTooLarge(response.status, limitBytes);
	}
	if (!response.body) throw protocol("Control response body is missing.", response.status);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > limitBytes) {
			await reader.cancel("control response body limit exceeded").catch(() => undefined);
			throw responseTooLarge(response.status, limitBytes);
		}
		chunks.push(chunk.value);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch (cause) {
		throw protocol("Control response body must be valid UTF-8.", response.status, cause);
	}
}

function assertJsonContentType(response: Response): void {
	const contentType = response.headers.get("content-type") ?? "";
	if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
		throw protocol("Control response must use Content-Type: application/json.", response.status);
	}
}

function assertBodyLimit(limitBytes: number): void {
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
		throw new TypeError("Control response body limit must be a positive safe integer.");
	}
}

function assertExactKeys(
	value: ControlJsonObject,
	allowed: readonly string[],
	required: readonly string[],
): void {
	const keys = Object.keys(value);
	const unknown = keys.find((key) => !allowed.includes(key));
	if (unknown) {
		throw new ControlProtocolError(`Control response error contains unknown field ${unknown}.`);
	}
	const missing = required.find((key) => !Object.hasOwn(value, key));
	if (missing) {
		throw new ControlProtocolError(`Control response error is missing field ${missing}.`);
	}
}

function boundedText(
	value: unknown,
	field: string,
	maximumLength: number,
	pattern?: RegExp,
): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
		throw new ControlProtocolError(
			`Control response ${field} must be a non-empty string of at most ${maximumLength} characters.`,
		);
	}
	if (
		[...value].some((character) => {
			const point = character.codePointAt(0);
			return point !== undefined && (point <= 31 || point === 127);
		})
	) {
		throw new ControlProtocolError(`Control response ${field} cannot contain control characters.`);
	}
	if (pattern && !pattern.test(value)) {
		throw new ControlProtocolError(`Control response ${field} has an invalid format.`);
	}
	return value;
}

function responseTooLarge(status: number, limitBytes: number): ControlProtocolError {
	return protocol(`Control response exceeds the ${limitBytes}-byte limit.`, status);
}

function protocol(message: string, status: number, cause?: unknown): ControlProtocolError {
	return new ControlProtocolError(message, {
		...(cause === undefined ? {} : { cause }),
		status,
	});
}

function isObject(value: unknown): value is ControlJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
