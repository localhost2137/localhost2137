import {
	ControlApiError,
	type ControlClient,
	type ControlJsonValue,
	ControlProtocolError,
	ControlTransportError,
	connectRuntime,
} from "../control/control-client.js";
import {
	type RuntimeDescriptor,
	RuntimeDescriptorValidationError,
} from "../control/runtime-descriptor.js";
import { readRuntimeDescriptorFile, readRuntimeTokenFile } from "./active-runtime-file-reader.js";
import { type StoragePaths, storagePaths } from "./storage-paths.js";

const HEALTH_TIMEOUT_MS = 2_000;

export type RuntimeDiscoveryCode =
	| "RUNTIME_DESCRIPTOR_MALFORMED"
	| "RUNTIME_FILES_INCONSISTENT"
	| "RUNTIME_HEALTH_FAILED"
	| "RUNTIME_NOT_FOUND"
	| "RUNTIME_PROCESS_CHECK_FAILED"
	| "RUNTIME_PROCESS_STALE"
	| "RUNTIME_PROTOCOL_UNSUPPORTED"
	| "RUNTIME_TOKEN_MALFORMED";

export class RuntimeDiscoveryError extends Error {
	override readonly cause?: unknown;
	readonly code: RuntimeDiscoveryCode;

	constructor(code: RuntimeDiscoveryCode, message: string, cause?: unknown) {
		super(message);
		this.name = "RuntimeDiscoveryError";
		this.code = code;
		if (cause !== undefined) {
			Object.defineProperty(this, "cause", {
				configurable: false,
				enumerable: false,
				value: cause,
				writable: false,
			});
		}
	}
}

export interface DiscoveredRuntimeFiles {
	readonly descriptor: RuntimeDescriptor;
	readonly token: string;
}

export interface DiscoveredActiveRuntime extends DiscoveredRuntimeFiles {
	readonly client: ControlClient;
}

export interface ActiveRuntimeDiscoveryOptions {
	readonly fetch?: typeof globalThis.fetch;
	readonly healthTimeoutMs?: number;
	readonly processIsAlive?: (pid: number) => boolean | Promise<boolean>;
	readonly responseBodyLimitBytes?: number;
}

export async function discoverRuntimeFiles(storageRoot: string): Promise<DiscoveredRuntimeFiles> {
	const paths = fixedPaths(storageRoot);
	let firstDescriptor: RuntimeDescriptor;
	try {
		firstDescriptor = await readRuntimeDescriptorFile(paths.runtime);
	} catch (cause) {
		throw descriptorDiscoveryError(cause);
	}
	let token: string;
	try {
		token = await readRuntimeTokenFile(paths.controlToken);
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) {
			throw new RuntimeDiscoveryError(
				"RUNTIME_FILES_INCONSISTENT",
				"The active runtime descriptor exists without its fixed control-token file.",
				cause,
			);
		}
		throw new RuntimeDiscoveryError(
			"RUNTIME_TOKEN_MALFORMED",
			"The active runtime control-token file is malformed.",
			cause,
		);
	}
	let secondDescriptor: RuntimeDescriptor;
	try {
		secondDescriptor = await readRuntimeDescriptorFile(paths.runtime);
	} catch (cause) {
		throw new RuntimeDiscoveryError(
			"RUNTIME_FILES_INCONSISTENT",
			"The active runtime descriptor changed while it was being discovered.",
			cause,
		);
	}
	if (!sameDescriptor(firstDescriptor, secondDescriptor)) {
		throw new RuntimeDiscoveryError(
			"RUNTIME_FILES_INCONSISTENT",
			"The active runtime descriptor changed while it was being discovered.",
		);
	}
	return Object.freeze({ descriptor: firstDescriptor, token });
}

export async function discoverActiveRuntime(
	storageRoot: string,
	options: ActiveRuntimeDiscoveryOptions = {},
): Promise<DiscoveredActiveRuntime> {
	const ownedOptions = ownDiscoveryOptions(options);
	const first = await discoverRuntimeFiles(storageRoot);
	let alive: boolean;
	try {
		alive = await ownedOptions.processIsAlive(first.descriptor.pid);
	} catch (cause) {
		throw new RuntimeDiscoveryError(
			"RUNTIME_PROCESS_CHECK_FAILED",
			"Could not verify the process named by the active runtime descriptor.",
			cause,
		);
	}
	if (!alive) {
		throw new RuntimeDiscoveryError(
			"RUNTIME_PROCESS_STALE",
			`The active runtime descriptor refers to process ${first.descriptor.pid}, which is not running.`,
		);
	}
	const client = connectRuntime({
		fetch: ownedOptions.fetch,
		responseBodyLimitBytes: ownedOptions.responseBodyLimitBytes,
		token: first.token,
		url: first.descriptor.url,
	});
	const healthSignal = AbortSignal.timeout(ownedOptions.healthTimeoutMs);
	try {
		assertHealth(await client.health({ signal: healthSignal }));
		await client.listInstances({ signal: healthSignal });
	} catch (cause) {
		if (
			cause instanceof ControlApiError ||
			cause instanceof ControlProtocolError ||
			cause instanceof ControlTransportError
		) {
			throw new RuntimeDiscoveryError(
				"RUNTIME_HEALTH_FAILED",
				"The described runtime did not pass control protocol and authentication checks.",
				cause,
			);
		}
		throw cause;
	}
	const second = await discoverRuntimeFiles(storageRoot);
	if (!sameDescriptor(first.descriptor, second.descriptor) || first.token !== second.token) {
		throw new RuntimeDiscoveryError(
			"RUNTIME_FILES_INCONSISTENT",
			"The active runtime files changed while runtime health was being checked.",
		);
	}
	return Object.freeze({ client, descriptor: first.descriptor, token: first.token });
}

interface OwnedDiscoveryOptions {
	readonly fetch: typeof globalThis.fetch;
	readonly healthTimeoutMs: number;
	readonly processIsAlive: (pid: number) => boolean | Promise<boolean>;
	readonly responseBodyLimitBytes: number;
}

function ownDiscoveryOptions(value: unknown): OwnedDiscoveryOptions {
	if (!isPlainRecord(value)) {
		throw new TypeError("Runtime discovery options must be a plain object.");
	}
	for (const key of Reflect.ownKeys(value)) {
		if (
			typeof key !== "string" ||
			!["fetch", "healthTimeoutMs", "processIsAlive", "responseBodyLimitBytes"].includes(key)
		) {
			throw new TypeError(`Runtime discovery options contain unknown field ${String(key)}.`);
		}
	}
	const rawFetch = optionalDataProperty(value, "fetch");
	const rawHealthTimeout = optionalDataProperty(value, "healthTimeoutMs");
	const rawProbe = optionalDataProperty(value, "processIsAlive");
	const rawLimit = optionalDataProperty(value, "responseBodyLimitBytes");
	if (rawFetch !== undefined && typeof rawFetch !== "function") {
		throw new TypeError("Runtime discovery fetch must be a function.");
	}
	if (rawProbe !== undefined && typeof rawProbe !== "function") {
		throw new TypeError("Runtime discovery processIsAlive must be a function.");
	}
	const healthTimeoutMs = rawHealthTimeout ?? HEALTH_TIMEOUT_MS;
	if (!Number.isSafeInteger(healthTimeoutMs) || Number(healthTimeoutMs) < 1) {
		throw new TypeError("Runtime discovery healthTimeoutMs must be a positive safe integer.");
	}
	const responseBodyLimitBytes = rawLimit ?? 1024 * 1024;
	if (!Number.isSafeInteger(responseBodyLimitBytes) || Number(responseBodyLimitBytes) < 1) {
		throw new TypeError("Runtime discovery response body limit must be a positive safe integer.");
	}
	return Object.freeze({
		fetch: (rawFetch ?? globalThis.fetch) as typeof globalThis.fetch,
		healthTimeoutMs: Number(healthTimeoutMs),
		processIsAlive: (rawProbe ?? nodeProcessIsAlive) as (pid: number) => boolean | Promise<boolean>,
		responseBodyLimitBytes: Number(responseBodyLimitBytes),
	});
}

function assertHealth(value: ControlJsonValue): void {
	if (!isJsonObject(value)) {
		throw new ControlProtocolError("Control health data must be an object.");
	}
	const keys = Object.keys(value);
	if (
		keys.length !== 2 ||
		!Object.hasOwn(value, "status") ||
		!Object.hasOwn(value, "version") ||
		value.status !== "ok" ||
		value.version !== "v1"
	) {
		throw new ControlProtocolError("Control health data does not match protocol v1.");
	}
}

function nodeProcessIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		if (hasCode(cause, "ESRCH") || hasCode(cause, "ERR_OUT_OF_RANGE")) return false;
		if (hasCode(cause, "EPERM")) return true;
		throw cause;
	}
}

function descriptorDiscoveryError(cause: unknown): RuntimeDiscoveryError {
	if (hasCode(cause, "ENOENT")) {
		return new RuntimeDiscoveryError(
			"RUNTIME_NOT_FOUND",
			"No active localhost2137 runtime descriptor exists in this storage root.",
			cause,
		);
	}
	if (
		cause instanceof RuntimeDescriptorValidationError &&
		(cause.code === "UNSUPPORTED_PROTOCOL_VERSION" || cause.code === "UNSUPPORTED_SCHEMA_VERSION")
	) {
		return new RuntimeDiscoveryError(
			"RUNTIME_PROTOCOL_UNSUPPORTED",
			"The active runtime descriptor uses an unsupported schema or control protocol version.",
			cause,
		);
	}
	return new RuntimeDiscoveryError(
		"RUNTIME_DESCRIPTOR_MALFORMED",
		"The active runtime descriptor is malformed.",
		cause,
	);
}

function sameDescriptor(left: RuntimeDescriptor, right: RuntimeDescriptor): boolean {
	return (
		left.configFingerprint === right.configFingerprint &&
		left.ownerId === right.ownerId &&
		left.pid === right.pid &&
		left.protocolVersion === right.protocolVersion &&
		left.schemaVersion === right.schemaVersion &&
		left.startedAt === right.startedAt &&
		left.url === right.url
	);
}

function fixedPaths(storageRoot: string): StoragePaths {
	if (typeof storageRoot !== "string" || storageRoot.trim() === "") {
		throw new TypeError("Runtime discovery storage root must be a non-empty string.");
	}
	return storagePaths(storageRoot);
}

function optionalDataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor) || !descriptor.enumerable) {
		throw new TypeError(`Runtime discovery option ${key} must be a data property.`);
	}
	return descriptor.value;
}

function isJsonObject(
	value: ControlJsonValue,
): value is Readonly<Record<string, ControlJsonValue>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
