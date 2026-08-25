const CONFIG_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export const RUNTIME_DESCRIPTOR_SCHEMA_VERSION: 1 = 1;
export const RUNTIME_PROTOCOL_VERSION: "v1" = "v1";

export interface RuntimeDescriptor {
	readonly configFingerprint: string;
	readonly ownerId: string;
	readonly pid: number;
	readonly protocolVersion: "v1";
	readonly schemaVersion: 1;
	readonly startedAt: string;
	readonly url: string;
}

export type RuntimeDescriptorValidationCode =
	| "MALFORMED_DESCRIPTOR"
	| "UNSUPPORTED_PROTOCOL_VERSION"
	| "UNSUPPORTED_SCHEMA_VERSION";

export class RuntimeDescriptorValidationError extends TypeError {
	readonly code: RuntimeDescriptorValidationCode;
	readonly path: string;

	constructor(code: RuntimeDescriptorValidationCode, path: string, message: string) {
		super(message);
		this.name = "RuntimeDescriptorValidationError";
		this.code = code;
		this.path = path;
	}
}

/** Copies and validates the complete on-disk active-runtime descriptor. */
export function ownRuntimeDescriptor(value: unknown): RuntimeDescriptor {
	const input = strictRecord(value, "$", [
		"configFingerprint",
		"ownerId",
		"pid",
		"protocolVersion",
		"schemaVersion",
		"startedAt",
		"url",
	]);
	const schemaVersion = dataProperty(input, "schemaVersion", "$");
	if (schemaVersion !== RUNTIME_DESCRIPTOR_SCHEMA_VERSION) {
		throw invalid(
			"UNSUPPORTED_SCHEMA_VERSION",
			"$.schemaVersion",
			`Unsupported runtime descriptor schema version ${formatValue(schemaVersion)}.`,
		);
	}
	const protocolVersion = dataProperty(input, "protocolVersion", "$");
	if (protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
		throw invalid(
			"UNSUPPORTED_PROTOCOL_VERSION",
			"$.protocolVersion",
			`Unsupported runtime control protocol ${formatValue(protocolVersion)}.`,
		);
	}
	const configFingerprint = dataProperty(input, "configFingerprint", "$");
	if (
		typeof configFingerprint !== "string" ||
		!CONFIG_FINGERPRINT_PATTERN.test(configFingerprint)
	) {
		throw malformed(
			"$.configFingerprint",
			"Runtime descriptor configFingerprint must be a canonical SHA-256 fingerprint.",
		);
	}
	const ownerId = dataProperty(input, "ownerId", "$");
	if (typeof ownerId !== "string" || !OWNER_ID_PATTERN.test(ownerId)) {
		throw malformed(
			"$.ownerId",
			"Runtime descriptor ownerId must be a 16-128 character URL-safe identifier.",
		);
	}
	const pid = dataProperty(input, "pid", "$");
	if (!Number.isSafeInteger(pid) || (pid as number) < 1) {
		throw malformed("$.pid", "Runtime descriptor pid must be a positive safe integer.");
	}
	const startedAt = dataProperty(input, "startedAt", "$");
	if (typeof startedAt !== "string" || !isCanonicalTimestamp(startedAt)) {
		throw malformed(
			"$.startedAt",
			"Runtime descriptor startedAt must be a canonical RFC 3339 UTC timestamp.",
		);
	}
	const rawUrl = dataProperty(input, "url", "$");
	const url = ownLoopbackRuntimeUrl(rawUrl, "$.url");
	return Object.freeze({
		configFingerprint,
		ownerId,
		pid: pid as number,
		protocolVersion,
		schemaVersion,
		startedAt,
		url,
	});
}

export function ownLoopbackRuntimeUrl(value: unknown, path: string = "url"): string {
	if (typeof value !== "string") {
		throw malformed(path, "Runtime URL must be a string.");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw malformed(path, "Runtime URL must be an absolute URL.");
	}
	if (parsed.protocol !== "http:") {
		throw malformed(path, "Runtime URL must use plain HTTP on a loopback address.");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw malformed(path, "Runtime URL cannot contain credentials, a query, or a fragment.");
	}
	if (parsed.pathname !== "/") {
		throw malformed(path, "Runtime URL must identify the server origin without a path.");
	}
	if (!isLoopbackHostname(parsed.hostname)) {
		throw malformed(path, "Runtime URL must use localhost or a numeric loopback address.");
	}
	const port = Number(parsed.port);
	if (!parsed.port || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw malformed(path, "Runtime URL must include a port from 1 to 65535.");
	}
	return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const octets = hostname.split(".");
	if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
	const numbers = octets.map(Number);
	return numbers[0] === 127 && numbers.every((octet) => octet >= 0 && octet <= 255);
}

function strictRecord(
	value: unknown,
	path: string,
	keys: readonly string[],
): Readonly<Record<string, unknown>> {
	if (!isPlainRecord(value)) throw malformed(path, "Runtime descriptor must be a plain object.");
	const actualKeys = Reflect.ownKeys(value);
	for (const key of actualKeys) {
		if (typeof key !== "string" || !keys.includes(key)) {
			throw malformed(path, `Runtime descriptor contains unknown field ${formatValue(key)}.`);
		}
	}
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) {
			throw malformed(`${path}.${key}`, `Runtime descriptor field ${key} is required.`);
		}
	}
	return value;
}

function dataProperty(
	value: Readonly<Record<string, unknown>>,
	key: string,
	path: string,
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
		throw malformed(`${path}.${key}`, `Runtime descriptor field ${key} must be a data property.`);
	}
	return descriptor.value;
}

function isCanonicalTimestamp(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function malformed(path: string, message: string): RuntimeDescriptorValidationError {
	return invalid("MALFORMED_DESCRIPTOR", path, message);
}

function invalid(
	code: RuntimeDescriptorValidationCode,
	path: string,
	message: string,
): RuntimeDescriptorValidationError {
	return new RuntimeDescriptorValidationError(code, path, message);
}

function formatValue(value: unknown): string {
	if (typeof value === "symbol") return value.toString();
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
