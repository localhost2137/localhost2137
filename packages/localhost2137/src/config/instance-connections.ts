import { type JsonObject, ownJsonValue } from "../authoring/json-value.js";
import type { ResolvedConfig } from "./config-resolution.js";

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;

export type ConnectionResolutionErrorCode =
	| "CONNECTION_CALLBACK_FAILED"
	| "CONNECTION_ENV_COLLISION"
	| "CONNECTION_INVALID_ENV_NAME"
	| "CONNECTION_INVALID_ENV_VALUE"
	| "CONNECTION_INVALID_RESULT"
	| "CONNECTION_INVALID_VALUES";

export class ConnectionResolutionError extends Error {
	declare readonly cause?: unknown;
	readonly code: ConnectionResolutionErrorCode;
	readonly environmentName?: string;
	readonly firstOwner?: string;
	readonly serviceKey: string;

	constructor(
		code: ConnectionResolutionErrorCode,
		message: string,
		details: Readonly<{
			cause?: unknown;
			environmentName?: string;
			firstOwner?: string;
			serviceKey: string;
		}>,
	) {
		super(message);
		this.name = "ConnectionResolutionError";
		this.code = code;
		this.serviceKey = details.serviceKey;
		if (details.environmentName !== undefined) {
			this.environmentName = details.environmentName;
		}
		if (details.firstOwner !== undefined) this.firstOwner = details.firstOwner;
		if (details.cause !== undefined) {
			Object.defineProperty(this, "cause", {
				configurable: false,
				enumerable: false,
				value: details.cause,
				writable: false,
			});
		}
	}
}

interface ResolvedServiceConnection {
	readonly env: Readonly<Record<string, string>>;
	readonly values: JsonObject;
}

export interface ResolvedInstanceConnections {
	readonly env: Readonly<Record<string, string>>;
	readonly services: Readonly<Record<string, ResolvedServiceConnection>>;
}

/** Evaluates connection callbacks for one actual instance and bound runtime URL. */
export function resolveInstanceConnections(
	config: ResolvedConfig,
	input: Readonly<{ baseUrl: string; instanceId: string }>,
): ResolvedInstanceConnections {
	const environmentOwners = new Map<string, string>();
	const environment: Record<string, string> = Object.create(null);
	const services: Record<string, ResolvedServiceConnection> = Object.create(null);

	for (const [serviceKey, service] of Object.entries(config.services)) {
		const connection = service.plugin.connection;
		if (typeof connection !== "function") {
			throw new ConnectionResolutionError(
				"CONNECTION_INVALID_RESULT",
				`Validated connection metadata for service "${serviceKey}" is not callable.`,
				{ serviceKey },
			);
		}
		let raw: unknown;
		try {
			raw = Reflect.apply(connection, undefined, [
				Object.freeze({
					baseUrl: input.baseUrl,
					config: service.config,
					instanceId: input.instanceId,
					serviceKey,
				}),
			]);
		} catch (cause) {
			throw new ConnectionResolutionError(
				"CONNECTION_CALLBACK_FAILED",
				`Connection metadata for service "${serviceKey}" could not be computed.`,
				{ cause, serviceKey },
			);
		}

		const owned = ownConnectionResult(raw, serviceKey);
		defineEntry(services, serviceKey, owned);
		if (!service.exportEnv) continue;
		for (const [name, value] of Object.entries(owned.env)) {
			const firstOwner = environmentOwners.get(name);
			if (firstOwner !== undefined) {
				throw new ConnectionResolutionError(
					"CONNECTION_ENV_COLLISION",
					`Services "${firstOwner}" and "${serviceKey}" both export "${name}"; set exportEnv: false on one mount and wire it manually.`,
					{ environmentName: name, firstOwner, serviceKey },
				);
			}
			environmentOwners.set(name, serviceKey);
			defineEntry(environment, name, value);
		}
	}

	return Object.freeze({
		env: Object.freeze(environment),
		services: Object.freeze(services),
	});
}

function ownConnectionResult(raw: unknown, serviceKey: string): ResolvedServiceConnection {
	if (!isPlainRecord(raw) || !hasExactDataProperties(raw, ["env", "values"])) {
		throw new ConnectionResolutionError(
			"CONNECTION_INVALID_RESULT",
			`Connection metadata for service "${serviceKey}" must be an exact plain { values, env } object with data properties.`,
			{ serviceKey },
		);
	}
	const env = ownEnvironment(dataProperty(raw, "env"), serviceKey);
	let values: ReturnType<typeof ownJsonValue>;
	try {
		values = ownJsonValue(dataProperty(raw, "values"));
	} catch (cause) {
		throw new ConnectionResolutionError(
			"CONNECTION_INVALID_VALUES",
			`Connection values for service "${serviceKey}" must be JSON-compatible plain data.`,
			{ cause, serviceKey },
		);
	}
	if (!isJsonObject(values)) {
		throw new ConnectionResolutionError(
			"CONNECTION_INVALID_VALUES",
			`Connection values for service "${serviceKey}" must be an object.`,
			{ serviceKey },
		);
	}
	return Object.freeze({ env, values });
}

function ownEnvironment(raw: unknown, serviceKey: string): Readonly<Record<string, string>> {
	if (!isPlainRecord(raw)) {
		throw new ConnectionResolutionError(
			"CONNECTION_INVALID_RESULT",
			`Connection env for service "${serviceKey}" must be a plain object.`,
			{ serviceKey },
		);
	}
	const result: Record<string, string> = Object.create(null);
	for (const key of Reflect.ownKeys(raw)) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
			throw new ConnectionResolutionError(
				"CONNECTION_INVALID_RESULT",
				`Connection env for service "${serviceKey}" must contain enumerable string data properties only.`,
				{ serviceKey },
			);
		}
		if (!ENVIRONMENT_NAME.test(key)) {
			throw new ConnectionResolutionError(
				"CONNECTION_INVALID_ENV_NAME",
				`Service "${serviceKey}" exports invalid environment name "${key}".`,
				{ environmentName: key, serviceKey },
			);
		}
		if (typeof descriptor.value !== "string") {
			throw new ConnectionResolutionError(
				"CONNECTION_INVALID_ENV_VALUE",
				`Service "${serviceKey}" environment value "${key}" must be a string.`,
				{ environmentName: key, serviceKey },
			);
		}
		if (descriptor.value.includes("\0")) {
			throw new ConnectionResolutionError(
				"CONNECTION_INVALID_ENV_VALUE",
				`Service "${serviceKey}" environment value "${key}" must not contain NUL bytes.`,
				{ environmentName: key, serviceKey },
			);
		}
		defineEntry(result, key, descriptor.value);
	}
	return Object.freeze(result);
}

function hasExactDataProperties(
	value: Readonly<Record<string, unknown>>,
	names: readonly string[],
): boolean {
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === names.length &&
		names.every((name) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

function dataProperty(value: Readonly<Record<string, unknown>>, name: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function defineEntry(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
